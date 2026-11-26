//! Terminal multiplexer sessions: tmux, zellij, screen, herdr and Rex, in one list.
//! Every adapter returns sessions in the same shape; shared details (agents, ports,
//! branch, idle) are filled in afterwards from the process table.
//!
//! Output formats are taken from each tool's source or checked live:
//!   tmux 3.7c    list-sessions/list-panes -F, "=name" exact targets   (checked live)
//!   screen 4.00  "-ls" rows "\t<pid>.<name>\t(Detached)", exits 1      (checked live)
//!   Rex          "ls --json", "block ls --json", AppleScript show      (checked live)
//!   zellij       sessions.rs print_sessions, --no-formatting           (source, v0.46)
//!   herdr        session.rs SessionInfo, api/schema/panes.rs PaneInfo  (source, v0.9.5)
//!   herdr-core   `hc ls --json`, `hc get <t> --json`                   (checked live)
use crate::detect::{agent_of, git_branch, github_url};
use crate::sources::TermSpec;
use crate::state::Ctx;
use crate::util::{find_bin, now_ms, run, secs, ApiErr, ApiResult, Get, Out};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mux { Tmux, Zellij, Screen, Herdr, Rex }
const MUXES: [Mux; 5] = [Mux::Tmux, Mux::Zellij, Mux::Screen, Mux::Herdr, Mux::Rex];

impl Mux {
    fn key(self) -> &'static str {
        match self { Mux::Tmux => "tmux", Mux::Zellij => "zellij", Mux::Screen => "screen", Mux::Herdr => "herdr", Mux::Rex => "rex" }
    }
    fn label(self) -> &'static str {
        match self { Mux::Tmux => "tmux", Mux::Zellij => "Zellij", Mux::Screen => "screen", Mux::Herdr => if core() { "Herdr" } else { "herdr" }, Mux::Rex => "Rex" }
    }
    fn bin(self) -> Option<String> {
        match self {
            Mux::Herdr => find_bin("herdr").or_else(|| find_bin("hc")),
            Mux::Rex => find_bin("rex").or_else(|| {
                let p = crate::util::home().join("Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex");
                p.exists().then(|| p.to_string_lossy().into_owned())
            }),
            m => find_bin(m.key()),
        }
    }
    fn can_attach(self) -> bool { self != Mux::Rex }
    fn can_kill(self) -> bool { self != Mux::Rex }
    fn can_rename(self) -> bool { self == Mux::Tmux }
    fn can_show(self) -> bool { self == Mux::Rex }
}

/// The Herdr desktop app ships herdr-core, `hc`, instead of the herdr TUI
fn core() -> bool { find_bin("herdr").is_none() && find_bin("hc").is_some() }

/// One session as an adapter reads it; enrich() adds the shared details
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Raw {
    pub mux: Option<Mux>,
    pub id: String,
    pub name: String,
    pub state: String,
    pub attached: Option<bool>,
    pub created_at: Option<i64>,
    pub last_active: Option<i64>,
    pub windows: Option<usize>,
    pub panes: Option<usize>,
    pub cwd: Option<String>,
    pub root_pids: Vec<i32>,
    pub targets: Vec<String>,
    /// set when the multiplexer itself knows its agents (herdr)
    pub agents: Option<Vec<String>>,
    pub agent_status: Option<String>,
}

/// A session from the latest scan: what actions accept, and what coding.rs reads
#[derive(Debug, Clone)]
pub struct Session { pub raw: Raw, pub public: Value }

#[derive(Default)]
pub struct Sessions {
    last: Mutex<Vec<Session>>,
    /// herdr-core terminal -> (shell pid, created): neither changes, so asked once
    hc_fixed: Mutex<HashMap<String, (Option<i32>, Option<i64>)>>,
}

fn lines(s: &str) -> impl Iterator<Item = &str> { s.split('\n').filter(|l| !l.is_empty()) }
fn json_of(o: &Out) -> Option<Value> { if o.code == 0 { serde_json::from_str(&o.stdout).ok() } else { None } }

const STATE_RANK: fn(&str) -> u8 = |s| match s { "needs-you" => 3, "working" => 2, "idle" => 1, _ => 0 };
fn status_rank(s: &str) -> Option<u8> { match s { "blocked" => Some(4), "working" => Some(3), "done" => Some(2), "idle" => Some(1), "unknown" => Some(0), _ => None } }

impl Sessions {
    pub fn last(&self) -> Vec<Session> { self.last.lock().unwrap().clone() }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { return Ok(crate::demo::sessions()); }
        let results = futures_util::future::join_all(MUXES.map(|m| async move {
            let Some(bin) = m.bin() else { return (m, false, None, vec![]) };
            match self.list(m, &bin).await {
                Ok(s) => (m, true, None, s),
                Err(e) => (m, true, Some(e), vec![]),
            }
        })).await;
        let t = c.table();
        let kids = crate::table::children(&t);
        let ports = c.ports();
        let idle_hours = c.settings.get()["idleAfterHours"].as_f64().unwrap_or(0.0);
        let mut last = vec![];
        for (_, _, _, list) in &results {
            for r in list {
                let mut r = r.clone();
                if r.mux == Some(Mux::Screen) { r.created_at = r.root_pids.first().and_then(|p| t.get(p)).and_then(|p| p.started_at); }
                last.push(Session { public: enrich(c, &r, &t, &kids, &ports, idle_hours), raw: r });
            }
        }
        let out = json!({
            "sessions": last.iter().map(|s| s.public.clone()).collect::<Vec<_>>(),
            "muxes": results.iter().map(|(m, available, error, _)| {
                let mut v = json!({ "mux": m.key(), "label": m.label(), "available": available });
                if let Some(e) = error { v["error"] = json!(e); }
                v
            }).collect::<Vec<_>>(),
        });
        *self.last.lock().unwrap() = last;
        Ok(out)
    }

    async fn list(&self, m: Mux, bin: &str) -> Result<Vec<Raw>, String> {
        let mut v = match m {
            Mux::Tmux => tmux_list(bin).await,
            Mux::Zellij => Ok(zellij_parse(&run(bin, &["list-sessions", "--no-formatting"], secs(10)).await.stdout, now_ms())),
            Mux::Screen => Ok(screen_parse(&run(bin, &["-ls"], secs(10)).await.stdout)),
            Mux::Herdr => if bin.ends_with("/hc") { self.hc_list(bin).await } else { herdr_list(bin).await },
            Mux::Rex => rex_list(bin).await,
        }?;
        for r in &mut v { r.mux = Some(m); }
        Ok(v)
    }

    async fn hc_list(&self, bin: &str) -> Result<Vec<Raw>, String> {
        let Some(d) = json_of(&run(bin, &["ls", "--json"], secs(10)).await) else { return Ok(vec![]) }; // core not running
        let list = d["terminals"].as_array().cloned().unwrap_or_default();
        self.hc_fixed.lock().unwrap().retain(|k, _| list.iter().any(|t| t.str_of("address") == k));
        let mut out = vec![];
        for t in list {
            let addr = t.str_of("address").to_string();
            let known = self.hc_fixed.lock().unwrap().get(&addr).copied();
            let (pid, created) = match known {
                Some(x) => x,
                None => {
                    let g = json_of(&run(bin, &["get", &addr, "--json"], secs(10)).await).unwrap_or(json!({}));
                    let x = (g["pid"].as_i64().map(|p| p as i32), g["created_ms"].as_i64());
                    self.hc_fixed.lock().unwrap().insert(addr.clone(), x);
                    x
                }
            };
            out.push(hc_session(&t, pid, created));
        }
        Ok(out)
    }

    /// Only sessions from a scan; the list may be stale if nobody was watching, so rescan once
    async fn find(&self, c: &Ctx, p: &Value) -> ApiResult<Session> {
        let get = || self.last.lock().unwrap().iter().find(|s| s.raw.mux.map(Mux::key) == Some(p.str_of("mux")) && s.raw.id == p.str_of("id")).cloned();
        if get().is_none() { let _ = self.scan(c).await; }
        get().ok_or_else(|| ApiErr::gone("That session is gone"))
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        let s = self.find(c, p).await?;
        let m = s.raw.mux.unwrap();
        let bin = m.bin().ok_or_else(|| ApiErr::gone("That session is gone"))?;
        let id = s.raw.id.as_str();
        let r = match name {
            "kill" => {
                if !m.can_kill() { return Err(ApiErr::bad(format!("{} sessions can't be closed from DevDock", m.label()))); }
                let args: Vec<String> = match m {
                    Mux::Tmux => vec!["kill-session".into(), "-t".into(), format!("={id}")],
                    Mux::Zellij => vec![if s.raw.state == "exited" { "delete-session" } else { "kill-session" }.into(), id.into()],
                    Mux::Screen => vec!["-S".into(), id.into(), "-X".into(), "quit".into()],
                    Mux::Herdr if bin.ends_with("/hc") => vec!["kill".into(), id.into()],
                    Mux::Herdr => vec!["session".into(), if s.raw.state == "running" { "stop" } else { "delete" }.into(), id.into()],
                    Mux::Rex => unreachable!(),
                };
                (run(&bin, &args.iter().map(String::as_str).collect::<Vec<_>>(), secs(10)).await, "Could not close the session")
            }
            "rename" => {
                if !m.can_rename() { return Err(ApiErr::bad(format!("{} sessions can't be renamed from DevDock", m.label()))); }
                // tmux turns . and : into _ (they separate window and pane); say so instead
                let new = p.str_of("name").trim();
                if new.is_empty() || new.chars().count() > 100 || new.contains(['.', ':', '\n']) { return Err(ApiErr::bad("Names need 1 to 100 characters, without . or :")); }
                if self.last.lock().unwrap().iter().any(|x| x.raw.mux == Some(m) && x.raw.id == new) { return Err(ApiErr::new(409, format!("There's already a session called {new}"))); }
                (run(&bin, &["rename-session", "-t", &format!("={id}"), new], secs(10)).await, "Could not rename the session")
            }
            "show" => {
                if !m.can_show() { return Err(ApiErr::bad("Not supported")); }
                // the scripting id is "<server uuid>/session:<uuid>"; match on the suffix
                (run("/usr/bin/osascript", &["-e", "on run argv",
                    "-e", "tell application id \"com.superlogical.rex\" to show (first session whose id ends with (\"/\" & item 1 of argv))",
                    "-e", "end run", id], secs(10)).await, "Could not open the session")
            }
            _ => return Err(crate::sources::unknown()),
        };
        let (out, fallback) = r;
        if out.code != 0 {
            let msg = if name == "show" { out.stderr.trim().to_string() } else { [out.stderr.trim(), out.stdout.trim()].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string() };
            return Err(ApiErr::new(500, if msg.is_empty() { fallback.to_string() } else { msg }));
        }
        Ok(json!({}))
    }

    /// The attach command for the in-app terminal (or Terminal.app)
    pub async fn terminal(&self, c: &Ctx, p: &Value) -> Option<TermSpec> {
        let s = self.find(c, p).await.ok()?;
        let m = s.raw.mux?;
        if !m.can_attach() { return None; }
        let bin = m.bin()?;
        Some(TermSpec { args: attach_args(m, &bin, &s.raw, p.str_of("target")), file: bin, ..Default::default() })
    }
}

fn attach_args(m: Mux, bin: &str, s: &Raw, target: &str) -> Vec<String> {
    let id = s.id.clone();
    match m {
        // target: "window.pane" inside this session, only if it exists
        Mux::Tmux => {
            let mut a = vec!["attach-session".into(), "-t".into(), format!("={id}")];
            if s.targets.iter().any(|t| t == target) {
                a.extend([";".into(), "select-window".into(), "-t".into(), format!("={id}:{target}"), ";".into(), "select-pane".into(), "-t".into(), format!("={id}:{target}")]);
            }
            a
        }
        Mux::Zellij => vec!["attach".into(), id], // also resurrects an exited session
        Mux::Screen => vec!["-x".into(), id],     // -x joins even if attached elsewhere
        Mux::Herdr if bin.ends_with("/hc") => vec!["attach".into(), id],
        Mux::Herdr => vec!["session".into(), "attach".into(), id], // starts a stopped session
        Mux::Rex => vec![],
    }
}

/// Agents, ports and branch come from the processes under the session's panes
fn enrich(c: &Ctx, s: &Raw, t: &crate::table::Table, kids: &HashMap<i32, Vec<i32>>, ports: &[Value], idle_hours: f64) -> Value {
    let m = s.mux.unwrap();
    let tree: HashSet<i32> = s.root_pids.iter().flat_map(|p| crate::table::tree(*p, kids)).collect();
    let agent_pids = || tree.iter().filter_map(|pid| t.get(pid).and_then(|p| agent_of(&p.comm)).map(|a| (*pid, a)));
    let agents: Vec<String> = s.agents.clone().unwrap_or_else(|| {
        let mut v: Vec<String> = vec![];
        let mut pids: Vec<_> = agent_pids().collect();
        pids.sort();
        for (_, a) in pids { if !v.iter().any(|x| x == a) { v.push(a.to_string()); } }
        v
    });
    // the most urgent Claude Code in it decides; the multiplexer's own status when there's none
    let mut states: Vec<Value> = agent_pids().filter(|(_, a)| *a == "Claude Code").map(|(pid, _)| c.claude.state(pid)).filter(|v| v["status"].is_string()).collect();
    states.sort_by_key(|v| std::cmp::Reverse(STATE_RANK(v.str_of("status"))));
    let agent_state = states.into_iter().next().or_else(|| {
        let st = match s.agent_status.as_deref()? { "blocked" => "needs-you", "working" => "working", "done" | "idle" => "idle", _ => return None };
        Some(json!({ "status": st, "since": null }))
    });
    let cwd = s.cwd.clone().or_else(|| s.root_pids.first().and_then(|p| crate::procs::cwd(*p)).map(|p| p.to_string_lossy().into_owned()));
    let mut ps: Vec<u64> = ports.iter().filter(|p| p.str_of("pid").parse::<i32>().is_ok_and(|pid| tree.contains(&pid))).filter_map(|p| p["port"].as_u64()).collect();
    ps.sort();
    ps.dedup();
    let quiet = s.last_active.map(|a| now_ms() - a);
    // nobody attached and no output for the idle threshold
    let idle = s.state == "running" && s.attached == Some(false) && idle_hours > 0.0 && quiet.is_some_and(|q| q as f64 >= idle_hours * 3_600_000.0);
    let mut v = json!({
        "mux": m.key(), "id": s.id, "name": s.name, "state": s.state, "attached": s.attached, "createdAt": s.created_at,
        "key": format!("{}:{}", m.key(), s.id), "cwd": cwd,
        "branch": cwd.as_deref().and_then(git_branch), "github": cwd.as_deref().and_then(github_url),
        "agents": agents, "agentState": agent_state, "ports": ps, "idle": idle,
        "canOpen": m.can_attach(), "canShow": m.can_show(), "canKill": m.can_kill(), "canRename": m.can_rename(),
    });
    // fields an adapter doesn't know stay out, as in the JS
    if let Some(x) = s.last_active { v["lastActive"] = json!(x); }
    if let Some(x) = s.windows { v["windows"] = json!(x); }
    if let Some(x) = s.panes { v["panes"] = json!(x); }
    if let Some(x) = &s.agent_status { v["agentStatus"] = json!(x); } else if m == Mux::Herdr { v["agentStatus"] = Value::Null; }
    v
}

// ── tmux ─────────────────────────────────────────────────────────────
// Targets use "=name": a bare name also matches other sessions by prefix.
// Fields are tab-separated because session names may contain spaces.
async fn tmux_list(bin: &str) -> Result<Vec<Raw>, String> {
    let s = run(bin, &["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{session_windows}"], secs(10)).await;
    if s.code != 0 { return Ok(vec![]); } // no tmux server running
    let p = run(bin, &["list-panes", "-a", "-F", "#{session_name}\t#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_path}\t#{window_active}\t#{pane_active}"], secs(10)).await;
    Ok(tmux_parse(&s.stdout, &p.stdout))
}

pub fn tmux_parse(sessions: &str, panes: &str) -> Vec<Raw> {
    let mut by: HashMap<&str, Vec<(&str, i32, &str, bool)>> = HashMap::new();
    for l in lines(panes) {
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() < 6 { continue; }
        by.entry(f[0]).or_default().push((f[1], f[2].parse().unwrap_or(0), f[3], f[4] == "1" && f[5] == "1"));
    }
    lines(sessions).filter_map(|l| {
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() < 5 { return None; }
        let list = by.get(f[0]).cloned().unwrap_or_default();
        let n = |s: &str| s.parse::<i64>().unwrap_or(0);
        Some(Raw {
            id: f[0].into(), name: f[0].into(), state: "running".into(),
            attached: Some(n(f[3]) > 0),
            created_at: Some(n(f[1]) * 1000),
            last_active: Some(n(f[2]) * 1000), // last output in any pane
            windows: Some(n(f[4]) as usize), panes: Some(list.len()),
            cwd: list.iter().find(|x| x.3).or(list.first()).map(|x| x.2.to_string()).filter(|c| !c.is_empty()),
            root_pids: list.iter().map(|x| x.1).filter(|p| *p > 0).collect(),
            targets: list.iter().map(|x| x.0.to_string()).collect(),
            ..Default::default()
        })
    }).collect()
}

// ── zellij ───────────────────────────────────────────────────────────
// "<name> [Created <humantime> ago] <suffix>", suffix "(current)", "(EXITED - attach to
// resurrect)" or empty. No sessions: exit 1, message on stderr. No pids are exposed.
pub fn zellij_parse(out: &str, now: i64) -> Vec<Raw> {
    lines(out).filter_map(|l| {
        let (name, rest) = l.split_once(" [Created ")?;
        let (age, suffix) = rest.split_once(" ago]")?;
        let age = humantime_ms(age);
        Some(Raw {
            id: name.into(), name: name.into(),
            state: if suffix.contains("EXITED") { "exited" } else { "running" }.into(),
            // rounded so the value doesn't drift between scans
            created_at: age.map(|a| ((now as f64 - a) / 60000.0).round() as i64 * 60000),
            ..Default::default()
        })
    }).collect()
}

/// humantime's format_duration: "1year 2months 3days 4h 5m 6s 7ms" (units from its source)
pub fn humantime_ms(text: &str) -> Option<f64> {
    let unit = |u: &str| -> Option<f64> {
        Some(match u { "year" => 31557600000.0, "month" => 2630016000.0, "day" => 86400000.0, "h" => 3600000.0, "m" => 60000.0, "s" => 1000.0, "ms" => 1.0, "us" => 0.001, "ns" => 0.000001, _ => return None })
    };
    let (mut total, mut matched) = (0.0, 0);
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() { i += 1; continue; }
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() { i += 1; }
        let n: f64 = text[s..i].parse().ok()?;
        let u0 = i;
        while i < b.len() && b[i].is_ascii_lowercase() { i += 1; }
        if u0 == i { continue; }
        let u = &text[u0..i];
        // exact unit first: stripping the plural s would turn ms into m
        let ms = unit(u).or_else(|| unit(u.strip_suffix('s')?))?;
        total += n * ms;
        matched += 1;
    }
    (matched > 0).then_some(total)
}

// ── GNU screen ───────────────────────────────────────────────────────
// Rows: "\t<pid>.<name>\t[(<date>)\t](Attached|Detached)". Exits 1 even with sessions.
pub fn screen_parse(out: &str) -> Vec<Raw> {
    lines(out).filter(|l| l.starts_with('\t')).filter_map(|l| {
        let parts: Vec<&str> = l.split('\t').filter(|x| !x.is_empty()).collect();
        let (pid, name) = parts.first()?.split_once('.')?;
        let pid: i32 = pid.parse().ok().filter(|_| pid.bytes().all(|b| b.is_ascii_digit()))?;
        if name.is_empty() { return None; }
        Some(Raw {
            id: parts[0].into(), name: name.into(), state: "running".into(),
            attached: Some(parts.last()?.to_lowercase().contains("attached")),
            root_pids: vec![pid],
            ..Default::default()
        })
    }).collect()
}

// ── herdr ────────────────────────────────────────────────────────────
// session list --json: {"sessions":[{name, default, running, connection_error?, socket_path, session_dir}]}
// pane list (always JSON): response envelope holding PaneInfo records
//   {pane_id, tab_id, focused, cwd?, foreground_cwd?, agent?, display_agent?, agent_status}
// Not verified against a running herdr TUI (only herdr-core is installed here).
async fn herdr_list(bin: &str) -> Result<Vec<Raw>, String> {
    let r = run(bin, &["session", "list", "--json"], secs(10)).await;
    if r.code != 0 { return Ok(vec![]); }
    let d: Value = serde_json::from_str(&r.stdout).map_err(|e| e.to_string())?;
    let mut out = vec![];
    // the default session always appears; when it isn't running it's not a session yet
    for s in d["sessions"].as_array().cloned().unwrap_or_default().iter().filter(|s| s.bool_of("running") || !s.bool_of("default")) {
        let name = s.str_of("name");
        let panes = if s.bool_of("running") { json_of(&run(bin, &["--session", name, "pane", "list"], secs(10)).await).map(|v| find_panes(&v)) } else { None };
        out.push(herdr_session(s, panes.as_deref()));
    }
    Ok(out)
}

pub fn herdr_session(s: &Value, panes: Option<&[Value]>) -> Raw {
    let running = s.bool_of("running");
    let mut r = Raw { id: s.str_of("name").into(), name: s.str_of("name").into(), state: if running { "running" } else { "stopped" }.into(), ..Default::default() };
    if !running { return r; }
    let panes = panes.unwrap_or(&[]);
    let focused = panes.iter().find(|x| x.bool_of("focused")).or(panes.first());
    let mut tabs: Vec<String> = panes.iter().map(|x| x["tab_id"].to_string()).collect();
    tabs.sort();
    tabs.dedup();
    let mut agents: Vec<String> = vec![];
    for p in panes {
        let a = [p.str_of("display_agent"), p.str_of("agent")].into_iter().find(|x| !x.is_empty());
        if let Some(a) = a { if !agents.iter().any(|x| x == a) { agents.push(a.into()); } }
    }
    r.panes = Some(panes.len());
    r.windows = Some(tabs.len());
    r.cwd = focused.and_then(|f| [f.str_of("foreground_cwd"), f.str_of("cwd")].into_iter().find(|x| !x.is_empty())).map(String::from);
    r.agents = Some(agents);
    // the most urgent pane decides: blocked > working > done > idle
    r.agent_status = panes.iter().map(|x| x.str_of("agent_status")).filter(|s| status_rank(s).is_some()).max_by_key(|s| status_rank(s)).map(String::from);
    r
}

/// The pane array's key inside the envelope isn't documented: take the array of pane records
pub fn find_panes(node: &Value) -> Vec<Value> {
    match node {
        Value::Array(a) if a.iter().all(|x| x.get("pane_id").is_some()) => a.clone(),
        Value::Array(a) => a.iter().flat_map(find_panes).collect(),
        Value::Object(o) => o.values().map(find_panes).find(|f| !f.is_empty()).unwrap_or_default(),
        _ => vec![],
    }
}

// herdr-core: ls --json {"terminals":[{address, agent, cwd, state, status, turn, where: "Space / tab"}]}
pub fn hc_session(t: &Value, pid: Option<i32>, created: Option<i64>) -> Raw {
    let addr = t.str_of("address");
    let agent = t["agent"].as_str().filter(|a| !a.is_empty()).map(|a| agent_of(a.strip_suffix("-code").unwrap_or(a)).map(String::from).unwrap_or_else(|| a.to_string()));
    let st = t.str_of("state");
    let status = t.str_of("status");
    Raw {
        id: addr.into(), name: [t.str_of("where"), addr].into_iter().find(|x| !x.is_empty()).unwrap_or("").into(),
        state: if st == "live" { "running".into() } else { st.into() },
        created_at: created, cwd: t["cwd"].as_str().filter(|x| !x.is_empty()).map(String::from),
        root_pids: pid.into_iter().collect(),
        agents: agent.map(|a| vec![a]),
        agent_status: status_rank(status).map(|_| status.to_string()),
        ..Default::default()
    }
}

// ── Rex ──────────────────────────────────────────────────────────────
// No attach: Rex is its own terminal app, so sessions open there. --autostart=false
// keeps DevDock from starting Rex's server just by looking.
async fn rex_list(bin: &str) -> Result<Vec<Raw>, String> {
    let Some(d) = json_of(&run(bin, &["ls", "--json", "--autostart=false"], secs(10)).await) else { return Ok(vec![]) }; // Rex isn't running
    let mut out = vec![];
    for s in d["sessions"].as_array().cloned().unwrap_or_default() {
        let id = s.str_of("session_id");
        let blocks = json_of(&run(bin, &["block", "ls", "-s", id, "--json", "--autostart=false"], secs(10)).await)
            .and_then(|b| b["blocks"].as_array().cloned()).unwrap_or_default();
        let mut w: Vec<String> = blocks.iter().map(|b| b["window_id"].to_string()).collect();
        w.sort();
        w.dedup();
        out.push(Raw { id: id.into(), name: s.str_of("label").into(), state: "running".into(), windows: Some(w.len()), panes: Some(blocks.len()), ..Default::default() });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn humantime() {
        assert_eq!(humantime_ms("2h 3m 5s"), Some((2 * 3600000 + 3 * 60000 + 5000) as f64));
        assert_eq!(humantime_ms("1day 4h"), Some((86400000 + 4 * 3600000) as f64));
        assert_eq!(humantime_ms("3months"), Some(3.0 * 2630016000.0));
        assert_eq!(humantime_ms("soon"), None);
        assert_eq!(humantime_ms("5ms"), Some(5.0));
    }
    #[test]
    fn panes_in_any_envelope() {
        assert_eq!(find_panes(&json!({ "id": "r", "result": { "type": "pane_list", "panes": [{ "pane_id": "w1:p1" }] } })), vec![json!({ "pane_id": "w1:p1" })]);
        assert_eq!(find_panes(&json!({ "result": { "workspaces": [] } })), Vec::<Value>::new());
    }
    #[test]
    fn parses_each_tool() {
        let t = tmux_parse("api\t1700000000\t1700000100\t0\t2\nweb x\t1700000000\t1700000000\t1\t1\n",
            "api\t0.0\t101\t/a\t1\t0\napi\t1.0\t102\t/b\t1\t1\nweb x\t0.0\t103\t/c\t1\t1\n");
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].cwd.as_deref(), t[0].root_pids.clone(), t[0].attached, t[0].panes), (Some("/b"), vec![101, 102], Some(false), Some(2)));
        assert_eq!((t[1].name.as_str(), t[1].attached, t[1].created_at), ("web x", Some(true), Some(1700000000000)));

        let z = zellij_parse("main [Created 2h 3m ago] (current)\nold [Created 1day ago] (EXITED - attach to resurrect)\nnoise\n", 1_000_000_000_000);
        assert_eq!(z.iter().map(|x| (x.name.as_str(), x.state.as_str())).collect::<Vec<_>>(), [("main", "running"), ("old", "exited")]);
        assert_eq!(z[0].created_at.unwrap() % 60000, 0);

        let s = screen_parse("There are screens on:\n\t4242.dev\t(Detached)\n\t77.a.b\t(11/26/2026 10:00:00 AM)\t(Attached)\n2 Sockets in /tmp.\n");
        assert_eq!(s.iter().map(|x| (x.id.as_str(), x.name.as_str(), x.attached)).collect::<Vec<_>>(), [("4242.dev", "dev", Some(false)), ("77.a.b", "a.b", Some(true))]);

        let h = herdr_session(&json!({ "name": "w", "running": true }), Some(&[
            json!({ "pane_id": "1", "tab_id": 1, "cwd": "/x", "agent": "claude", "agent_status": "working" }),
            json!({ "pane_id": "2", "tab_id": 2, "focused": true, "foreground_cwd": "/y", "display_agent": "Codex", "agent_status": "blocked" }),
        ]));
        assert_eq!((h.cwd.as_deref(), h.windows, h.agent_status.as_deref(), h.agents.clone().unwrap().len()), (Some("/y"), Some(2), Some("blocked"), 2));

        let c = hc_session(&json!({ "address": "t3", "agent": "claude-code", "where": "store / pay", "state": "live", "status": "blocked" }), Some(9), Some(5));
        assert_eq!((c.name.as_str(), c.state.as_str(), c.agents.clone(), c.root_pids.clone()), ("store / pay", "running", Some(vec!["Claude Code".to_string()]), vec![9]));
    }
    #[test]
    fn tmux_attach_picks_a_pane_only_if_it_exists() {
        let s = Raw { id: "api".into(), targets: vec!["1.0".into()], ..Default::default() };
        assert_eq!(attach_args(Mux::Tmux, "tmux", &s, "1.0").len(), 11);
        assert_eq!(attach_args(Mux::Tmux, "tmux", &s, "9.9; kill-server"), ["attach-session", "-t", "=api"]);
    }
}

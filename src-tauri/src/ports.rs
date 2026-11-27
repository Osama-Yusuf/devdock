//! Ports: every TCP listener on this Mac with what it is, where it runs and who started it.
//! One kernel pass per scan (process table + each process's sockets); nothing is spawned but
//! `tmux list-panes`, and `<runtime> --version` once per binary.
//!
//! Up:   a listener must be seen in 2 scans (>=1s apart) before it is shown.
//! Down: hidden at once if its process is gone; if the process is alive but
//!       stopped listening, only after 2 misses in a row.
use crate::detect::{agent_of, app_from_path, git_branch, github_url};
use crate::settings::{identify_runtime, runtime, Settings};
use crate::table::{Proc, Table};
use crate::util::{basename, find_bin, now_ms, run, secs};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// A process counts as active when it burned more than 2% CPU between two readings.
/// ponytail: first sighting seeds from the lifetime average (cpu time / age), so a server that
/// was busy yesterday but averaged under 2% looks idle since start. Upgrade: persist samples.
const ACTIVE_RATE: f64 = 0.02;

struct Activity { cpu_sec: f64, at: i64, last_active: Option<i64> }

struct Tracked { streak: u32, missing: u32, entry: Value }

#[derive(Default)]
struct Tracking {
    tracked: HashMap<(i32, u16), Tracked>,
    order: Vec<(i32, u16)>, // first-seen order, so the list doesn't shuffle
    transient: Vec<Value>,
    scanned: bool,
}

#[derive(Default)]
pub struct Scanner {
    activity: Mutex<HashMap<i32, Activity>>,
    tracking: Mutex<Tracking>,
    versions: Mutex<HashMap<String, Option<String>>>, // exe path -> version; None while asking
    health: Mutex<HashMap<u16, String>>,
    probing: Mutex<HashSet<u16>>,
    users: Mutex<HashMap<u32, String>>,
    history: Mutex<(Vec<String>, i64)>, // the running ports' keys at the last write, and when
}

/// What the scan produced: every listener, and the confirmed ones the page shows
pub struct Snapshot { pub timestamp: String, pub ports: Vec<Value> }

fn user_name(uid: u32) -> String {
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 1024];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let r = unsafe { libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) };
    if r != 0 || out.is_null() { return uid.to_string(); }
    unsafe { std::ffi::CStr::from_ptr(pw.pw_name) }.to_string_lossy().into_owned()
}

const VERSION_FLAGS: &[(&str, &str)] = &[
    ("node", "--version"), ("python", "--version"), ("ruby", "--version"), ("php", "--version"),
    ("java", "-version"), ("dotnet", "--version"), ("postgres", "--version"), ("mysql", "--version"),
    ("redis", "--version"), ("mongo", "--version"), ("nginx", "-v"), ("apache", "-v"),
];

/// The first x.y[.z] in a version banner
pub fn first_version(text: &str) -> Option<String> {
    let b = text.as_bytes();
    for i in 0..b.len() {
        if !b[i].is_ascii_digit() || (i > 0 && b[i - 1].is_ascii_digit()) { continue; }
        let mut j = i;
        let mut dots = 0;
        while j < b.len() {
            if b[j].is_ascii_digit() { j += 1; }
            else if b[j] == b'.' && dots < 2 && j + 1 < b.len() && b[j + 1].is_ascii_digit() { dots += 1; j += 1; }
            else { break; }
        }
        if dots >= 1 { return Some(text[i..j].to_string()); }
    }
    None
}

/// Nearest ancestor that is a known CLI agent or a macOS app
pub fn find_launcher(pid: i32, t: &Table) -> Option<(&'static str, String, i32)> {
    let mut cur = t.get(&pid)?.ppid;
    for _ in 0..25 {
        if cur <= 1 { break; }
        let p = t.get(&cur)?;
        if let Some(a) = agent_of(&p.comm) { return Some(("agent", a.to_string(), cur)); }
        if let Some(a) = app_from_path(&p.comm) { return Some(("app", a.to_string(), cur)); }
        cur = p.ppid;
    }
    None
}

impl Scanner {
    fn track_activity(&self, pid: i32, cpu_sec: f64, started_at: Option<i64>, now: i64) -> Option<i64> {
        let mut map = self.activity.lock().unwrap();
        let a = map.entry(pid).or_insert_with(|| {
            let age = started_at.map(|s| (now - s) as f64 / 1000.0).unwrap_or(0.0);
            let busy = age <= 0.0 || cpu_sec / age > ACTIVE_RATE;
            Activity { cpu_sec, at: now, last_active: if busy { Some(now) } else { started_at } }
        });
        if now - a.at >= 2000 { // ignore near-simultaneous polls
            if (cpu_sec - a.cpu_sec) / ((now - a.at) as f64 / 1000.0) > ACTIVE_RATE { a.last_active = Some(now); }
            a.cpu_sec = cpu_sec;
            a.at = now;
        }
        a.last_active
    }

    /// The runtime's version, asked once per binary in the background; None until it answers
    fn version(&self, rt: &str, exe: Option<&str>) -> Option<String> {
        let flag = VERSION_FLAGS.iter().find(|(k, _)| *k == rt)?.1;
        let exe = exe.filter(|e| e.starts_with('/'))?.to_string();
        let mut v = self.versions.lock().unwrap();
        if let Some(x) = v.get(&exe) { return x.clone(); }
        v.insert(exe.clone(), None);
        let me = crate::state::ctx();
        tokio::spawn(async move {
            let o = run(&exe, &[flag], secs(3)).await;
            let found = first_version(&format!("{}\n{}", o.stdout, o.stderr));
            me.scanner.versions.lock().unwrap().insert(exe, found);
        });
        None
    }

    /// Every listener with everything the page shows about it
    async fn listeners(&self, t: &Table, settings: &Settings) -> Vec<Value> {
        let me = unsafe { libc::getuid() };
        let mut found: Vec<(i32, u16)> = t.values()
            .filter(|p| p.uid == me && p.nfiles > 0)
            .flat_map(|p| crate::fds::listening(p.pid, p.nfiles as usize).into_iter().map(move |l| (p.pid, l.port)))
            .collect();
        found.sort();
        let s = settings.get();
        let show_other = s["showOtherProcesses"].as_bool().unwrap_or(false);
        let favorites: Vec<u16> = s["favorites"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u16)).collect()).unwrap_or_default();
        let idle_hours = s["idleAfterHours"].as_f64().unwrap_or(24.0);

        // the shell pid of each tmux pane -> where it lives
        let mut panes: HashMap<i32, Value> = HashMap::new();
        // a spawn per scan otherwise: only when a listener runs inside tmux
        if found.iter().any(|(pid, _)| under_tmux(*pid, t)) {
            if let Some(tmux) = find_bin("tmux") {
                let o = run(&tmux, &["list-panes", "-a", "-F", "#{pane_pid}:#{window_index}:#{pane_index}:#{session_name}"], secs(3)).await;
                for l in o.stdout.lines() {
                    let mut it = l.splitn(4, ':');
                    let (Some(pid), Some(w), Some(p), Some(name)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
                    if let Ok(pid) = pid.parse() { panes.insert(pid, json!({ "session": name, "target": format!("{name}:{w}.{p}") })); }
                }
            }
        }

        let now = now_ms();
        let mut out = vec![];
        let mut users = HashMap::new();
        for (pid, port) in found {
            let Some(proc_) = t.get(&pid) else { continue };
            let command = proc_.name.clone();
            let rt = identify_runtime(&command);
            if !settings.runtime_enabled(rt) || (rt == "other" && !show_other) { continue; }
            let user = users.entry(proc_.uid).or_insert_with(|| self.users.lock().unwrap().entry(proc_.uid).or_insert_with(|| user_name(proc_.uid)).clone()).clone();
            let cwd = crate::procs::cwd(pid).map(|p| p.to_string_lossy().into_owned());
            let exe = crate::procs::exe_path(pid);
            out.push(self.entry(t, proc_, port, &command, rt, user, cwd, exe, &panes, &favorites, idle_hours, now));
        }
        // forget pids that are gone
        self.activity.lock().unwrap().retain(|pid, _| t.contains_key(pid));
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn entry(&self, t: &Table, p: &Proc, port: u16, command: &str, rt: &str, user: String, cwd: Option<String>, exe: Option<String>,
             panes: &HashMap<i32, Value>, favorites: &[u16], idle_hours: f64, now: i64) -> Value {
        let r = runtime(rt);
        let launcher = find_launcher(p.pid, t).map(|(kind, name, lp)| {
            let mut l = json!({ "kind": kind, "name": name, "pid": lp.to_string() });
            if kind == "agent" { l["cwd"] = json!(crate::procs::cwd(lp).map(|c| c.to_string_lossy().into_owned())); }
            l
        });
        // nearest ancestor that is a tmux pane's shell
        let mut tmux = Value::Null;
        let mut cur = p.pid;
        for _ in 0..40 {
            if cur <= 1 { break; }
            if let Some(x) = panes.get(&cur) { tmux = x.clone(); break; }
            match t.get(&cur) { Some(x) => cur = x.ppid, None => break }
        }
        let last_active = p.cpu_sec.and_then(|c| self.track_activity(p.pid, c, p.started_at, now));
        let has_project = cwd.as_deref().is_some_and(|c| c != "/");
        let self_app = app_from_path(&p.comm).or_else(|| exe.as_deref().and_then(app_from_path)).map(String::from);
        let version = self.version(rt, exe.as_deref());
        json!({
            "command": command, "pid": p.pid.to_string(), "user": user, "port": port, "runtime": rt,
            "runtimeName": r.name, "runtimeColor": r.color, "runtimeIcon": r.icon,
            "scriptPath": cwd,
            "favorite": favorites.contains(&port),
            "cpu": p.cpu,
            "memMB": p.mem_mb,
            "startedAt": p.started_at,
            "exePath": exe,
            "version": version,
            "procName": if p.comm.is_empty() { command.to_string() } else { basename(&p.comm).to_string() },
            "launcher": launcher,
            // app that owns a process with no project dir (oMLX, Raycast, ...)
            "appName": if has_project { Value::Null } else { match &launcher { Some(l) if l["kind"] == "app" => l["name"].clone(), _ => json!(self_app) } },
            // parent exited: typically a dev server left behind by a closed terminal/agent session
            "orphan": p.ppid == 1 && has_project && self_app.is_none(),
            "branch": if has_project { json!(git_branch(cwd.as_deref().unwrap())) } else { Value::Null },
            "github": if has_project { json!(github_url(cwd.as_deref().unwrap())) } else { Value::Null },
            "tmux": tmux,
            "ppid": if p.ppid > 0 { json!(p.ppid.to_string()) } else { Value::Null },
            "lastActive": last_active,
            // only project servers can be idle; apps (oMLX, Raycast) manage themselves
            "idle": has_project && self_app.is_none() && idle_hours > 0.0 && last_active.is_some_and(|l| (now - l) as f64 >= idle_hours * 3600e3),
        })
    }

    /// One scan: listeners, the 2-scan rule, health; returns the confirmed ports
    pub async fn scan(&self, t: &Table, settings: &Settings) -> Snapshot {
        let results = self.listeners(t, settings).await;
        let now = now_ms();
        let pid_alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 || *libc::__error() == libc::EPERM };
        let health = self.health.lock().unwrap().clone();
        let mut g = self.tracking.lock().unwrap();
        let first = !g.scanned;
        let mut live = HashSet::new();
        for p in results {
            let k = (p["pid"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0), p["port"].as_u64().unwrap_or(0) as u16);
            live.insert(k);
            if !g.tracked.contains_key(&k) { g.order.push(k); }
            let tr = g.tracked.entry(k).or_insert(Tracked { streak: if first { 1 } else { 0 }, missing: 0, entry: Value::Null }); // already up when DevDock started
            tr.streak += 1; tr.missing = 0; tr.entry = p;
        }
        let gone: Vec<_> = g.tracked.iter_mut().filter(|(k, _)| !live.contains(*k)).filter_map(|(k, tr)| {
            tr.missing += 1;
            let confirmed = tr.streak >= 2;
            (!confirmed || !pid_alive(k.0) || tr.missing >= 2).then(|| (*k, (!confirmed).then(|| tr.entry.clone())))
        }).collect();
        for (k, never_confirmed) in gone {
            g.tracked.remove(&k);
            if let Some(mut e) = never_confirmed { e["at"] = json!(now); g.transient.insert(0, e); }
        }
        let tracked: HashSet<_> = g.tracked.keys().copied().collect();
        g.order.retain(|k| tracked.contains(k));
        g.scanned = true;
        g.transient.truncate(50);
        let ports: Vec<Value> = g.order.iter().filter_map(|k| g.tracked.get(k)).filter(|t| t.streak >= 2).map(|t| {
            let mut e = t.entry.clone();
            let port = e["port"].as_u64().unwrap_or(0) as u16;
            e["health"] = json!(health.get(&port).map(String::as_str).unwrap_or("checking"));
            e
        }).collect();
        let unprobed: Vec<u16> = g.tracked.values().filter_map(|t| t.entry["port"].as_u64().map(|p| p as u16)).filter(|p| !health.contains_key(p)).collect();
        drop(g);
        for port in unprobed { self.probe(port); }
        self.record_history(&ports, settings, now);
        Snapshot { timestamp: iso(now), ports }
    }

    pub fn transient(&self, since: i64) -> Vec<Value> {
        self.tracking.lock().unwrap().transient.iter().filter(|t| t["at"].as_i64().unwrap_or(0) > since).cloned().collect()
    }

    pub fn health(&self) -> HashMap<u16, String> { self.health.lock().unwrap().clone() }

    /// Demo mode: made-up health and the listeners that came and went
    pub fn seed(&self, health: HashMap<u16, String>, transient: Vec<Value>) {
        *self.health.lock().unwrap() = health;
        let mut t = self.tracking.lock().unwrap();
        if t.transient.is_empty() { t.transient = transient; }
    }

    /// Probed in the background: new ports right away, the rest every 10s; a change rescans
    pub fn probe(&self, port: u16) {
        if port == 0 || crate::state::ctx().demo || !self.probing.lock().unwrap().insert(port) { return; }
        tokio::spawn(async move {
            let c = crate::state::ctx();
            let status = check_health(port).await;
            c.scanner.probing.lock().unwrap().remove(&port);
            let changed = c.scanner.health.lock().unwrap().insert(port, status.to_string()).as_deref() != Some(status);
            if changed { c.poke_ports(); }
        });
    }

    /// Drop health for ports that are gone; probe the rest again when someone's looking
    pub fn reprobe(&self, live: &[u16], looking: bool) {
        self.health.lock().unwrap().retain(|p, _| live.contains(p));
        if looking { for &p in live { self.probe(p); } }
    }

    /// History lives in the settings file; written when the set of running ports changes,
    /// and otherwise every 5 minutes to refresh lastSeen
    fn record_history(&self, ports: &[Value], settings: &Settings, now: i64) {
        let key = |p: &Value| format!("{}:{}", p["port"], p["scriptPath"].as_str().map(String::from).unwrap_or_else(|| "null".into()));
        let mut keys: Vec<String> = ports.iter().map(key).collect();
        keys.sort();
        let mut h = self.history.lock().unwrap();
        if keys == h.0 && now - h.1 < 300_000 { return; }
        let before = std::mem::replace(&mut *h, (keys, now)).0;
        let seen = iso(now);
        settings.update(|s| {
            let mut map: Vec<(String, Value)> = s["history"].as_array().cloned().unwrap_or_default().into_iter().map(|e| (key(&e), e)).collect();
            // ports that stopped since the last write were last seen now, not then
            for (k, e) in map.iter_mut() { if before.contains(k) && !h.0.contains(k) { e["lastSeen"] = json!(seen); } }
            for p in ports {
                let e = json!({ "port": p["port"], "command": p["command"], "user": p["user"], "runtime": p["runtime"],
                    "runtimeName": p["runtimeName"], "runtimeColor": p["runtimeColor"], "runtimeIcon": p["runtimeIcon"],
                    "scriptPath": p["scriptPath"], "lastSeen": seen });
                let k = key(p);
                match map.iter_mut().find(|(x, _)| *x == k) { Some(slot) => slot.1 = e, None => map.push((k, e)) }
            }
            let mut list: Vec<Value> = map.into_iter().map(|(_, v)| v).collect();
            list.sort_by(|a, b| b["lastSeen"].as_str().unwrap_or("").cmp(a["lastSeen"].as_str().unwrap_or("")));
            list.truncate(50);
            s["history"] = json!(list);
        });
    }
}

/// A tmux server among its ancestors
fn under_tmux(pid: i32, t: &Table) -> bool {
    let mut cur = pid;
    for _ in 0..40 {
        let Some(p) = t.get(&cur) else { return false };
        if p.name == "tmux" || p.comm.rsplit('/').next() == Some("tmux") { return true; }
        if p.ppid <= 1 { return false; }
        cur = p.ppid;
    }
    false
}

/// GET http://localhost:<port>/: healthy under 500, unhealthy at 500+, unreachable, unknown on timeout
pub async fn check_health(port: u16) -> &'static str {
    let c = &crate::state::ctx().local_http;
    match tokio::time::timeout(secs(2), c.get(format!("http://localhost:{port}")).send()).await {
        Ok(Ok(r)) => if r.status().as_u16() < 500 { "healthy" } else { "unhealthy" },
        Ok(Err(_)) => "unreachable",
        Err(_) => "unknown",
    }
}

/// 2026-11-26T19:13:00.000Z, like JavaScript's toISOString
pub fn iso(ms: i64) -> String {
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_from_banners() {
        assert_eq!(first_version("v22.11.0").as_deref(), Some("22.11.0"));
        assert_eq!(first_version("Python 3.12.4\n").as_deref(), Some("3.12.4"));
        assert_eq!(first_version("openjdk version \"21.0.2\" 2024-01-16").as_deref(), Some("21.0.2"));
        assert_eq!(first_version("redis-server v=7.2.5 sha=0").as_deref(), Some("7.2.5"));
        assert_eq!(first_version("nginx version: nginx/1.27.0").as_deref(), Some("1.27.0"));
        assert_eq!(first_version("no digits"), None);
        assert_eq!(first_version("build 12"), None);
    }

    #[test]
    fn iso_like_javascript() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1795508020605), "2026-11-24T08:13:40.605Z");
        assert_eq!(iso(951782400000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn launcher_is_the_nearest_agent_or_app() {
        let mut t = Table::new();
        for (pid, ppid, comm) in [(1, 0, "/sbin/launchd"), (5, 1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), (6, 5, "-zsh"), (7, 6, "claude"), (8, 7, "node"), (9, 6, "node")] {
            t.insert(pid, Proc { pid, ppid, comm: comm.into(), ..Default::default() });
        }
        assert_eq!(find_launcher(8, &t), Some(("agent", "Claude Code".into(), 7)));
        assert_eq!(find_launcher(9, &t), Some(("app", "Ghostty".into(), 5)));
        assert_eq!(find_launcher(5, &t), None);
    }

    #[test]
    fn tmux_only_when_a_listener_is_inside_it() {
        let mut t = Table::new();
        for (pid, ppid, comm) in [(1, 0, "/sbin/launchd"), (5, 1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), (6, 5, "-zsh"), (9, 6, "node"),
                                  (10, 1, "/opt/homebrew/bin/tmux"), (11, 10, "-zsh"), (12, 11, "node")] {
            t.insert(pid, Proc { pid, ppid, comm: comm.into(), ..Default::default() });
        }
        assert!(under_tmux(12, &t));
        assert!(!under_tmux(9, &t));
        assert!(!under_tmux(99, &t), "gone");
    }

    #[test]
    fn health_is_dropped_for_gone_ports_without_probing() {
        let s = Scanner::default();
        s.health.lock().unwrap().extend([(3000, "healthy".to_string()), (3001, "healthy".to_string())]);
        s.reprobe(&[3000], false); // no probe: probing needs the app's state, which a test doesn't have
        assert_eq!(s.health().keys().collect::<Vec<_>>(), vec![&3000]);
        assert!(s.probing.lock().unwrap().is_empty());
    }

    #[test]
    fn history_marks_a_stopped_port_as_seen_when_it_stopped() {
        let f = std::env::temp_dir().join(format!("dd-history-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&f);
        let settings = Settings::load(f.clone());
        let s = Scanner::default();
        let p = |port: u16| json!({ "port": port, "scriptPath": format!("/a,b/{port}") }); // a comma in the path
        let seen = |port: u64| settings.get()["history"].as_array().unwrap().iter().find(|e| e["port"] == port).unwrap()["lastSeen"].clone();
        s.record_history(&[p(3000), p(3001)], &settings, 0);
        s.record_history(&[p(3000), p(3001)], &settings, 60_000);
        assert_eq!(seen(3000), json!(iso(0)), "unchanged: no rewrite within 5 min");
        s.record_history(&[p(3000)], &settings, 120_000);
        assert_eq!(seen(3000), json!(iso(120_000)));
        assert_eq!(seen(3001), json!(iso(120_000)), "stopped just now, not at the last write");
        s.record_history(&[p(3000)], &settings, 500_000);
        assert_eq!(seen(3000), json!(iso(500_000)), "refreshed after 5 min");
        assert_eq!(seen(3001), json!(iso(120_000)), "gone stays put");
        let _ = std::fs::remove_file(&f);
    }
}

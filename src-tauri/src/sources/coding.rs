//! Agents tab: every coding agent running on this Mac (Claude Code, Codex, OpenCode...),
//! what it's doing and where it lives, so you can jump straight to it.
//!
//! An agent is a process whose name is a known CLI agent and whose parent isn't one
//! (that skips Claude Code's own helpers and sub-processes). Where it lives comes from
//! its ancestors: a multiplexer pane DevDock already lists (tmux pane, Herdr terminal),
//! else the terminal app it runs in (Ghostty, iTerm...). Claude Code's state is its own:
//! ~/.claude/sessions/<pid>.json (see detect::ClaudeStates).
use crate::detect::{agent_of, app_from_path, git_branch};
use crate::state::Ctx;
use crate::table::Table;
use crate::util::{basename, find_bin, pid_of, round1, run, secs, ApiErr, ApiResult};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
pub struct Coding { last: Mutex<Vec<Value>> }

/// Skip app binaries named like an agent (Claude.app itself, Claude Code's own helper app), but not the
/// agents desktop apps bundle: Claude's under Application Support/Claude/claude-code/, Codex's in Codex.app's Resources
fn bundled(comm: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    comm.contains(".app/") && !R.get_or_init(|| Regex::new(r"/claude-code/[^/]+/|/Codex\.app/Contents/Resources/").unwrap()).is_match(comm)
}

fn is_agent(t: &Table, pid: i32) -> bool {
    t.get(&pid).is_some_and(|p| !bundled(&p.comm) && !p.comm.contains(" bg-") && agent_of(&p.comm).is_some())
}

/// Agents: agent processes whose parent isn't one, by pid
pub fn agent_pids(t: &Table) -> Vec<i32> {
    let mut v: Vec<i32> = t.keys().copied().filter(|pid| is_agent(t, *pid) && !is_agent(t, t[pid].ppid)).collect();
    v.sort();
    v
}

/// Kids by pid in pid order, so a tree walk lists processes in a stable order
fn children(t: &Table) -> HashMap<i32, Vec<i32>> {
    let mut k = crate::table::children(t);
    for v in k.values_mut() { v.sort(); }
    k
}

/// Where it lives: the multiplexer pane above it, else the terminal app, else how it was left
pub fn where_of(t: &Table, pid: i32, panes: &HashMap<i32, Value>) -> Value {
    // Claude Code's background sessions run under its own helper app; keep climbing past it
    // to the session that started it, so Jump lands in that session's terminal
    let (mut w, mut bg) = (None, false);
    let mut cur = Some(pid);
    for _ in 0..40 {
        let Some(c) = cur.filter(|c| *c != 1) else { break };
        if w.is_some() { break; }
        if let Some(pane) = panes.get(&c) { w = Some(pane.clone()); }
        else {
            match t.get(&c).and_then(|p| app_from_path(&p.comm)) {
                Some("ClaudeCode") => bg = true,
                Some(app) if c != pid => w = Some(json!({ "app": app, "pid": c.to_string() })),
                _ => {}
            }
        }
        cur = t.get(&c).map(|p| p.ppid);
    }
    if bg { let mut x = w.unwrap_or(json!({})); x["background"] = json!(true); return x; }
    w.unwrap_or_else(|| {
        // no pane, no terminal app: its parent is gone or it was started by a script
        let parent = t.get(&pid).and_then(|p| t.get(&p.ppid));
        json!({ "detached": parent.is_none(), "parent": parent.map(|p| basename(&p.comm).to_string()).filter(|x| !x.is_empty()) })
    })
}

fn bad(msg: impl Into<String>) -> ApiErr { ApiErr::bad(msg) }

impl Coding {
    pub fn last(&self) -> Vec<Value> { self.last.lock().unwrap().clone() }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { return Ok(crate::demo::get("coding")); }
        let t = c.table();
        let kids = children(&t);
        // shell pid of each multiplexer pane DevDock lists -> the session (and tmux pane)
        let mut panes: HashMap<i32, Value> = HashMap::new();
        for s in c.sources.sessions.last() {
            for (i, pid) in s.raw.root_pids.iter().enumerate() {
                panes.insert(*pid, json!({ "mux": s.public["mux"], "id": s.public["id"], "name": s.public["name"], "target": s.raw.targets.get(i) }));
            }
        }
        let mut by_pid: HashMap<String, Vec<u64>> = HashMap::new();
        for p in c.ports() { if let (Some(pid), Some(port)) = (p["pid"].as_str(), p["port"].as_u64()) { by_pid.entry(pid.into()).or_default().push(port); } }
        let last: Vec<Value> = agent_pids(&t).into_iter().map(|pid| {
            let p = &t[&pid];
            // everything it started: servers, shells, MCP servers
            let tree = crate::table::tree(pid, &kids);
            let agent = agent_of(&p.comm).unwrap();
            let claude = agent == "Claude Code";
            let state = if claude { c.claude.state(pid) } else { Value::Null };
            let state = if state.is_object() { state } else { Value::Null };
            let cwd = crate::procs::cwd(pid).map(|d| d.to_string_lossy().into_owned());
            let name = state["name"].as_str().filter(|n| !n.is_empty()).map(String::from)
                .unwrap_or_else(|| cwd.as_deref().map(|d| basename(d).to_string()).unwrap_or_else(|| agent.to_string()));
            let mut ports: Vec<u64> = tree.iter().flat_map(|x| by_pid.get(&x.to_string()).cloned().unwrap_or_default()).collect();
            ports.sort();
            ports.dedup();
            let sum = |f: fn(&crate::table::Proc) -> f64| round1(tree.iter().filter_map(|x| t.get(x)).map(f).sum());
            json!({
                "pid": pid.to_string(), "agent": agent, "name": name, "state": state,
                "branch": cwd.as_deref().and_then(git_branch), "cwd": cwd,
                "sessionId": if claude { c.claude.session_id(pid) } else { None },
                "where": where_of(&t, pid, &panes), "startedAt": p.started_at,
                "cpu": sum(|p| p.cpu), "memMB": sum(|p| p.mem_mb),
                "processes": tree.len(),
                "pids": tree.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
                "ports": ports,
            })
        }).collect();
        *self.last.lock().unwrap() = last.clone();
        Ok(json!({ "agents": last }))
    }

    async fn find(&self, c: &Ctx, p: &Value) -> ApiResult<Value> {
        let pid = pid_of(&p["pid"]).map(|x| x.to_string()).unwrap_or_default();
        let get = || self.last.lock().unwrap().iter().find(|a| a["pid"] == json!(pid)).cloned();
        if get().is_none() { let _ = self.scan(c).await; }
        get().ok_or_else(|| ApiErr::gone("That agent is gone"))
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        let here = || Ok(json!({ "here": true }));
        match name {
            // Jump: the terminal tab it lives in. { here: true } when there's none to go to (DevDock opens it itself)
            "focus" => {
                let a = self.find(c, p).await?;
                let w = &a["where"];
                match w["mux"].as_str() {
                    // no deep link to a Herdr tab
                    Some("herdr") => return if run("/usr/bin/open", &["-a", "Herdr"], secs(10)).await.code == 0 { Ok(json!({})) } else { here() },
                    Some("tmux") => return Ok(focus_tmux(c, w).await),
                    Some(_) => return here(),
                    None => {}
                }
                let Some(app) = w["app"].as_str() else { return Err(bad("It isn't running in a terminal app DevDock can find")) };
                if app == "Ghostty" && focus_ghostty(a["cwd"].as_str(), a["name"].as_str().unwrap_or("")).await { return Ok(json!({})); }
                if run("/usr/bin/open", &["-a", app], secs(10)).await.code != 0 { return Err(bad(format!("Could not bring {app} to the front"))); }
                Ok(json!({}))
            }
            "stop" => {
                let a = self.find(c, p).await?;
                let pid: i32 = a["pid"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
                let sig = if p["force"].as_bool().unwrap_or(false) { libc::SIGKILL } else { libc::SIGTERM };
                if unsafe { libc::kill(pid, sig) } != 0 {
                    let e = std::io::Error::last_os_error();
                    if e.raw_os_error() != Some(libc::ESRCH) { return Err(bad(e.to_string())); }
                }
                Ok(json!({}))
            }
            _ => Err(crate::sources::unknown()),
        }
    }
}

/// A tmux pane: point the client showing its session (else any client) at the pane, then
/// bring that client's terminal tab forward. No client anywhere -> open it here.
async fn focus_tmux(c: &Ctx, w: &Value) -> Value {
    let tmux = find_bin("tmux").unwrap_or_else(|| "tmux".into());
    let id = w["id"].as_str().unwrap_or("");
    let r = run(&tmux, &["list-clients", "-F", "#{client_pid} #{client_tty} #{session_name}"], secs(10)).await;
    let clients: Vec<Vec<String>> = if r.code == 0 { r.stdout.trim().lines().filter(|l| !l.is_empty()).map(|l| l.split(' ').map(String::from).collect()).collect() } else { vec![] };
    let Some(cl) = clients.iter().find(|x| x.get(2).map(String::as_str) == Some(id)).or(clients.first()) else { return json!({ "here": true }) };
    let target = match w["target"].as_str() { Some(t) => format!("{id}:{t}"), None => id.to_string() };
    let _ = run(&tmux, &["switch-client", "-c", cl.get(1).map(String::as_str).unwrap_or(""), "-t", &target], secs(10)).await;
    let t = c.table();
    let mut app = None;
    let mut cur: Option<i32> = cl[0].parse().ok();
    for _ in 0..40 {
        let Some(x) = cur.filter(|x| *x != 1) else { break };
        app = t.get(&x).and_then(|p| app_from_path(&p.comm)).map(String::from);
        if app.is_some() { break; }
        cur = t.get(&x).map(|p| p.ppid);
    }
    let Some(app) = app else { return json!({ "here": true }) };
    let client_cwd = cl[0].parse().ok().and_then(crate::procs::cwd).map(|d| d.to_string_lossy().into_owned());
    if app == "Ghostty" && focus_ghostty(client_cwd.as_deref(), id).await { return json!({}); }
    if run("/usr/bin/open", &["-a", &app], secs(10)).await.code == 0 { json!({}) } else { json!({ "here": true }) }
}

/// How much of `title` (leading punctuation dropped) matches the start of `want`
fn title_score(title: &str, want: &str) -> usize {
    let t = title.to_lowercase();
    let t = t.trim_start_matches(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'));
    t.chars().zip(want.chars()).take_while(|(a, b)| a == b).count()
}

/// Ghostty 1.3's AppleScript lists terminals with a title and folder, not a tty or pid, so
/// the agent's tab is the one in its folder; several there -> the title closest to its name
async fn focus_ghostty(cwd: Option<&str>, name: &str) -> bool {
    // three lists, each joined by linefeeds, the lists split by a record-separator marker
    let r = run("/usr/bin/osascript", &["-e", "tell application \"Ghostty\" to set {i, d, n} to {id, working directory, name} of every terminal",
        "-e", "set AppleScript's text item delimiters to linefeed", "-e", "return (i as text) & \"\u{241E}\" & (d as text) & \"\u{241E}\" & (n as text)"], secs(5)).await;
    if r.code != 0 { return false; }
    let parts: Vec<Vec<&str>> = r.stdout.strip_suffix('\n').unwrap_or(&r.stdout).split('\u{241E}').map(|x| x.split('\n').collect()).collect();
    let (ids, dirs, names) = (parts.first().cloned().unwrap_or_default(), parts.get(1).cloned().unwrap_or_default(), parts.get(2).cloned().unwrap_or_default());
    let want = name.to_lowercase();
    let mut terms: Vec<(&str, &str)> = ids.iter().enumerate().filter(|(k, _)| dirs.get(*k).copied() == cwd).map(|(k, id)| (*id, names.get(k).copied().unwrap_or(""))).collect();
    if terms.is_empty() { return false; }
    terms.sort_by_key(|(_, title)| std::cmp::Reverse(title_score(title, &want)));
    run("/usr/bin/osascript", &["-e", "on run argv", "-e", "tell application \"Ghostty\" to focus (first terminal whose id is (item 1 of argv))", "-e", "end run", terms[0].0], secs(5)).await.code == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::Proc;
    fn table(rows: &[(i32, i32, &str)]) -> Table {
        rows.iter().map(|(pid, ppid, comm)| (*pid, Proc { pid: *pid, ppid: *ppid, comm: comm.to_string(), ..Default::default() })).collect()
    }
    #[test]
    fn agents_bundled_in_desktop_apps_count_the_apps_hosting_them_do_not() {
        let s = "/Users/me/Library/Application Support/Claude/claude-code/2.1.331/5cdc5c10ac5c/claude.app/Contents/MacOS/claude";
        let t = table(&[
            (100, 1, "/Applications/Claude.app/Contents/MacOS/Claude"),
            (101, 100, "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"),
            (102, 101, s), // Claude desktop's Code tab
            (200, 1, "/Applications/Codex.app/Contents/MacOS/Codex"),
            (201, 200, "/Applications/Codex.app/Contents/Resources/codex"), // Codex desktop
            (300, 1, "/Users/me/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"), // Claude Code's own helper
            (400, 1, "claude"), // a terminal session
            (401, 400, "claude bg-pty-host"), // its helper: part of session 400
            (500, 1, "/Users/me/.local/share/claude/versions/2.1.322"), // the native install
        ]);
        assert_eq!(agent_pids(&t), [102, 201, 400, 500]);
    }
    #[test]
    fn where_it_lives() {
        let t = table(&[
            (10, 1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), (11, 10, "/bin/zsh"), (12, 11, "claude"),
            (20, 1, "/bin/zsh"), (21, 20, "codex"),
            (30, 1, "/x/ClaudeCode.app/Contents/MacOS/claude"), (31, 30, "claude"),
            (41, 999, "codex"),
        ]);
        let panes = HashMap::from([(20, json!({ "mux": "tmux", "id": "api", "name": "api", "target": "0.0" }))]);
        assert_eq!(where_of(&t, 12, &panes), json!({ "app": "Ghostty", "pid": "10" }));
        assert_eq!(where_of(&t, 21, &panes)["target"], "0.0");
        assert_eq!(where_of(&t, 31, &panes), json!({ "background": true }));
        assert_eq!(where_of(&t, 41, &panes), json!({ "detached": true, "parent": null }));
        assert_eq!(where_of(&table(&[(5, 4, "codex"), (4, 1, "/usr/bin/make")]), 5, &panes), json!({ "detached": false, "parent": "make" }));
    }
    #[test]
    fn ghostty_titles() {
        assert_eq!(title_score("✳ storefront", "storefront"), 10);
        assert!(title_score("store", "storefront") > title_score("zsh", "storefront"));
    }
}

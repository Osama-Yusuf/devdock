//! Coding agents (Claude Code, Codex, OpenCode) run headless on what the user selected.
//!
//! Each run is a tmux session "devdock-agent-<id>" running `<DevDock> run-agent <dir>`
//! (src/runner), which writes milestones to <tmp>/devdock-agents/<id>/events.jsonl. This source
//! lists the runs from those files, so a run survives DevDock restarting, and anyone can attach
//! to watch it. Off until enabled in Settings; never in demo mode.
use crate::runner::adapters::{agent, jstr, take16, last16, truthy, AGENTS};
use crate::sources::{unknown, TermSpec};
use crate::state::Ctx;
use crate::util::{bin_dirs, dirname, find_bin, home, now_ms, run, secs, ApiErr, ApiResult, Get};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const PREFIX: &str = "devdock-agent-";
const KEEP: usize = 20; // runs kept on disk
const SNAPSHOT_CHARS: usize = 2500; // per item, so a big selection still fits a prompt

// DevDock draws the answer as a verdict, findings and next steps (runner/adapters.rs
// parse_reply reads it back). Anything off-shape falls back to the prose as markdown.
pub const REPLY_FORMAT: &str = r#"Reply format: DevDock renders your final message as cards, not text. End it with exactly one fenced ```json block and nothing after it:
{
  "status": "ok" | "warning" | "problem" | "info",
  "summary": "the answer in one sentence",
  "findings": [{ "status": "ok" | "warning" | "problem" | "info", "title": "short headline", "detail": "one or two sentences, `code` allowed", "items": ["names of selected items it concerns"] }],
  "actions": [{ "title": "what to do, imperative", "command": "exact shell command, or empty", "risk": "safe" | "changes" | "destructive", "why": "one short sentence" }],
  "replies": ["short follow-up the user might send"]
}
At most 5 findings and 4 actions, most important first. "replies" holds 2 or 3 short messages the user would likely send you next, in their voice ("Do step 1", "Show me its logs", "Why did that happen?"); only offer what you could actually do, and never have the user claim something changed (like permissions). Before the block, write at most two sentences."#;
const REPLY_AGAIN: &str = "Reply in the same format as before: at most two sentences, then the ```json block with status, summary, findings, actions and replies.";

/// Where runs live: Node's os.tmpdir() is $TMPDIR, as is this
pub fn runs_dir() -> PathBuf { std::env::temp_dir().join("devdock-agents") }

fn is_id(id: &str) -> bool { id.len() == 8 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

#[derive(Default)]
pub struct Agents {
    versions: Mutex<Option<(Vec<Value>, i64)>>,
    cache: Mutex<HashMap<String, (u64, Arc<Vec<Value>>)>>, // run id -> (events file size, events)
    any: AtomicBool,
}

fn bad(msg: impl Into<String>) -> ApiErr { ApiErr::bad(msg) }
fn str_(v: &Value, max: usize) -> String { v.as_str().map(|s| take16(s, max).to_string()).unwrap_or_default() }
fn read_json(f: &Path) -> Option<Value> { serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok() }

/// Run ids, newest first
fn run_ids() -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(runs_dir()) else { return vec![] };
    let mut v: Vec<(String, std::time::SystemTime)> = rd.flatten()
        .filter_map(|e| { let n = e.file_name().to_string_lossy().into_owned(); is_id(&n).then(|| (n, e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH))) })
        .collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.1));
    v.into_iter().map(|x| x.0).collect()
}

/// The index of the last event with this t
fn last_of(events: &[Value], t: &str) -> Option<usize> { events.iter().rposition(|e| e["t"] == t) }

impl Agents {
    pub fn any_running(&self) -> bool { self.any.load(Ordering::SeqCst) }

    async fn installed(&self) -> Vec<Value> {
        if let Some((v, at)) = &*self.versions.lock().unwrap() { if now_ms() - at < 60_000 { return v.clone(); } }
        let v = futures_util::future::join_all(AGENTS.iter().map(|a| async move {
            let bin = find_bin(a.bin);
            let out = match &bin { Some(b) => run(b, &["--version"], secs(5)).await.stdout, None => String::new() };
            let first = out.trim().split('\n').next().unwrap_or("");
            let version = first.trim_start_matches(|c: char| !c.is_ascii_digit()).split(' ').next().unwrap_or("");
            json!({ "id": a.id, "label": a.label, "installed": bin.is_some(), "version": if version.is_empty() { Value::Null } else { json!(version) } })
        })).await;
        *self.versions.lock().unwrap() = Some((v.clone(), now_ms()));
        v
    }

    fn read_events(&self, id: &str) -> Arc<Vec<Value>> {
        let file = runs_dir().join(id).join("events.jsonl");
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        let mut cache = self.cache.lock().unwrap();
        if let Some((s, ev)) = cache.get(id) { if *s == size { return ev.clone(); } }
        let events: Vec<Value> = if size > 0 {
            std::fs::read_to_string(&file).unwrap_or_default().split('\n').filter(|l| !l.is_empty())
                .filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(truthy).collect()
        } else { vec![] };
        let ev = Arc::new(events);
        cache.insert(id.to_string(), (size, ev.clone()));
        ev
    }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { return Ok(json!({ "enabled": false, "agents": [], "runs": [] })); }
        let agents = self.installed().await;
        if !truthy(&c.settings.get()["agentsEnabled"]) { self.any.store(false, Ordering::SeqCst); return Ok(json!({ "enabled": false, "agents": agents, "runs": [] })); }
        let mut live = HashSet::new();
        if let Some(tmux) = find_bin("tmux") {
            let r = run(&tmux, &["list-sessions", "-F", "#{session_name}"], secs(10)).await;
            for n in r.stdout.split('\n') { if let Some(id) = n.strip_prefix(PREFIX) { live.insert(id.to_string()); } }
        }
        let runs: Vec<Value> = run_ids().into_iter().filter_map(|id| {
            let meta = read_json(&runs_dir().join(&id).join("meta.json"))?;
            let events = self.read_events(&id);
            // a conversation: the state is the latest turn's, each reply starts one
            let from = last_of(&events, "user").map_or(0, |i| i + 1);
            let done = events[from..].iter().find(|e| e["t"] == "done");
            let alive = live.contains(&id);
            let state = match done { Some(d) => if truthy(&d["ok"]) { "done" } else { "failed" }, None => if alive { "running" } else { "stopped" } };
            let mut r = match meta { Value::Object(m) => m, _ => Map::new() };
            r.insert("id".into(), json!(id));
            r.insert("session".into(), json!(format!("{PREFIX}{id}")));
            r.insert("alive".into(), json!(alive));
            r.insert("state".into(), json!(state));
            r.insert("resumed".into(), json!(events.iter().any(|e| e["t"] == "resumed")));
            r.insert("events".into(), json!(*events));
            Some(Value::Object(r))
        }).collect();
        self.any.store(runs.iter().any(|r| r["state"] == "running"), Ordering::SeqCst);
        Ok(json!({ "enabled": true, "agents": agents, "runs": runs }))
    }

    /// What DevDock already knows about each item, so the agent starts with facts instead of
    /// spending turns finding them (and a read-only codex, which can't reach Docker, still sees).
    async fn snapshot(c: &Ctx, it: &Value) -> String {
        let (kind, r) = (it.str_of("kind"), it.str_of("ref"));
        if kind == "container" && !r.is_empty() {
            return c.sources.containers.snapshot(c, r).await.ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        }
        if kind == "session" && it.str_of("mux") == "tmux" && !r.is_empty() {
            if let Some(tmux) = find_bin("tmux") {
                let o = run(&tmux, &["capture-pane", "-p", "-J", "-S", "-40", "-t", &format!("={r}:")], secs(10)).await;
                if o.code == 0 && !o.stdout.trim().is_empty() { return format!("Screen (last lines):\n{}", o.stdout.trim_end()); }
            }
        }
        String::new()
    }

    async fn build_prompt(c: &Ctx, request: &str, items: &[Value], read_only: bool, k8s: Option<&str>) -> String {
        let blocks = futures_util::future::join_all(items.iter().map(|it| async move {
            let facts = it["facts"].as_object().map(|f| f.iter().filter(|(_, v)| !v.is_null() && *v != "").map(|(k, v)| format!("{k}: {}", jstr(v))).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            let snap = Self::snapshot(c, it).await;
            let snap = last16(&snap, SNAPSHOT_CHARS);
            format!("## {}: {}\n{facts}{}", it.str_of("kind"), it.str_of("name"), if snap.is_empty() { String::new() } else { format!("\n{snap}") })
        })).await;
        let notes: Vec<String> = [
            k8s.map(|k| format!("kubectl: always pass --context {k} (the cluster these run in). Never use the current kubectl context.")),
            items.iter().any(|i| i.str_of("mux") == "tmux").then(|| "tmux: read a session's screen with `tmux capture-pane -p -J -S -200 -t =<name>:`.".to_string()),
            read_only.then(|| "This is a read-only run: inspect only. Do not stop, start, restart, delete, edit or install anything. If something needs changing, give the exact commands instead.".to_string()),
        ].into_iter().flatten().map(|n| format!("- {n}")).collect();
        format!("{request}\n\n<devdock_context>\nSelected in DevDock, a local dev dashboard on this Mac ({} item{}):\n\n{}\n</devdock_context>\n\nNotes:\n{}\n\n{REPLY_FORMAT}",
            items.len(), if items.len() > 1 { "s" } else { "" }, blocks.join("\n\n"), notes.join("\n"))
    }

    fn prune(&self) {
        for id in run_ids().into_iter().skip(KEEP) {
            let _ = std::fs::remove_dir_all(runs_dir().join(&id));
            self.cache.lock().unwrap().remove(&id);
        }
    }

    fn known(p: &Value) -> ApiResult<String> {
        let id = p.str_of("id");
        if !is_id(id) || !runs_dir().join(id).exists() { return Err(ApiErr::gone("That run is gone")); }
        Ok(id.to_string())
    }

    async fn kill(id: &str) {
        if let Some(tmux) = find_bin("tmux") { run(&tmux, &["kill-session", "-t", &format!("={PREFIX}{id}")], secs(10)).await; }
    }

    /// The run's tmux session runs this app as the runner; PATH lets the agent find node, git,
    /// docker... even when DevDock was opened from Finder.
    async fn launch(&self, id: &str, bin: &str, cwd: &str) -> ApiResult<()> {
        let tmux = find_bin("tmux").ok_or_else(|| bad("Agents run in tmux, and tmux isn't installed"))?;
        let mut path: Vec<String> = vec![];
        let env_path = std::env::var("PATH").unwrap_or_default();
        for d in std::iter::once(dirname(bin).to_string()).chain(bin_dirs().iter().map(|d| d.to_string_lossy().into_owned())).chain(env_path.split(':').map(String::from)) {
            if !d.is_empty() && !path.contains(&d) { path.push(d); }
        }
        let exe = std::env::current_exe().map_err(|e| ApiErr::new(500, e.to_string()))?;
        let dir = runs_dir().join(id);
        let r = run(&tmux, &["new-session", "-d", "-s", &format!("{PREFIX}{id}"), "-c", cwd, "-x", "160", "-y", "45",
            "-e", &format!("PATH={}", path.join(":")), "--", &exe.to_string_lossy(), "run-agent", &dir.to_string_lossy()], secs(10)).await;
        if r.code != 0 { return Err(ApiErr::new(500, Some(r.stderr.trim()).filter(|s| !s.is_empty()).unwrap_or("Could not start tmux"))); }
        self.any.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn enabled(c: &Ctx) -> ApiResult<()> {
        if c.demo || !truthy(&c.settings.get()["agentsEnabled"]) { return Err(ApiErr::new(403, "Agents are off. Turn them on in Settings.")); }
        Ok(())
    }

    async fn start(&self, c: &Ctx, p: &Value) -> ApiResult<Value> {
        Self::enabled(c)?;
        let a = agent(p.str_of("agent"));
        let bin = a.and_then(|a| find_bin(a.bin)).ok_or_else(|| bad(format!("{} isn't installed", a.map_or("That agent", |a| a.label))))?;
        let a = a.unwrap();
        if find_bin("tmux").is_none() { return Err(bad("Agents run in tmux, and tmux isn't installed")); }
        let request = str_(&p["request"], 4000).trim().to_string();
        if request.is_empty() { return Err(bad("Write what you want to know")); }
        let items: Vec<Value> = p["items"].as_array().map(|a| a.iter().take(40).map(|it| {
            let facts: Map<String, Value> = it["facts"].as_object().map(|f| f.iter().take(20)
                .map(|(k, v)| (take16(k, 40).to_string(), json!(take16(&if v.is_null() { String::new() } else { jstr(v) }, 400)))).collect()).unwrap_or_default();
            json!({ "kind": str_(&it["kind"], 20), "name": str_(&it["name"], 200), "ref": str_(&it["ref"], 200), "mux": str_(&it["mux"], 20), "facts": facts })
        }).collect()).unwrap_or_default();
        let read_only = truthy(&p["readOnly"]);
        let k8s = p["k8sContext"].as_str().filter(|k| (1..=64).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)));
        let cwd = p["cwd"].as_str().filter(|d| d.starts_with('/') && Path::new(d).exists()).map(String::from).unwrap_or_else(|| home().to_string_lossy().into_owned());

        let id = format!("{:08x}", unsafe { libc::arc4random() });
        let dir = runs_dir().join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| ApiErr::new(500, e.to_string()))?;
        let prompt = Self::build_prompt(c, &request, &items, read_only, k8s).await;
        let write = |f: &str, s: String| std::fs::write(dir.join(f), s).map_err(|e| ApiErr::new(500, e.to_string()));
        write("spec.json", json!({ "agent": a.id, "bin": bin, "prompt": prompt, "readOnly": read_only, "k8sContext": k8s, "cwd": cwd, "request": request }).to_string())?;
        write("prompt.md", prompt.clone())?;
        write("meta.json", json!({
            "agent": a.id, "label": a.label, "request": request, "readOnly": read_only, "cwd": cwd, "createdAt": now_ms(),
            "items": items.iter().map(|i| json!({ "kind": i["kind"], "name": i["name"] })).collect::<Vec<_>>(),
        }).to_string())?;
        if let Err(e) = self.launch(&id, &bin, &cwd).await { let _ = std::fs::remove_dir_all(&dir); return Err(e); }
        self.prune();
        Ok(json!({ "id": id, "session": format!("{PREFIX}{id}") }))
    }

    /// Reply in the same conversation. The runner reads the inbox between turns; a stopped
    /// run gets its runner back, which answers what's waiting.
    async fn reply(&self, c: &Ctx, p: &Value) -> ApiResult<Value> {
        Self::enabled(c)?;
        let id = Self::known(p)?;
        let text = str_(&p["text"], 4000).trim().to_string();
        if text.is_empty() { return Err(bad("Write a reply")); }
        let dir = runs_dir().join(&id);
        let spec = read_json(&dir.join("spec.json")).ok_or_else(|| ApiErr::new(500, "This run's spec.json is unreadable"))?;
        let events = self.read_events(&id);
        if !events.iter().any(|e| e["t"] == "session") { return Err(bad("This run never started a conversation")); }
        let tmux = find_bin("tmux").ok_or_else(|| bad("Agents run in tmux, and tmux isn't installed"))?;
        let alive = run(&tmux, &["has-session", "-t", &format!("={PREFIX}{id}")], secs(10)).await.code == 0;
        if alive && events.iter().any(|e| e["t"] == "resumed") { return Err(ApiErr::new(409, "You're talking to it in the terminal now")); }
        // busy: a turn in flight, or a reply the runner hasn't picked up yet
        let from = last_of(&events, "user").map_or(0, |i| i + 1);
        let inbox = dir.join("inbox.jsonl");
        let queued = std::fs::read_to_string(&inbox).map(|t| t.split('\n').filter(|l| !l.is_empty()).count()).unwrap_or(0);
        let users = events.iter().filter(|e| e["t"] == "user").count();
        if queued > users || (alive && !events[from..].iter().any(|e| e["t"] == "done")) { return Err(ApiErr::new(409, "It's still working on the last one")); }
        let read_only = truthy(&p["readOnly"]);
        let prompt = format!("{text}\n\n({}{REPLY_AGAIN})", if read_only { "Read-only: inspect only, change nothing. " } else { "" });
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(&inbox)
            .and_then(|mut f| f.write_all(format!("{}\n", json!({ "text": text, "prompt": prompt, "readOnly": read_only, "at": now_ms() })).as_bytes()))
            .map_err(|e| ApiErr::new(500, e.to_string()))?;
        if !alive { self.launch(&id, spec.str_of("bin"), spec.str_of("cwd")).await?; }
        self.any.store(true, Ordering::SeqCst);
        Ok(json!({}))
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        match name {
            "start" => self.start(c, p).await,
            "reply" => self.reply(c, p).await,
            "stop" => { Self::kill(&Self::known(p)?).await; Ok(json!({})) }
            "dismiss" => {
                let id = Self::known(p)?;
                Self::kill(&id).await;
                let _ = std::fs::remove_dir_all(runs_dir().join(&id));
                self.cache.lock().unwrap().remove(&id);
                Ok(json!({}))
            }
            _ => Err(unknown()),
        }
    }

    /// A next step's command, run in DevDock's terminal from the run's folder. Only commands
    /// the agent actually suggested in this run; the terminal stays open until a key.
    pub fn terminal(&self, _c: &Ctx, p: &Value) -> Option<TermSpec> {
        let (id, cmd) = (p["id"].as_str()?, p["cmd"].as_str()?);
        if !is_id(id) { return None; }
        let events = self.read_events(id);
        let suggested = events.iter().any(|e| e["t"] == "answer" && e["data"]["actions"].as_array().is_some_and(|a| a.iter().any(|x| x["command"] == cmd)));
        if !suggested { return None; }
        let cwd = read_json(&runs_dir().join(id).join("meta.json")).and_then(|m| m["cwd"].as_str().filter(|s| !s.is_empty()).map(String::from))
            .unwrap_or_else(|| home().to_string_lossy().into_owned());
        let script = r#"printf '\033[2m$ %s\033[0m\n' "$1"; eval "$1"; s=$?; printf '\n\033[2m[exit %s] press any key to close\033[0m' $s; read -rsk1"#;
        Some(TermSpec { file: "/bin/zsh".into(), args: vec!["-lc".into(), script.into(), "devdock".into(), cmd.into()], cwd: Some(cwd), ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_reply_format() {
        assert!(is_id("0a1b2c3d"));
        assert!(!is_id("0A1B2C3D"));
        assert!(!is_id("../etc/x"));
        assert!(REPLY_FORMAT.contains("```json block") && REPLY_FORMAT.ends_with("write at most two sentences."));
        // the reply format the agent is asked for is the one the runner reads back
        let reply = "Fine.\n\n```json\n{\"status\":\"ok\",\"summary\":\"All good\",\"findings\":[],\"actions\":[],\"replies\":[]}\n```";
        assert_eq!(crate::runner::adapters::parse_reply(reply).unwrap().1["summary"], "All good");
    }

    /// The runner end to end: a fake agent CLI replays a recorded claude stream; the events
    /// file gets the same milestones the Node runner wrote, and the run reads back as done.
    #[test]
    fn runner_writes_what_the_source_reads() {
        let tmp = std::env::temp_dir().join(format!("devdock-runner-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let fake = tmp.join("claude");
        let lines = [
            json!({ "type": "system", "subtype": "init", "session_id": "s1" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "docker ps" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "x", "is_error": false }] } }),
            json!({ "type": "result", "subtype": "success", "is_error": false, "result": "It is healthy.", "session_id": "s1", "total_cost_usd": 0.3 }),
        ];
        let body = lines.iter().map(|l| format!("echo {}", crate::util::shq(&l.to_string()))).collect::<Vec<_>>().join("\n");
        // a reply resumes the session; that turn hangs until stopped
        let resumed = format!("case \"$*\" in *--resume*) echo {}; exec sleep 30;; esac", crate::util::shq(&lines[0].to_string()));
        std::fs::write(&fake, format!("#!/bin/sh\necho banner\n{resumed}\necho \"$@\" > {}\n{body}\n", crate::util::shq(&tmp.join("argv").to_string_lossy()))).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run_dir = tmp.join("0a1b2c3d");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_dir.join("spec.json"), json!({ "agent": "claude", "bin": fake, "prompt": "is it ok?", "readOnly": true, "k8sContext": null, "cwd": tmp, "request": "is it ok?" }).to_string()).unwrap();
        // the test binary has no run-agent mode; run the runner in a child of this test via a re-exec
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "sources::agents::tests::runner_child", "--nocapture"]).env("DEVDOCK_RUNNER_DIR", &run_dir)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).spawn().unwrap();
        let events = || crate::runner::read_lines(&run_dir.join("events.jsonl"));
        let wait_for = |what: &str, n: usize| {
            let t = std::time::Instant::now();
            while events().iter().filter(|e| e["t"] == what).count() < n {
                assert!(t.elapsed().as_secs() < 20, "no {what} event");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        // the first turn ends, then the runner waits for a reply
        wait_for("done", 1);
        let ev = events();
        let ts: Vec<&str> = ev.iter().map(|e| e["t"].as_str().unwrap()).collect();
        assert_eq!(ts, ["start", "session", "step", "step", "answer", "done"]);
        assert!(ev.iter().all(|e| e["at"].is_i64()));
        assert_eq!(ev[3]["status"], "ok");
        assert_eq!(ev[5]["cost"], 0.3);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(child.try_wait().unwrap().is_none(), "it waits for a reply");
        // a reply runs the next turn on the same session; tmux's kill-session (SIGHUP) stops it
        std::fs::write(run_dir.join("inbox.jsonl"), format!("{}\n", json!({ "text": "and now?", "prompt": "and now?", "readOnly": true, "at": 1 }))).unwrap();
        wait_for("start", 2);
        std::thread::sleep(std::time::Duration::from_millis(300));
        unsafe { libc::kill(child.id() as i32, libc::SIGHUP); }
        assert!(child.wait().unwrap().success());
        let ev = events();
        let ts: Vec<&str> = ev.iter().map(|e| e["t"].as_str().unwrap()).collect();
        assert_eq!(&ts[6..], ["user", "start", "done"]); // the repeated session id isn't written again
        assert_eq!((&ev[8]["ok"], &ev[8]["error"]), (&json!(false), &json!("Stopped")));
        let argv = std::fs::read_to_string(tmp.join("argv")).unwrap();
        assert!(argv.starts_with("-p is it ok? --output-format stream-json --verbose --permission-mode dontAsk"), "{argv}");
        assert!(std::fs::read_to_string(run_dir.join("raw.jsonl")).unwrap().starts_with("banner\n"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn runner_child() {
        // only as the child of the test above
        if let Ok(d) = std::env::var("DEVDOCK_RUNNER_DIR") { crate::runner::main(&d); }
    }
}

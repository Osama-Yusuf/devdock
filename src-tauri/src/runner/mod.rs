//! Runs one agent conversation inside its tmux session: `<DevDock> run-agent <runDir>`
//!
//! <runDir>/spec.json      what to run (agent, first prompt, access, folder)
//! <runDir>/events.jsonl   milestones, written here, read by DevDock; a turn per message
//! <runDir>/inbox.jsonl    replies from DevDock, one per line: { text, prompt, readOnly }
//!
//! The first turn runs the request; each reply resumes the same agent session headless
//! (claude -p --resume, codex exec resume, opencode run --session). Between turns, Enter
//! here continues the conversation interactively instead. Started again on a stopped run,
//! it picks up where the events file left off and answers what's waiting in the inbox.
//! The same files the Node runner wrote, so runs from either carry on in the other.
pub mod adapters;

use adapters::{Agent, Opts, Reducer};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RUNNING: u8 = 0;
const WAITING: u8 = 1;
const RESUMED: u8 = 2; // the agent's own interactive UI owns the terminal

static PHASE: AtomicU8 = AtomicU8::new(RUNNING);
static CHILD: AtomicI32 = AtomicI32::new(0); // the headless turn's pid, 0 between turns
static STOPPED: AtomicBool = AtomicBool::new(false);

const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const BLUE: &str = "\x1b[34m";
const RESET: &str = "\x1b[0m";

fn say(s: &str) { println!("{s}"); }

fn now_ms() -> i64 { crate::util::now_ms() }

/// Every line as JSON, or nothing when any line isn't (as the JS read it)
pub fn read_lines(f: &Path) -> Vec<Value> {
    let Ok(t) = std::fs::read_to_string(f) else { return vec![] };
    t.split('\n').filter(|l| !l.is_empty()).map(serde_json::from_str).collect::<Result<_, _>>().unwrap_or_default()
}

struct Run {
    dir: PathBuf,
    spec: Value,
    agent: &'static Agent,
    raw: std::fs::File,
}

impl Run {
    fn emit(&self, m: &Value) {
        let mut m = m.clone();
        m["at"] = json!(now_ms());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("events.jsonl")) {
            let _ = f.write_all(format!("{m}\n").as_bytes());
        }
    }

    fn print(&self, m: &Value) {
        let s = |k: &str| m[k].as_str().unwrap_or("").to_string();
        match m["t"].as_str().unwrap_or("") {
            "user" => {
                let ro = adapters::truthy(&m["readOnly"]);
                let differs = m["readOnly"] != self.spec["readOnly"];
                say(&format!("\n{BLUE}{BOLD}you{RESET} {}{}\n", adapters::jstr(&m["text"]),
                    if differs { format!("  {DIM}({}){RESET}", if ro { "read-only" } else { "full access" }) } else { String::new() }));
            }
            "step" if m["status"] != "run" => {
                let mark = match m["status"].as_str() { Some("ok") => format!("{GREEN}✓"), Some("blocked") => format!("{YELLOW}⊘"), _ => format!("{RED}✗") };
                let cmd = if m["kind"] == "cmd" { format!("  {DIM}$ {}{RESET}", adapters::take16(s("detail").split('\n').next().unwrap_or(""), 100)) } else { String::new() };
                say(&format!("  {mark}{RESET} {}{}{RESET}{cmd}", if adapters::truthy(&m["change"]) { YELLOW } else { "" }, s("label")));
                if m["status"] == "fail" && !s("out").is_empty() { say(&format!("{DIM}{}{RESET}", s("out").split('\n').map(|l| format!("      {l}")).collect::<Vec<_>>().join("\n"))); }
            }
            "note" => say(&format!("\n  {CYAN}›{RESET} {}\n", s("text"))),
            "answer" if m["data"].is_null() => say(&format!("\n{}\n", s("text"))),
            "answer" => {
                // the same cards DevDock draws, as text: the raw JSON is for DevDock, not for people
                let mark = |st: &Value| match st.as_str() { Some("ok") => format!("{GREEN}✓"), Some("warning") => format!("{YELLOW}!"), Some("problem") => format!("{RED}✗"), _ => format!("{CYAN}i") };
                let d = &m["data"];
                let g = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
                say(&format!("\n{} {BOLD}{}{RESET}\n", mark(&d["status"]), g(d, "summary")));
                for f in d["findings"].as_array().into_iter().flatten() {
                    let detail = g(f, "detail");
                    say(&format!("  {}{RESET} {BOLD}{}{RESET}{}", mark(&f["status"]), g(f, "title"), if detail.is_empty() { String::new() } else { format!("\n    {detail}") }));
                }
                let actions = d["actions"].as_array().cloned().unwrap_or_default();
                if !actions.is_empty() { say(&format!("\n{DIM}Next steps{RESET}")); }
                for (i, a) in actions.iter().enumerate() {
                    let (why, cmd) = (g(a, "why"), g(a, "command"));
                    say(&format!("  {}. {} {DIM}({}){RESET}{}{}", i + 1, g(a, "title"), g(a, "risk"),
                        if why.is_empty() { String::new() } else { format!("\n     {DIM}{why}{RESET}") },
                        if cmd.is_empty() { String::new() } else { format!("\n     {CYAN}$ {cmd}{RESET}") }));
                }
                say("");
            }
            "done" => {
                let secs = (m["ms"].as_f64().unwrap_or(0.0) / 1000.0).round();
                let cost = m["cost"].as_f64().filter(|c| *c != 0.0).map(|c| format!("${c:.2}"));
                let tokens = m["tokens"].as_f64().filter(|t| *t != 0.0).map(|t| format!("{}k tokens", (t / 1000.0).round()));
                let extra = [cost, tokens].into_iter().flatten().collect::<Vec<_>>().join(" · ");
                if adapters::truthy(&m["ok"]) {
                    say(&format!("{DIM}Done in {secs}s{}{RESET}", if extra.is_empty() { String::new() } else { format!(" · {extra}") }));
                } else {
                    let e = s("error");
                    say(&format!("{RED}{}{RESET}", if e.is_empty() { "Stopped".into() } else { e }));
                }
            }
            _ => {}
        }
    }

    /// One headless turn; returns when the agent exits, with the session to resume
    fn turn(&mut self, prompt: &str, read_only: bool, session: Option<String>) -> Option<String> {
        let started = Instant::now();
        let mut reducer = Reducer::new(self.agent);
        let mut sid = session.clone();
        let k8s = self.spec["k8sContext"].as_str().map(String::from);
        let opts = Opts { prompt, read_only, k8s: k8s.as_deref(), session: session.as_deref() };
        let mut cmd = Command::new(self.spec["bin"].as_str().unwrap_or(""));
        cmd.args(self.agent.args(opts)).envs(self.agent.env(opts)).env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = self.spec["cwd"].as_str() { cmd.current_dir(cwd); }
        // its own session, like Node's detached: one kill takes the agent and its tools down
        unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
        let stderr = Arc::new(Mutex::new(String::new()));
        let keep = |s: &mut String| { let t = adapters::last16(s, 4000).to_string(); *s = t; };
        let code = match cmd.spawn() {
            Err(e) => {
                self.emit(&json!({ "t": "start" }));
                stderr.lock().unwrap().push_str(&e.to_string());
                Some(-e.raw_os_error().unwrap_or(1))
            }
            Ok(mut child) => {
                CHILD.store(child.id() as i32, Ordering::SeqCst);
                self.emit(&json!({ "t": "start", "pid": child.id() }));
                let mut err_pipe = child.stderr.take().unwrap();
                let err = stderr.clone();
                let errs = std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    while let Ok(n) = err_pipe.read(&mut buf) { if n == 0 { break; } let mut s = err.lock().unwrap(); s.push_str(&String::from_utf8_lossy(&buf[..n])); keep(&mut s); }
                });
                let mut out = child.stdout.take().unwrap();
                let (mut buf, mut line) = ([0u8; 65536], Vec::<u8>::new());
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 { break; }
                    let _ = self.raw.write_all(&buf[..n]);
                    line.extend_from_slice(&buf[..n]);
                    while let Some(i) = line.iter().position(|b| *b == b'\n') {
                        let l: Vec<u8> = line.drain(..=i).collect();
                        let Ok(e) = serde_json::from_str::<Value>(String::from_utf8_lossy(&l).trim()) else { continue }; // banners, warnings
                        for m in reducer.push(&e) {
                            if m["t"] == "session" { if m["id"].as_str() == sid.as_deref() { continue; } sid = m["id"].as_str().map(String::from); }
                            self.emit(&m);
                            self.print(&m);
                        }
                    }
                }
                let _ = errs.join();
                child.wait().ok().and_then(|s| s.code())
            }
        };
        let stopped = STOPPED.load(Ordering::SeqCst);
        let ms = started.elapsed().as_millis() as u64;
        for mut m in reducer.finish(if stopped { Some(130) } else { code }, &stderr.lock().unwrap(), ms) {
            if m["t"] == "done" && stopped { m["ok"] = json!(false); m["error"] = json!("Stopped"); }
            self.emit(&m);
            self.print(&m);
        }
        CHILD.store(0, Ordering::SeqCst);
        sid
    }
}

/// tmux kill-session sends SIGHUP: take the agent down with us.
/// ⌃C mid-turn stops the agent; while waiting it closes; once resumed it's the agent's key.
/// The handler only writes the signal to a pipe (async-signal-safe); a thread acts on it.
/// Caught signals go back to default in children (exec resets them).
static SIG_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let b = sig as u8;
    unsafe { libc::write(SIG_PIPE.load(Ordering::Relaxed), (&b as *const u8).cast(), 1); }
}

fn watch_signals() {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return; }
    SIG_PIPE.store(fds[1], Ordering::SeqCst);
    for s in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
        let mut sa: libc::sigaction = unsafe { std::mem::zeroed() };
        sa.sa_sigaction = on_signal as *const () as usize;
        sa.sa_flags = libc::SA_RESTART;
        unsafe { libc::sigaction(s, &sa, std::ptr::null_mut()); }
    }
    let r = fds[0];
    std::thread::spawn(move || loop {
        let mut b = 0u8;
        if unsafe { libc::read(r, (&mut b as *mut u8).cast(), 1) } != 1 { continue; }
        let sig = b as libc::c_int;
        if sig == libc::SIGINT && PHASE.load(Ordering::SeqCst) == RESUMED { continue; }
        let pid = CHILD.load(Ordering::SeqCst);
        if pid == 0 { std::process::exit(0); }
        STOPPED.store(true, Ordering::SeqCst);
        unsafe { libc::kill(-pid, libc::SIGTERM); }
        if sig != libc::SIGINT { std::thread::sleep(Duration::from_millis(300)); std::process::exit(0); }
    });
}

/// A key on the terminal within `ms`. False on timeout; `eof` is set once stdin is closed.
fn key(ms: i32, eof: &mut bool) -> bool {
    if *eof { std::thread::sleep(Duration::from_millis(ms as u64)); return false; }
    let mut p = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
    if unsafe { libc::poll(&mut p, 1, ms) } <= 0 { return false; }
    let mut b = [0u8; 256];
    match unsafe { libc::read(0, b.as_mut_ptr().cast(), b.len()) } { n if n > 0 => true, _ => { *eof = true; false } }
}

pub fn main(dir: &str) {
    watch_signals();
    let dir = PathBuf::from(dir);
    let spec: Value = match std::fs::read_to_string(dir.join("spec.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
        Ok(s) => s,
        Err(e) => { eprintln!("Can't read {}: {e}", dir.join("spec.json").display()); std::process::exit(1); }
    };
    let Some(agent) = adapters::agent(spec["agent"].as_str().unwrap_or("")) else { eprintln!("Unknown agent {}", spec["agent"]); std::process::exit(1) };
    let raw = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("raw.jsonl")).expect("raw.jsonl");
    let mut run = Run { dir: dir.clone(), spec: spec.clone(), agent, raw };
    let events = dir.join("events.jsonl");
    let inbox = dir.join("inbox.jsonl");

    let past = read_lines(&events);
    let mut session = past.iter().rfind(|e| e["t"] == "session").and_then(|e| e["id"].as_str()).filter(|s| !s.is_empty()).map(String::from);
    let ro = adapters::truthy(&spec["readOnly"]);
    say(&format!("{BOLD}{}{RESET} {DIM}· {} · {}{RESET}", agent.label, if ro { "read-only" } else { "full access" }, spec["cwd"].as_str().unwrap_or("")));
    say(&format!("{DIM}{}{RESET}\n", spec["request"].as_str().unwrap_or("")));
    if past.is_empty() { session = run.turn(spec["prompt"].as_str().unwrap_or(""), ro, None); } else { past.iter().for_each(|m| run.print(m)); }

    // replies arrive in the inbox; every line past the ones already answered is new
    let mut answered = past.iter().filter(|e| e["t"] == "user").count();
    let (mut offered, mut offers, mut eof) = (false, 0, false);
    while let Some(sid) = session.clone() {
        if STOPPED.load(Ordering::SeqCst) { break; }
        PHASE.store(WAITING, Ordering::SeqCst);
        let Some(next) = read_lines(&inbox).get(answered).cloned() else {
            if !offered {
                offered = true;
                // keys pressed during a turn don't count (Node dropped them once it was listening)
                if offers > 0 { unsafe { libc::tcflush(0, libc::TCIFLUSH); } }
                offers += 1;
                say(&format!("\n{BOLD}↵{RESET} keep talking to {} here, or reply in DevDock   {DIM}⌃C close{RESET}", agent.label));
            }
            // Enter here hands the conversation to the agent's own interactive UI
            if key(400, &mut eof) && PHASE.load(Ordering::SeqCst) == WAITING {
                PHASE.store(RESUMED, Ordering::SeqCst);
                run.emit(&json!({ "t": "resumed" }));
                let mut c = Command::new(spec["bin"].as_str().unwrap_or(""));
                c.args(agent.resume(&sid)).env_remove("ELECTRON_RUN_AS_NODE");
                if let Some(cwd) = spec["cwd"].as_str() { c.current_dir(cwd); }
                let _ = c.status();
                std::process::exit(0);
            }
            continue;
        };
        answered += 1;
        PHASE.store(RUNNING, Ordering::SeqCst);
        let r = adapters::truthy(&next["readOnly"]);
        let m = json!({ "t": "user", "text": next["text"], "readOnly": r });
        run.emit(&m);
        run.print(&m);
        session = run.turn(next["prompt"].as_str().unwrap_or(""), r, Some(sid.clone())).or(Some(sid));
        offered = false;
    }
    let _ = run.raw.flush();
    std::thread::sleep(Duration::from_millis(100));
    std::process::exit(0);
}

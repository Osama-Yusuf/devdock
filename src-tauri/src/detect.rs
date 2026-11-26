//! Which agent or app a process is, from its name; and what the repo it runs in is.
use crate::util::{basename, dirname, home};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const AGENTS: &[(&str, &str)] = &[
    ("claude", "Claude Code"), ("codex", "Codex"), ("gemini", "Gemini CLI"), ("aider", "Aider"),
    ("opencode", "opencode"), ("cursor-agent", "Cursor Agent"), ("amp", "Amp"), ("goose", "Goose"),
    ("droid", "Droid"), ("crush", "Crush"), ("qwen", "Qwen Code"), ("kiro", "Kiro"),
];

/// Outermost bundle wins: ".../Visual Studio Code.app/.../Code Helper.app/..." -> "Visual Studio Code"
pub fn app_from_path(p: &str) -> Option<&str> {
    let i = p.find(".app/")?;
    let start = p[..i].rfind('/')? + 1;
    (start < i).then(|| &p[start..i])
}

fn versionish(s: &str) -> bool {
    let mut parts = s.split('.');
    let first = parts.next().unwrap_or("");
    let rest: Vec<_> = parts.collect();
    !first.is_empty() && first.bytes().all(|b| b.is_ascii_digit()) && !rest.is_empty()
        && rest.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Agent name for a process's name, or None. A path is the whole name (it can hold spaces:
/// ".../Application Support/Claude/claude-code/..."); a retitled process is its first word
/// ("claude bg-pty-host"). ".../claude/versions/2.1.322" -> "claude"
pub fn agent_of(comm: &str) -> Option<&'static str> {
    let c = if comm.starts_with('/') { comm } else { comm.split(' ').next().unwrap_or("") };
    let mut base = basename(c).to_lowercase();
    if versionish(&base) { base = basename(dirname(dirname(c))).to_lowercase(); }
    AGENTS.iter().find(|(k, _)| *k == base).map(|(_, v)| *v)
}

// ── git ─────────────────────────────────────────────────────────────
/// .git dir for the repo containing dir (worktrees: .git is a file pointing at the real gitdir)
pub fn git_dir(dir: &str) -> Option<PathBuf> {
    let mut d = Path::new(dir);
    loop {
        if d == Path::new("/") || d.as_os_str().is_empty() { return None; }
        let dot = d.join(".git");
        if let Ok(m) = std::fs::metadata(&dot) {
            if m.is_file() {
                let text = std::fs::read_to_string(&dot).ok()?;
                let target = text.trim().trim_start_matches("gitdir:").trim();
                return Some(d.join(target));
            }
            return Some(dot);
        }
        d = d.parent()?;
    }
}

pub fn git_branch(dir: &str) -> Option<String> {
    let head = std::fs::read_to_string(git_dir(dir)?.join("HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") { Some(b) => b.to_string(), None => head.chars().take(7).collect() })
}

/// https://github.com/owner/repo for the origin remote, or None if it isn't on GitHub
pub fn github_url(dir: &str) -> Option<String> {
    let mut g = git_dir(dir)?;
    if let Ok(common) = std::fs::read_to_string(g.join("commondir")) { g = g.join(common.trim()); } // worktrees keep config in the main repo
    let config = std::fs::read_to_string(g.join("config")).ok()?;
    let start = config.find("[remote \"origin\"]")?;
    let section = &config[start + 17..];
    let section = &section[..section.find('[').unwrap_or(section.len())];
    let url = section.lines().find_map(|l| { let (k, v) = l.split_once('=')?; (k.trim() == "url").then(|| v.trim().to_string()) })?;
    let i = url.find("github.com")? + 10;
    let rest = url[i..].trim_start_matches([':', '/']);
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty()).then(|| format!("https://github.com/{owner}/{repo}"))
}

// ── Claude Code's own state ─────────────────────────────────────────
// What a Claude Code session is doing. Two sources Claude Code writes itself (checked live, v2.1.322):
//   ~/.claude/sessions/<pid>.json   status from the agent loop: running -> "busy",
//     requires_action -> "waiting" (a permission prompt or a question), idle -> "idle",
//     "shell" = idle with a background shell still running. Not always rewritten: a
//     session can keep saying "busy" for days after its last turn ended.
//   ~/.claude/projects/<cwd with non-alphanumerics as ->/<sessionId>.jsonl   the transcript.
//     Its last turn event says idle (turn_duration, stop_hook_summary, end_turn) or working
//     (a prompt, a tool call or result, an API request). Other lines get appended while idle.
// Whichever changed last wins; only the status file knows about prompts waiting on you.
#[derive(Debug, PartialEq)]
pub enum Turn { Next(String), Status(&'static str, i64) }

fn parse_ts(s: &str) -> Option<i64> {
    // RFC 3339 with milliseconds, like 2026-11-24T08:13:40.605Z
    let b = s.as_bytes();
    if b.len() < 19 { return None; }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut ms = 0i64;
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        rest = &frac[digits.len()..];
        ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
    }
    let offset = match rest.chars().next() {
        Some('Z') | None => 0,
        Some(c @ ('+' | '-')) => { let h: i64 = rest.get(1..3)?.parse().ok()?; let m: i64 = rest.get(4..6)?.parse().ok()?; (h * 60 + m) * if c == '+' { 1 } else { -1 } }
        _ => return None,
    };
    // days from civil (Howard Hinnant)
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) - offset * 60) * 1000 + ms)
}
pub fn parse_time(s: &str) -> Option<i64> { parse_ts(s) }

/// The last turn event of a transcript (its last 256 KB)
pub fn last_turn_event(file: &Path) -> Option<Turn> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(256 * 1024);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    for line in text.split('\n').rev() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue }; // the first line is usually cut
        let t = e["type"].as_str().unwrap_or("");
        if t == "continued-in" { if let Some(n) = e["continuedInSessionId"].as_str() { return Some(Turn::Next(n.to_string())); } }
        let Some(at) = e["timestamp"].as_str().and_then(parse_ts) else { continue };
        let sub = e["subtype"].as_str().unwrap_or("");
        if t == "system" && (sub == "turn_duration" || sub == "stop_hook_summary") { return Some(Turn::Status("idle", at)); }
        if t == "assistant" { return Some(Turn::Status(if e["message"]["stop_reason"] == "end_turn" { "idle" } else { "working" }, at)); }
        if t == "user" || t == "api-request" { return Some(Turn::Status("working", at)); }
    }
    None
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
struct Cached { mtime: i64, d: Value, sid: Option<String>, key: String, state: Value }

/// Caches each session's status file and transcript tail by mtime and size
#[derive(Default)]
pub struct ClaudeStates { cache: Mutex<HashMap<i32, Cached>>, root: Option<PathBuf> }

impl ClaudeStates {
    #[cfg(test)]
    pub fn at(root: PathBuf) -> Self { ClaudeStates { cache: Default::default(), root: Some(root) } }

    /// { status: working | needs-you | idle, since, bgShell, name } or Null
    pub fn state(&self, pid: i32) -> Value {
        let root = self.root.clone().unwrap_or_else(|| home().join(".claude"));
        let f = root.join("sessions").join(format!("{pid}.json"));
        let mut cache = self.cache.lock().unwrap();
        let Ok(st) = std::fs::metadata(&f) else { cache.remove(&pid); return Value::Null };
        // mtime and size: two writes in the same millisecond still differ in size
        let mtime = mtime_ms(&st) ^ ((st.len() as i64) << 44);
        let hit = cache.remove(&pid);
        let fresh_d = !matches!(&hit, Some(h) if h.mtime == mtime);
        let d: Value = if fresh_d { std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})) } else { hit.as_ref().unwrap().d.clone() };
        // a /clear or compaction continues the session in a new transcript; follow the chain
        let dir = d["cwd"].as_str().map(|cwd| root.join("projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>()));
        let mut sid = match (&hit, fresh_d) { (Some(h), false) => h.sid.clone(), _ => None }.or_else(|| d["sessionId"].as_str().map(String::from));
        let mut turn = None;
        let mut tst: Option<std::fs::Metadata> = None;
        if let Some(dir) = &dir {
            for _ in 0..20 {
                let Some(s) = sid.clone() else { break };
                let t = dir.join(format!("{s}.jsonl"));
                tst = std::fs::metadata(&t).ok();
                let Some(m) = &tst else { break };
                let key = format!("{mtime}|{}|{}", mtime_ms(m), m.len());
                if let Some(h) = &hit { if h.sid.as_deref() == Some(&s) && h.key == key {
                    let state = h.state.clone();
                    cache.insert(pid, Cached { mtime, d, sid: Some(s), key, state: state.clone() });
                    return state;
                } }
                turn = last_turn_event(&t);
                match &turn { Some(Turn::Next(n)) => { sid = Some(n.clone()); turn = None; } _ => break }
            }
        }
        let key = match &tst { Some(m) => format!("{mtime}|{}|{}", mtime_ms(m), m.len()), None => format!("{mtime}|undefined|undefined") };
        let status = d["status"].as_str().unwrap_or("");
        let file_status = match status { "busy" => Some("working"), "waiting" => Some("needs-you"), "idle" | "shell" => Some("idle"), _ => None };
        let file_at = d["statusUpdatedAt"].as_i64().or_else(|| d["updatedAt"].as_i64()).unwrap_or(0);
        let mut state = match (turn, file_status) {
            (Some(Turn::Status(s, at)), _) if at > file_at + 2000 => json!({ "status": s, "since": at, "bgShell": false }),
            (_, Some(fs)) => json!({ "status": fs, "since": if file_at > 0 { json!(file_at) } else { Value::Null }, "bgShell": status == "shell" }),
            _ => Value::Null,
        };
        if state.is_object() { state["name"] = d.get("name").filter(|v| v.is_string() && v.as_str() != Some("")).cloned().unwrap_or(Value::Null); }
        cache.insert(pid, Cached { mtime, d, sid, key, state: state.clone() });
        state
    }

    /// The session id Claude Code wrote for this pid
    pub fn session_id(&self, pid: i32) -> Option<String> {
        let root = self.root.clone().unwrap_or_else(|| home().join(".claude"));
        let t = std::fs::read_to_string(root.join("sessions").join(format!("{pid}.json"))).ok()?;
        serde_json::from_str::<Value>(&t).ok()?["sessionId"].as_str().map(String::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_of_reads_paths_titles_and_versioned_installs() {
        // the cases test/coding.test.js pinned for the Node version
        assert_eq!(agent_of("/Users/me/Library/Application Support/Claude/claude-code/2.1.331/x/claude.app/Contents/MacOS/claude"), Some("Claude Code"));
        assert_eq!(agent_of("claude bg-pty-host"), Some("Claude Code"));
        assert_eq!(agent_of("/Users/me/.local/share/claude/versions/2.1.322"), Some("Claude Code"));
        assert_eq!(agent_of("/opt/homebrew/bin/codex"), Some("Codex"));
        assert_eq!(agent_of("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), None);
        assert_eq!(agent_of("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"), None);
        assert_eq!(agent_of("node"), None);
        assert_eq!(agent_of(""), None);
    }

    #[test]
    fn app_from_path_takes_the_outermost_bundle() {
        assert_eq!(app_from_path("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/x"), Some("Visual Studio Code"));
        assert_eq!(app_from_path("/usr/bin/node"), None);
        assert_eq!(app_from_path("/x/.app/y"), None);
        assert_eq!(app_from_path("/a/foo.app.bar/x.app/y"), Some("x"));
    }

    #[test]
    fn git_branch_and_github_of_this_repo() {
        let here = env!("CARGO_MANIFEST_DIR");
        let out = std::process::Command::new("git").args(["-C", here, "rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(git_branch(here).unwrap(), String::from_utf8(out.stdout).unwrap().trim());
        assert_eq!(github_url(here).as_deref(), Some("https://github.com/Osama-Yusuf/devdock"));
        assert_eq!(git_branch("/"), None);
    }

    #[test]
    fn github_url_forms() {
        let d = std::env::temp_dir().join(format!("dd-git-{}", std::process::id()));
        std::fs::create_dir_all(d.join(".git")).unwrap();
        for (url, want) in [("git@github.com:me/app.git", Some("https://github.com/me/app")), ("https://github.com/me/app/", Some("https://github.com/me/app")), ("https://gitlab.com/me/app.git", None)] {
            std::fs::write(d.join(".git/config"), format!("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = {url}\n\tfetch = x\n[branch \"main\"]\n")).unwrap();
            assert_eq!(github_url(d.to_str().unwrap()).as_deref(), want, "{url}");
        }
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_ts("2026-11-24T08:13:40.605Z"), Some(1795508020605));
        assert_eq!(parse_ts("2026-11-24T10:13:40.605+02:00"), Some(1795508020605));
        assert_eq!(parse_ts("nope"), None);
    }

    #[test]
    fn claude_state_follows_the_newer_signal() {
        let root = std::env::temp_dir().join(format!("dd-claude-{}", std::process::id()));
        let proj = root.join("projects/-tmp-app");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let s = ClaudeStates::at(root.clone());
        assert_eq!(s.state(42), Value::Null);
        // the status file says busy; the transcript ended a turn later: idle wins
        std::fs::write(root.join("sessions/42.json"), r#"{"cwd":"/tmp/app","sessionId":"a","status":"busy","updatedAt":1000,"name":"fix"}"#).unwrap();
        std::fs::write(proj.join("a.jsonl"), "{cut\n{\"type\":\"user\",\"timestamp\":\"1970-01-01T00:00:05Z\"}\n{\"type\":\"system\",\"subtype\":\"turn_duration\",\"timestamp\":\"1970-01-01T00:00:09Z\"}\n").unwrap();
        assert_eq!(s.state(42), json!({ "status": "idle", "since": 9000, "bgShell": false, "name": "fix" }));
        // a /clear continued it in transcript b, which is mid-turn
        std::fs::write(proj.join("a.jsonl"), "{\"type\":\"continued-in\",\"continuedInSessionId\":\"b\"}\n").unwrap();
        std::fs::write(proj.join("b.jsonl"), "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"},\"timestamp\":\"1970-01-01T00:00:20Z\"}\n").unwrap();
        assert_eq!(s.state(42)["status"], "working");
        // a permission prompt, written after the transcript's last event
        std::fs::write(root.join("sessions/42.json"), r#"{"cwd":"/tmp/app","sessionId":"a","status":"waiting","statusUpdatedAt":30000}"#).unwrap();
        assert_eq!(s.state(42), json!({ "status": "needs-you", "since": 30000, "bgShell": false, "name": null }));
        assert_eq!(s.session_id(42).as_deref(), Some("a"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

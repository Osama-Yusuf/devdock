//! Small things every part uses: running a command, finding a binary, errors the API returns.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub fn home() -> PathBuf {
    static H: OnceLock<PathBuf> = OnceLock::new();
    H.get_or_init(|| std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))).clone()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Apps opened from Finder get a bare PATH without Homebrew, so look in the usual places first
pub fn bin_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].iter().map(PathBuf::from).collect();
    dirs.push(h.join(".local/bin"));
    dirs.push(h.join(".cargo/bin"));
    dirs
}

pub fn search_path() -> String {
    let mut parts: Vec<String> = bin_dirs().iter().map(|d| d.to_string_lossy().into_owned()).collect();
    for p in std::env::var("PATH").unwrap_or_default().split(':').chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
        if !p.is_empty() && !parts.iter().any(|x| x == p) { parts.push(p.to_string()); }
    }
    parts.join(":")
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub fn find_bin(name: &str) -> Option<String> {
    search_path().split(':').map(|d| Path::new(d).join(name)).find(|p| executable(p)).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Default)]
pub struct Out { pub code: i32, pub stdout: String, pub stderr: String }

/// Run a command and wait, never failing: CLIs report "nothing here" through exit codes.
/// A timeout kills it and reads as code -1.
pub async fn run(file: &str, args: &[&str], timeout: Duration) -> Out {
    run_env(file, args, timeout, &[]).await
}

pub async fn run_env(file: &str, args: &[&str], timeout: Duration, env: &[(&str, &str)]) -> Out {
    let mut cmd = tokio::process::Command::new(file);
    cmd.args(args).env("PATH", search_path()).kill_on_drop(true).stdin(std::process::Stdio::null());
    for (k, v) in env { cmd.env(k, v); }
    // dropping the future on timeout kills the child (kill_on_drop)
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(o)) => Out {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Ok(Err(e)) => Out { code: -1, stdout: String::new(), stderr: e.to_string() },
        Err(_) => Out { code: -1, stdout: String::new(), stderr: "timed out".into() },
    }
}

pub const SEC: Duration = Duration::from_secs(1);
pub fn secs(n: u64) -> Duration { Duration::from_secs(n) }

/// An error the API answers with: { error } and this status
#[derive(Debug, Clone)]
pub struct ApiErr { pub status: u16, pub msg: String }

impl ApiErr {
    pub fn new(status: u16, msg: impl Into<String>) -> Self { ApiErr { status, msg: msg.into() } }
    pub fn bad(msg: impl Into<String>) -> Self { Self::new(400, msg) }
    pub fn gone(msg: impl Into<String>) -> Self { Self::new(404, msg) }
}
impl std::fmt::Display for ApiErr {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str(&self.msg) }
}
pub type ApiResult<T = serde_json::Value> = Result<T, ApiErr>;

/// Single-quote for a POSIX shell
pub fn shq(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

pub fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or(t)
}

pub fn dirname(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    match t.rfind('/') { Some(0) => "/", Some(i) => &t[..i], None => "." }
}

/// Value helpers for the JSON the page sends: missing or the wrong type reads as empty
pub trait Get {
    fn str_of(&self, k: &str) -> &str;
    fn bool_of(&self, k: &str) -> bool;
    fn f64_of(&self, k: &str) -> f64;
}
impl Get for serde_json::Value {
    fn str_of(&self, k: &str) -> &str { self.get(k).and_then(|v| v.as_str()).unwrap_or("") }
    fn bool_of(&self, k: &str) -> bool { self.get(k).and_then(|v| v.as_bool()).unwrap_or(false) }
    fn f64_of(&self, k: &str) -> f64 { self.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) }
}

/// A pid the page sent, as a number or a string of digits
pub fn pid_of(v: &serde_json::Value) -> Option<i32> {
    match v {
        serde_json::Value::Number(n) => n.as_i64().and_then(|x| i32::try_from(x).ok()).filter(|x| *x > 0),
        serde_json::Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok().filter(|x: &i32| *x > 0),
        _ => None,
    }
}

pub fn round1(x: f64) -> f64 { (x * 10.0).round() / 10.0 }

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn run_reports_code_output_and_timeouts() {
        let o = run("/bin/sh", &["-c", "echo hi; echo err >&2; exit 3"], SEC).await;
        assert_eq!((o.code, o.stdout.as_str(), o.stderr.as_str()), (3, "hi\n", "err\n"));
        let t = std::time::Instant::now();
        let o = run("/bin/sleep", &["5"], Duration::from_millis(200)).await;
        assert_eq!(o.code, -1);
        assert!(t.elapsed() < SEC);
        assert_eq!(run("/nope/missing", &[], SEC).await.code, -1);
    }
    #[test]
    fn paths_and_quotes() {
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("x"), "x");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(shq("it's"), "'it'\\''s'");
        assert!(find_bin("sh").is_some());
        assert_eq!(pid_of(&serde_json::json!("12")), Some(12));
        assert_eq!(pid_of(&serde_json::json!("1; rm")), None);
        assert_eq!(pid_of(&serde_json::json!(-3)), None);
    }
}

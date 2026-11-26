//! Running Mac apps: windowed apps, menu bar apps (Bartender, Raycast...) and background
//! agents, each with every process it's responsible for.
//!
//! `lsappinfo list` (checked live, macOS 27) prints one block per app:
//!    4) "Google Chrome" ASN:0x0-0x10010: (in front)
//!       bundleID="com.google.Chrome"
//!       bundle path="/Applications/Google Chrome.app"
//!       executable path=".../MacOS/Google Chrome"
//!       pid = 703 token=[...] type="Foreground" flavor=3 Version="8037.93" ... Arch=ARM64
//!       coalition: 766  { 1059 1476 ... }      <- helpers, XPC services, what it launched
//!       launch time =  2026/10/02 03:57:09 ( ... )
//! type: Foreground (Dock icon), UIElement (menu bar or agent), BackgroundOnly.
//! The coalition is what groups an app's processes, and only lsappinfo shows it, so it stays
//! (one 40ms spawn per scan while the page is open). Info.plist may be binary: plutil reads it,
//! once per bundle. Quit is the Apple Event an app gets from the Dock, so it can ask to save;
//! macOS asks once per app whether DevDock may send it. Force quit is SIGKILL.
use crate::state::Ctx;
use crate::util::{basename, home, pid_of, round1, run, secs, ApiErr, ApiResult};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Listed {
    pub name: String,
    pub pid: String,
    pub kind: &'static str,
    pub bundle_id: Option<String>,
    pub path: Option<String>,
    pub build: Option<String>,
    pub arch: Option<String>,
    pub front: bool,
    pub launched_at: Option<i64>,
    pub coalition: Vec<String>,
}

/// What doesn't change while an app runs: read once per bundle
#[derive(Debug, Clone, Default)]
struct Info { version: Option<String>, icon: Option<String>, electron: bool }

#[derive(Default)]
pub struct Apps {
    last: Mutex<Vec<Value>>,
    plist: Mutex<HashMap<String, Info>>,
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex { cell.get_or_init(|| Regex::new(pat).unwrap()) }

/// Local time "2026/10/02 03:57:09" as ms since the epoch
fn local_ms(y: i32, mo: i32, d: i32, hms: &str) -> Option<i64> {
    let t: Vec<i32> = hms.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = y - 1900;
    tm.tm_mon = mo - 1;
    tm.tm_mday = d;
    tm.tm_hour = *t.first()?;
    tm.tm_min = *t.get(1).unwrap_or(&0);
    tm.tm_sec = *t.get(2).unwrap_or(&0);
    tm.tm_isdst = -1;
    let s = unsafe { libc::mktime(&mut tm) };
    (s != -1).then_some(s as i64 * 1000)
}

pub fn parse(out: &str) -> Vec<Listed> {
    static START: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    static PID: OnceLock<Regex> = OnceLock::new();
    static TYPE: OnceLock<Regex> = OnceLock::new();
    static ARCH: OnceLock<Regex> = OnceLock::new();
    static FRONT: OnceLock<Regex> = OnceLock::new();
    static LAUNCH: OnceLock<Regex> = OnceLock::new();
    static COAL: OnceLock<Regex> = OnceLock::new();
    let start = re(&START, r#"^\s*\d+\) ""#);
    // one block per app, each starting at its "N) "name"" line
    let mut blocks: Vec<String> = vec![];
    for l in out.split('\n') {
        if start.is_match(l) || blocks.is_empty() { blocks.push(l.to_string()); } else { let b = blocks.last_mut().unwrap(); b.push('\n'); b.push_str(l); }
    }
    let mut apps = vec![];
    for block in &blocks {
        let cap = |r: &Regex| r.captures(block).map(|c| c[1].to_string());
        let (Some(name), Some(pid), Some(ty)) = (
            re(&NAME, r#"^\s*\d+\) "(.*)" ASN:"#).captures(block.lines().next().unwrap_or("")).map(|c| c[1].to_string()),
            cap(re(&PID, r"\bpid = (\d+)")),
            cap(re(&TYPE, r#"\btype="(\w+)""#)),
        ) else { continue };
        let kind = match ty.as_str() { "Foreground" => "app", "UIElement" => "menu", "BackgroundOnly" => "background", _ => continue };
        let q = |k: &str| block.find(&format!("{k}=\"")).and_then(|i| {
            let v = &block[i + k.len() + 2..];
            v.find('"').map(|j| v[..j].to_string())
        }).filter(|v| !v.is_empty());
        let launched_at = re(&LAUNCH, r"launch time =\s+(\d{4})/(\d\d)/(\d\d) ([\d:]+)").captures(block)
            .and_then(|c| local_ms(c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?, &c[4]));
        apps.push(Listed {
            name, pid, kind,
            bundle_id: q("bundleID"), path: q("bundle path"), build: q("Version"),
            arch: cap(re(&ARCH, r"Arch=(\S+)")),
            front: re(&FRONT, r"ASN:\S+ \(in front\)").is_match(block),
            launched_at,
            coalition: re(&COAL, r"coalition: \d+\s+\{([\d\s]+)\}").captures(block)
                .map(|c| c[1].split_whitespace().map(String::from).collect()).unwrap_or_default(),
        });
    }
    apps
}

fn system(path: Option<&str>, bundle_id: Option<&str>) -> bool {
    let Some(p) = path else { return true };
    ["/System/", "/usr/", "/Library/Apple/"].iter().any(|x| p.starts_with(x))
        || (p.starts_with("/Library/") && bundle_id.is_some_and(|b| b.starts_with("com.apple.")))
}

/// DevDock itself: never quit or killed from its own list
fn me(pid: &str) -> bool { pid == std::process::id().to_string() || pid == unsafe { libc::getppid() }.to_string() }

fn bad(msg: impl Into<String>) -> ApiErr { ApiErr::bad(msg) }

/// kill(2): a process that's already gone counts as stopped
fn signal(pid: i32, sig: i32) -> ApiResult<()> {
    if unsafe { libc::kill(pid, sig) } == 0 { return Ok(()); }
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        Some(libc::EPERM) => Err(bad("macOS won't let DevDock stop that process")),
        _ => Err(bad(e.to_string())),
    }
}

fn gone(pid: i32) -> bool { (unsafe { libc::kill(pid, 0) }) != 0 }

fn s(v: &Value, k: &str) -> Option<String> { v[k].as_str().map(String::from) }

/// The pid the page sent, as the string the list uses
fn pid_param(p: &Value) -> String { pid_of(&p["pid"]).map(|x| x.to_string()).unwrap_or_default() }

impl Apps {
    async fn bundle_info(&self, p: Option<&str>) -> Info {
        let Some(p) = p.filter(|p| p.ends_with(".app")) else { return Info::default() };
        if let Some(i) = self.plist.lock().unwrap().get(p) { return i.clone(); }
        let plist = format!("{p}/Contents/Info.plist");
        let r = run("/usr/bin/plutil", &["-convert", "json", "-o", "-", &plist], secs(10)).await;
        let d: Value = serde_json::from_str(&r.stdout).unwrap_or(json!({}));
        let icon = d["CFBundleIconFile"].as_str().filter(|x| !x.is_empty()).map(|f| {
            format!("{p}/Contents/Resources/{}", if f.ends_with(".icns") { f.to_string() } else { format!("{f}.icns") })
        }).filter(|f| Path::new(f).exists());
        let info = Info {
            version: s(&d, "CFBundleShortVersionString").filter(|v| !v.is_empty()),
            icon,
            electron: Path::new(p).join("Contents/Frameworks/Electron Framework.framework").exists(),
        };
        self.plist.lock().unwrap().insert(p.to_string(), info.clone());
        info
    }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { // real bundles, so the icons are real
            let mut apps = crate::demo::get("apps")["apps"].as_array().cloned().unwrap_or_default();
            for a in &mut apps { a["hasIcon"] = json!(self.bundle_info(a["path"].as_str()).await.icon.is_some()); }
            *self.last.lock().unwrap() = apps.clone();
            return Ok(json!({ "apps": apps }));
        }
        let r = run("/usr/bin/lsappinfo", &["list"], secs(10)).await;
        let t = c.table();
        let ports = c.ports();
        let home = home().to_string_lossy().into_owned();
        let num = |pid: &str| pid.parse::<i32>().ok();
        let listed: Vec<Listed> = parse(&r.stdout).into_iter().filter(|a| num(&a.pid).is_some_and(|p| t.contains_key(&p))).collect();
        // a helper app inside another app's bundle (Google Chrome Helper) belongs to that app
        let parent = |i: usize| -> Option<usize> {
            let p = listed[i].path.as_deref()?;
            listed.iter().enumerate().find(|(j, b)| *j != i && b.path.as_deref().is_some_and(|bp| p.starts_with(&format!("{bp}/")))).map(|(j, _)| j)
        };
        let parents: Vec<Option<usize>> = (0..listed.len()).map(parent).collect();
        let mut out = vec![];
        for (i, a) in listed.iter().enumerate().filter(|(i, _)| parents[*i].is_none()) {
            let info = self.bundle_info(a.path.as_deref()).await;
            // its own processes live inside its bundle; the rest of the coalition it launched (a terminal's shells)
            let helpers = listed.iter().enumerate().filter(|(j, _)| parents[*j] == Some(i)).flat_map(|(_, h)| std::iter::once(&h.pid).chain(&h.coalition));
            let mut pids: Vec<String> = vec![];
            for pid in std::iter::once(&a.pid).chain(&a.coalition).chain(helpers) {
                if !pids.contains(pid) && num(pid).is_some_and(|p| t.contains_key(&p)) { pids.push(pid.clone()); }
            }
            let proc = |pid: &str| &t[&num(pid).unwrap()];
            let own: HashSet<&str> = pids.iter().map(String::as_str)
                .filter(|pid| *pid == a.pid || a.path.as_deref().is_some_and(|ap| proc(pid).comm.starts_with(ap))).collect();
            let mut processes: Vec<(bool, bool, f64, Value)> = pids.iter().map(|pid| {
                let p = proc(pid);
                (*pid == a.pid, own.contains(pid.as_str()), p.mem_mb,
                 json!({ "pid": pid, "name": basename(&p.comm), "own": own.contains(pid.as_str()), "cpu": p.cpu, "memMB": p.mem_mb, "startedAt": p.started_at }))
            }).collect();
            processes.sort_by(|x, y| y.0.cmp(&x.0).then(y.1.cmp(&x.1)).then(y.2.partial_cmp(&x.2).unwrap_or(std::cmp::Ordering::Equal)));
            let sum = |f: fn(&crate::table::Proc) -> f64| round1(own.iter().map(|pid| f(proc(pid))).sum());
            let mut ps: Vec<u64> = ports.iter().filter(|p| p["pid"].as_str().is_some_and(|x| own.contains(x))).filter_map(|p| p["port"].as_u64()).collect();
            ps.sort();
            ps.dedup();
            out.push(json!({
                "name": a.name, "pid": a.pid, "kind": a.kind, "bundleId": a.bundle_id, "path": a.path, "build": a.build,
                "arch": a.arch, "front": a.front, "launchedAt": a.launched_at,
                "version": info.version.or_else(|| a.build.clone()), "electron": info.electron, "hasIcon": info.icon.is_some(),
                "system": system(a.path.as_deref(), a.bundle_id.as_deref()),
                "user": a.path.as_deref().is_some_and(|p| p.starts_with(&home)),
                "cpu": sum(|p| p.cpu), "memMB": sum(|p| p.mem_mb),
                "processes": processes.into_iter().map(|x| x.3).collect::<Vec<_>>(),
                "ports": ps,
            }));
        }
        *self.last.lock().unwrap() = out.clone();
        Ok(json!({ "apps": out }))
    }

    // the list may be older than what was clicked: rescan once before saying it's gone
    async fn fresh<T>(&self, c: &Ctx, test: impl Fn(&[Value]) -> Option<T>) -> Option<T> {
        if let Some(x) = test(&self.last.lock().unwrap()) { return Some(x); }
        let _ = self.scan(c).await;
        test(&self.last.lock().unwrap())
    }

    /// Only apps from the latest scan
    async fn app(&self, c: &Ctx, pid: &str) -> ApiResult<Value> {
        self.fresh(c, |l| l.iter().find(|a| a["pid"] == json!(pid)).cloned()).await.ok_or_else(|| ApiErr::gone("That app is gone"))
    }

    async fn quit(&self, a: &Value) -> ApiResult<()> {
        let pid = a["pid"].as_str().unwrap_or("");
        if me(pid) { return Err(bad("That's DevDock itself")); }
        let n: i32 = pid.parse().map_err(|_| bad("Invalid PID"))?;
        let Some(bundle) = a["bundleId"].as_str() else { return signal(n, libc::SIGTERM) };
        let r = run("/usr/bin/osascript", &["-e", "on run argv", "-e", "tell application id (item 1 of argv) to quit", "-e", "end run", bundle], secs(8)).await;
        if r.code == 0 { return Ok(()); }
        let name = a["name"].as_str().unwrap_or("");
        // -1743: the user said no to DevDock controlling it; -128: it asked to save and was cancelled
        if r.stderr.contains("-1743") { return Err(ApiErr::new(403, format!("DevDock isn't allowed to control {name}. Allow it in System Settings > Privacy & Security > Automation, or force quit."))); }
        if r.stderr.contains("-128") { return Err(ApiErr::new(409, format!("{name} didn't quit"))); }
        signal(n, libc::SIGTERM) // no scripting support: the same as `kill`
    }

    async fn open(a: &Value) {
        let args: Vec<&str> = match a["bundleId"].as_str() { Some(b) => vec!["-b", b], None => vec![a["path"].as_str().unwrap_or("")] };
        let _ = run("/usr/bin/open", &args, secs(10)).await;
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        let pid = pid_param(p);
        match name {
            "quit" => { let a = self.app(c, &pid).await?; self.quit(&a).await?; }
            "forceQuit" => {
                let a = self.app(c, &pid).await?;
                if me(&pid) { return Err(bad("That's DevDock itself")); }
                for x in a["processes"].as_array().into_iter().flatten().filter(|x| x["own"] == json!(true)) {
                    if let Some(n) = x["pid"].as_str().and_then(|s| s.parse().ok()) { signal(n, libc::SIGKILL)?; }
                }
            }
            "kill" => {
                if me(&pid) { return Err(bad("That's DevDock itself")); }
                let known = self.fresh(c, |l| l.iter().any(|a| a["processes"].as_array().is_some_and(|ps| ps.iter().any(|x| x["pid"] == json!(pid)))).then_some(())).await;
                if known.is_none() { return Err(ApiErr::gone("That process is gone")); }
                signal(pid.parse().unwrap(), if p["force"].as_bool().unwrap_or(false) { libc::SIGKILL } else { libc::SIGTERM })?;
            }
            "show" => { let a = self.app(c, &pid).await?; Self::open(&a).await; }
            "reveal" => {
                let a = self.app(c, &pid).await?;
                if let Some(path) = a["path"].as_str() { let _ = run("/usr/bin/open", &["-R", path], secs(10)).await; }
            }
            // quit, wait for it to go, open it again
            "restart" => {
                let a = self.app(c, &pid).await?;
                self.quit(&a).await?;
                let n: i32 = pid.parse().unwrap_or(0);
                for _ in 0..40 { if gone(n) { break; } tokio::time::sleep(std::time::Duration::from_millis(250)).await; }
                if !gone(n) { return Err(ApiErr::new(409, format!("{} is still running", a["name"].as_str().unwrap_or("")))); }
                Self::open(&a).await;
            }
            _ => return Err(crate::sources::unknown()),
        }
        Ok(json!({}))
    }

    /// PNG of an app's icon, for <img>: converted once with sips and kept in tmp
    pub async fn icon(&self, _c: &Ctx, pid: &str) -> Option<PathBuf> {
        let path = self.last.lock().unwrap().iter().find(|a| a["pid"] == json!(pid)).and_then(|a| s(a, "path"))?;
        let src = self.plist.lock().unwrap().get(&path).and_then(|i| i.icon.clone())?;
        use sha2::Digest;
        let hash: String = sha2::Sha256::digest(src.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join("devdock-icons");
        let out = dir.join(format!("{hash}.png"));
        if !out.exists() {
            std::fs::create_dir_all(&dir).ok()?;
            let o = out.to_string_lossy().into_owned();
            if run("/usr/bin/sips", &["-s", "format", "png", "-Z", "64", &src, "--out", &o], secs(10)).await.code != 0 { return None; }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_lsappinfo() {
        let sample = " 4) \"Google Chrome\" ASN:0x0-0x10010: (in front) \n    bundleID=\"com.google.Chrome\"\n    bundle path=\"/Applications/Google Chrome.app\"\n    executable path=\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\"\n    pid = 703 token=[sess=1 pid=9] type=\"Foreground\" flavor=3 Version=\"8037.93\" fileType=\"APPL\" Arch=ARM64 \n    coalition: 766  { 1059 1476 }\n    launch time =  2026/10/02 03:57:09 ( 48 days ago )\n 5) \"universalaccessd\" ASN:0x0-0xb00b: \n    bundleID=[ NULL ] \n    pid = 668 token=[x] type=\"BackgroundOnly\" flavor=3 Version=[ NULL ]  Arch=ARM64 \n 6) \"Weird\" ASN:0x0-0x1: \n    pid = 9 type=\"Unknown\"";
        let v = parse(sample);
        assert_eq!(v.len(), 2);
        let (c, u) = (&v[0], &v[1]);
        assert_eq!((c.name.as_str(), c.pid.as_str(), c.kind, c.bundle_id.as_deref(), c.front, c.arch.as_deref(), c.coalition.clone()),
            ("Google Chrome", "703", "app", Some("com.google.Chrome"), true, Some("ARM64"), vec!["1059".to_string(), "1476".to_string()]));
        assert_eq!(c.build.as_deref(), Some("8037.93"));
        assert_eq!(c.launched_at, local_ms(2026, 10, 2, "03:57:09"));
        assert!(c.launched_at.unwrap() > 1_790_000_000_000);
        assert_eq!((u.kind, u.bundle_id.clone(), u.front, u.coalition.len()), ("background", None, false, 0));
    }
    #[test]
    fn system_apps() {
        assert!(system(None, None));
        assert!(system(Some("/System/Applications/Notes.app"), Some("com.apple.Notes")));
        assert!(system(Some("/Library/Foo.app"), Some("com.apple.x")));
        assert!(!system(Some("/Library/Foo.app"), Some("com.acme.x")));
        assert!(!system(Some("/Applications/Zed.app"), None));
    }
    #[test]
    fn live_list_parses() {
        let out = std::process::Command::new("/usr/bin/lsappinfo").arg("list").output().unwrap();
        let v = parse(&String::from_utf8_lossy(&out.stdout));
        assert!(v.iter().any(|a| a.kind == "app"), "no windowed apps parsed");
        assert!(v.iter().all(|a| a.pid.parse::<i32>().is_ok()));
    }
}

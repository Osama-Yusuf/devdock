//! Machines tab: your servers running devdock-agent (agent/ in this repo).
//!
//! Trust: DevDock has its own P-256 key (made once with the system's openssl). The install
//! command carries its fingerprint and a one-time token. At pairing, the agent proves it
//! holds that token, bound to its own certificate (see agent/identity.go); DevDock keeps
//! that certificate and from then on talks only to it. No passwords, no certificate authority.
//!
//! Everything lives outside the app bundle, so updates keep it (the same files the Node app wrote):
//!   ~/Library/Application Support/DevDock/master-key.pem   (0600)
//!   ~/Library/Application Support/DevDock/machines.json    (0600)
use crate::sources::home::{leak, runaway, Sample, MIN};
use crate::sources::TermSpec;
use crate::state::Ctx;
use crate::util::{find_bin, home, now_ms, run, secs, ApiErr, ApiResult, Get};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub mod pin;

const KEEP: i64 = 15 * 60 * 1000;
// what people compare by eye: the agent prints the same groups when it installs (agent keyCode)
const READY: &str = "devdock-install";
const SCOPES: [&str; 5] = ["system", "processes", "ports", "containers", "actions"];
const COLORS: [&str; 6] = ["#60a5fa", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#22d3ee"];
// Coding agents on a machine: CPU is the only signal, a remote agent has no hooks
const AGENTS: [&str; 7] = ["claude", "codex", "gemini", "aider", "opencode", "amp", "cursor-agent"];

fn action_label(a: &str) -> Option<&'static str> {
    Some(match a {
        "process-stop" | "container-stop" | "stack-stop" => "Stop",
        "process-kill" => "Force quit",
        "container-start" | "stack-start" => "Start",
        "container-restart" | "stack-restart" => "Restart",
        _ => return None,
    })
}

fn bad(msg: impl Into<String>) -> ApiErr { ApiErr::bad(msg) }
fn re(p: &str) -> regex_lite::Regex { regex_lite::Regex::new(p).unwrap() }

pub fn key_code(fp: &str) -> String {
    let s: String = fp.chars().take(16).collect::<String>().to_uppercase();
    s.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

pub fn sha256_hex(b: &[u8]) -> String { Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}
fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    unsafe { libc::arc4random_buf(b.as_mut_ptr() as *mut _, n) };
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ── clean: an agent's snapshot rebuilt from the schema ───────────────
// An agent is only as trustworthy as the server it runs on: numbers become numbers, strings
// become short strings, lists are capped, so nothing a hostile server sends reaches the UI or
// the rules in a shape we didn't expect.

/// JS's Number(x), finite or 0
fn n(x: &Value) -> f64 {
    let v = match x {
        Value::Number(v) => v.as_f64().unwrap_or(0.0),
        Value::Bool(b) => *b as u8 as f64,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 }
            else if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) { i64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(f64::NAN) }
            else if t.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) { t.parse().unwrap_or(f64::NAN) }
            else { f64::NAN }
        }
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 && !a[0].is_object() && !a[0].is_array() => n(&a[0]),
        _ => f64::NAN,
    };
    if v.is_finite() { v } else { 0.0 }
}
/// A number as JS writes it: 12, not 12.0
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) }
}
fn nv(x: &Value) -> Value { num(n(x)) }
fn int(x: &Value) -> f64 { n(x).trunc() }
fn t(x: &Value, max: usize) -> Value { json!(x.as_str().map(|s| s.chars().take(max).collect::<String>()).unwrap_or_default()) }
/// A list of records, capped; anything that isn't a record is dropped
fn l(x: &Value, max: usize, f: impl Fn(&Value) -> Value) -> Value {
    json!(x.as_array().map(|a| a.iter().take(max).filter(|o| o.is_object() || o.is_array()).map(&f).collect::<Vec<_>>()).unwrap_or_default())
}
fn obj(x: &Value) -> Option<&Value> { x.is_object().then_some(x) }

pub fn clean(b: &Value) -> Option<Value> {
    let b = obj(b)?;
    let mut o = Map::new();
    o.insert("version".into(), t(&b["version"], 32));
    o.insert("at".into(), nv(&b["at"]));
    o.insert("uptime".into(), nv(&b["uptime"]));
    o.insert("scope".into(), json!(obj(&b["scope"]).map(|x| ["processes", "ports", "containers", "actions", "terminal"].iter()
        .map(|k| (k.to_string(), json!(x[*k] == json!(true)))).collect::<Map<_, _>>()).unwrap_or_default()));
    if let Some(h) = obj(&b["host"]) {
        o.insert("host".into(), json!({ "hostname": t(&h["hostname"], 64), "os": t(&h["os"], 16), "distro": t(&h["distro"], 64), "distroId": t(&h["distroId"], 16),
            "kernel": t(&h["kernel"], 64), "arch": t(&h["arch"], 16), "cpuModel": t(&h["cpuModel"], 96), "cores": nv(&h["cores"]), "memTotal": nv(&h["memTotal"]),
            "bootTime": nv(&h["bootTime"]), "virt": t(&h["virt"], 16), "model": t(&h["model"], 96), "machineId": t(&h["machineId"], 64) }));
    }
    if let Some(c) = obj(&b["cpu"]) {
        let load: Vec<Value> = c["load"].as_array().map(|a| a.iter().take(3).map(nv).collect()).unwrap_or_default();
        o.insert("cpu".into(), json!({ "usage": nv(&c["usage"]), "load": load }));
    }
    if let Some(m) = obj(&b["mem"]) {
        o.insert("mem".into(), json!({ "total": nv(&m["total"]), "used": nv(&m["used"]), "available": nv(&m["available"]), "swapTotal": nv(&m["swapTotal"]), "swapUsed": nv(&m["swapUsed"]) }));
    }
    o.insert("disks".into(), l(&b["disks"], 32, |d| json!({ "mount": t(&d["mount"], 128), "fs": t(&d["fs"], 32), "total": nv(&d["total"]), "used": nv(&d["used"]) })));
    o.insert("net".into(), l(&b["net"], 32, |i| json!({ "name": t(&i["name"], 32), "rx": nv(&i["rx"]), "tx": nv(&i["tx"]),
        "addrs": i["addrs"].as_array().map(|a| a.iter().take(16).map(|x| t(x, 64)).collect::<Vec<_>>()).unwrap_or_default() })));
    o.insert("processes".into(), l(&b["processes"], 64, |p| json!({ "pid": num(int(&p["pid"])), "name": t(&p["name"], 64), "user": t(&p["user"], 32), "cpu": nv(&p["cpu"]), "mem": nv(&p["mem"]) })));
    o.insert("ports".into(), l(&b["ports"], 256, |p| {
        let mut v = json!({ "port": num(int(&p["port"])), "proto": t(&p["proto"], 8), "name": t(&p["name"], 64) });
        let pid = int(&p["pid"]);
        if pid != 0.0 { v["pid"] = num(pid); }
        v
    }));
    o.insert("containers".into(), l(&b["containers"], 256, |c| json!({ "id": t(&c["id"], 128), "name": t(&c["name"], 128), "image": t(&c["image"], 200),
        "state": json!(t(&c["state"], 16).as_str().unwrap().chars().filter(|x| x.is_ascii_lowercase()).collect::<String>()), "status": t(&c["status"], 64),
        "created": nv(&c["created"]), "project": t(&c["project"], 64), "service": t(&c["service"], 64), "dir": t(&c["dir"], 256),
        "cpu": nv(&c["cpu"]), "mem": nv(&c["mem"]), "limit": nv(&c["limit"]), "rx": nv(&c["rx"]), "tx": nv(&c["tx"]) })));
    o.insert("errors".into(), json!(b["errors"].as_array().map(|a| a.iter().take(16).map(|e| t(e, 200)).collect::<Vec<_>>()).unwrap_or_default()));
    Some(Value::Object(o))
}

// ── Docker over your SSH ─────────────────────────────────────────────
// A shell in a container, or `compose pull && up -d` for a stack. Names and paths come from
// the agent's snapshot, so each is checked against a strict pattern and single-quoted before
// it reaches the remote shell. Plain docker first, sudo docker if this user can't reach the
// daemon (the prompt shows in the terminal).
const DOCKER: &str = r#"D=docker; $D info >/dev/null 2>&1 || D="sudo docker"; if $D compose version >/dev/null 2>&1; then C="$D compose"; else C="${D%docker}docker-compose"; fi;"#;
fn sq(v: &str) -> String { format!("'{}'", v.replace('\'', "'\\''")) }

pub fn docker_command(containers: &[Value], kind: &str, target: &str) -> ApiResult<String> {
    match kind {
        "container-shell" => {
            let c = containers.iter().find(|x| x.str_of("id") == target).filter(|c| re("^[0-9a-f]{12,64}$").is_match(c.str_of("id"))).ok_or_else(|| bad("That container is gone"))?;
            if c.str_of("state") != "running" { return Err(bad(format!("{} isn't running", c.str_of("name")))); }
            let id = c.str_of("id");
            Ok(format!("{DOCKER} $D exec {id} sh -c 'exit 0' >/dev/null 2>&1 || {{ echo \"{} has no shell: its image ships without one.\"; exit 1; }}; exec $D exec -it {id} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'", &id[..12]))
        }
        "stack-update" => {
            let c = containers.iter().find(|x| x.str_of("project") == target && !x.str_of("dir").is_empty())
                .filter(|c| re("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$").is_match(c.str_of("project"))).ok_or_else(|| bad("That stack is gone"))?;
            let (dir, project) = (c.str_of("dir"), c.str_of("project"));
            if !re(r"^/[A-Za-z0-9_./@+ -]{0,255}$").is_match(dir) { return Err(bad(format!("Can't update from {dir}: unusual folder name"))); }
            Ok(format!("{DOCKER} cd {} && $C -p {} pull && $C -p {} up -d && echo && echo \"Updated {project}.\"", sq(dir), sq(project), sq(project)))
        }
        _ => Err(bad("Unknown terminal")),
    }
}

/// The first character as people see it: an emoji with its skin tone, flag pair or ZWJ parts
/// (Intl.Segmenter's grapheme in the JS), cut to 16 UTF-16 units like `.slice(0, 16)`.
/// ponytail: the emoji rules only, not all of UAX #29; enough for one emoji or one letter.
pub fn first_grapheme(s: &str) -> String {
    let mut it = s.chars().peekable();
    let Some(first) = it.next() else { return String::new() };
    let mut g = vec![first];
    let regional = |c: char| ('\u{1F1E6}'..='\u{1F1FF}').contains(&c);
    let extend = |c: char| matches!(c, '\u{FE00}'..='\u{FE0F}' | '\u{1F3FB}'..='\u{1F3FF}' | '\u{20E3}' | '\u{E0020}'..='\u{E007F}' | '\u{0300}'..='\u{036F}');
    if regional(first) { if let Some(&c) = it.peek() { if regional(c) { g.push(c); it.next(); } } }
    while let Some(&c) = it.peek() {
        if extend(c) { g.push(c); it.next(); }
        else if c == '\u{200D}' { g.push(c); it.next(); if let Some(x) = it.next() { g.push(x); } }
        else { break; }
    }
    let mut out = String::new();
    let mut units = 0;
    for c in g { units += c.len_utf16(); if units > 16 { break; } out.push(c); }
    out
}

// ── state ────────────────────────────────────────────────────────────
pub struct Master { pub key: String, pub cert: String, pub fp: String, pub action_key: Option<String> }

#[derive(Clone, Copy, Default)]
struct Hist { t: i64, cpu: f64, mem: f64, rx: f64, tx: f64 }

#[derive(Default, Clone, Copy)]
struct AgentSt { first_seen: i64, busy_since: Option<i64>, idle_since: Option<i64>, finished_at: Option<i64> }

#[derive(Default)]
struct Live {
    snap: Option<Value>,
    at: Option<i64>,
    error: Option<String>,
    hist: Vec<Hist>,
    procs: HashMap<String, Vec<Sample>>,
    agents: HashMap<i64, AgentSt>,
    client: Option<reqwest::Client>,
}

#[derive(Default)]
pub struct Machines { master: Mutex<Option<Arc<Master>>>, live: Mutex<HashMap<String, Live>> }

struct Paths { dir: PathBuf, key: PathBuf, cert: PathBuf, file: PathBuf, pics: PathBuf, action_key: PathBuf }
fn paths(data: &Path) -> Paths {
    Paths { dir: data.into(), key: data.join("master-key.pem"), cert: data.join("master-cert.pem"), file: data.join("machines.json"),
        pics: data.join("pictures"), action_key: data.join("action-key.blob") }
}

fn mkdir(d: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(d)
}
fn write_private(f: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut h = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(f)?;
    h.write_all(bytes)
}

fn load(data: &Path) -> Vec<Value> {
    std::fs::read_to_string(paths(data).file).ok().and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok()).unwrap_or_default()
}
fn save(c: &Ctx, list: &[Value]) -> ApiResult<()> {
    if c.demo { return Ok(()); } // the demo never touches your real machines
    let p = paths(&c.data);
    let tmp = p.file.with_extension("json.tmp");
    mkdir(&p.dir).and_then(|_| write_private(&tmp, serde_json::to_string_pretty(list).unwrap().as_bytes())).and_then(|_| std::fs::rename(&tmp, &p.file))
        .map_err(|e| ApiErr::new(500, format!("Could not save your machines: {e}")))
}
fn find<'a>(list: &'a mut [Value], id: &str) -> ApiResult<&'a mut Value> {
    list.iter_mut().find(|m| m.str_of("id") == id).ok_or_else(|| ApiErr::gone("That machine is gone"))
}
fn ssh_target(m: &Value) -> String { [m.str_of("ssh"), m.str_of("host")].into_iter().find(|s| !s.is_empty()).unwrap_or("").to_string() }
fn has(m: &Value, k: &str) -> bool { m.get(k).is_some_and(|v| !v.is_null() && v != &json!("") && v != &json!(false)) }

fn hostname() -> String {
    let mut b = [0u8; 256];
    unsafe { libc::gethostname(b.as_mut_ptr() as *mut _, b.len()) };
    String::from_utf8_lossy(&b[..b.iter().position(|x| *x == 0).unwrap_or(0)]).into_owned()
}

/// The Touch ID key in the Secure Enclave (native/devdock-key.swift); signs every action.
/// 45 s for the finger: the signed action itself expires 60 s after it's made.
async fn keytool(c: &Ctx, args: &[&str], input: Option<&str>) -> ApiResult<String> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = tokio::process::Command::new(c.res.join("native/devdock-key"));
    cmd.args(args).kill_on_drop(true).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| ApiErr::new(500, format!("Touch ID key: {e}")))?;
    let mut stdin = child.stdin.take().unwrap();
    if let Some(i) = input { let _ = stdin.write_all(i.as_bytes()).await; }
    drop(stdin);
    match tokio::time::timeout(secs(45), child.wait_with_output()).await {
        Err(_) => Err(ApiErr::new(409, "Touch ID wasn't confirmed in time")),
        Ok(Err(e)) => Err(ApiErr::new(500, format!("Touch ID key: {e}"))),
        Ok(Ok(o)) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Ok(Ok(o)) if o.status.code() == Some(2) => Err(ApiErr::new(409, "Cancelled")),
        Ok(Ok(o)) => {
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(ApiErr::new(500, format!("Touch ID key: {}", if e.is_empty() { format!("exit {}", o.status.code().unwrap_or(-1)) } else { e })))
        }
    }
}

/// What a call to an agent answered
struct Resp { status: u16, body: Option<Value>, peer: Option<Vec<u8>> }

fn url(m: &Value, path: &str) -> String {
    let host = m.str_of("host");
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    format!("https://{host}:{}{path}", m["port"].as_u64().unwrap_or(7337))
}

/// One HTTPS call to an agent. After pairing, only the certificate it paired with is
/// accepted: its fingerprint is checked during the handshake, before a single byte is sent.
async fn call(client: &reqwest::Client, m: &Value, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Resp, String> {
    let mut req = client.request(method.parse().unwrap(), url(m, path)).timeout(timeout * 2); // a hard deadline, so a dripping server can't hold the poll
    if let Some(b) = body { req = req.header("Content-Type", "application/json").body(b.to_string()); }
    let mut res = req.send().await.map_err(|e| pin::describe(&e))?;
    let status = res.status().as_u16();
    let peer = res.extensions().get::<reqwest::tls::TlsInfo>().and_then(|i| i.peer_certificate()).map(<[u8]>::to_vec);
    let mut raw = vec![];
    while let Some(chunk) = res.chunk().await.map_err(|e| pin::describe(&e))? {
        raw.extend_from_slice(&chunk);
        if raw.len() > 4_000_000 { return Err("Answer too large".into()); }
    }
    Ok(Resp { status, body: serde_json::from_slice(&raw).ok(), peer })
}

const SSH: &str = r"^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,127}$";
const SESSION: &str = r"^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$";
const HOST: &str = r"^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$";

/// series for the page: up to 40 points, one decimal
fn series(h: &[f64]) -> Vec<f64> {
    let step = (h.len() / 40).max(1);
    h.iter().enumerate().filter(|(i, _)| i % step == 0 || *i == h.len() - 1).map(|(_, x)| (x * 10.0).round() / 10.0).collect()
}
fn last24(v: Vec<f64>) -> Vec<f64> { let s = v.len().saturating_sub(24); v[s..].to_vec() }

impl Machines {
    async fn master(&self, c: &Ctx) -> ApiResult<Arc<Master>> {
        if let Some(m) = self.master.lock().unwrap().clone() { return Ok(m); }
        let p = paths(&c.data);
        mkdir(&p.dir).map_err(|e| ApiErr::new(500, e.to_string()))?;
        if !p.key.exists() || !p.cert.exists() {
            let (k, ce) = (p.key.to_string_lossy().into_owned(), p.cert.to_string_lossy().into_owned());
            let r = run("/usr/bin/openssl", &["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                "-pkeyopt", "ec_param_enc:named_curve", "-nodes", // LibreSSL's default spells the curve out, which Go rejects
                "-keyout", &k, "-out", &ce, "-days", "7300", "-subj", &format!("/CN=devdock-master {}", hostname())], secs(10)).await;
            if r.code != 0 { return Err(ApiErr::new(500, format!("Could not create DevDock's key: {}", r.stderr))); }
        }
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p.key, std::fs::Permissions::from_mode(0o600));
        let read = |f: &Path| std::fs::read_to_string(f).map_err(|e| ApiErr::new(500, e.to_string()));
        let (key, cert) = (read(&p.key)?, read(&p.cert)?);
        let fp = pin::pem_fingerprint(&cert).ok_or_else(|| ApiErr::new(500, "DevDock's certificate is unreadable"))?;
        let action_key = keytool(c, &["pubkey", &p.action_key.to_string_lossy()], None).await.ok();
        let m = Arc::new(Master { key, cert, fp, action_key });
        *self.master.lock().unwrap() = Some(m.clone());
        Ok(m)
    }

    /// The connection pinned to this machine's certificate, made once and kept alive
    fn client(&self, master: &Master, m: &Value) -> Result<reqwest::Client, String> {
        let id = m.str_of("id").to_string();
        if let Some(c) = self.live.lock().unwrap().get(&id).and_then(|l| l.client.clone()) { return Ok(c); }
        let c = pin::client(master, Some(m.str_of("agentFp")))?;
        self.live.lock().unwrap().entry(id).or_default().client = Some(c.clone());
        Ok(c)
    }

    /// The token never lands in a command line, where any user on that machine could read it
    /// from /proc: the shell keeps it in a variable and pipes it to the installer. Over SSH,
    /// DevDock types it into the terminal instead, so it's not in the remote command either.
    fn install_command(c: &Ctx, master: &Master, m: &Value, via_ssh: bool) -> String {
        let scope: Vec<&str> = SCOPES.iter().copied().filter(|k| m["scope"][*k] == json!(true)).collect();
        let scope = if scope.is_empty() { "system".to_string() } else { scope.join(",") };
        let mut args = format!("--master {} --scope {scope} --port {}", master.fp, m["port"]);
        if m.str_of("networks") == "any" { args.push_str(" --networks any"); }
        if m["scope"]["actions"] == json!(true) { args.push_str(&format!(" --action-key {}", master.action_key.as_deref().unwrap_or("null"))); }
        let url = std::env::var("DEVDOCK_INSTALL_URL").unwrap_or_else(|_| format!("https://github.com/Osama-Yusuf/devdock/releases/download/v{}/install-agent.sh", c.version));
        // the installer must hash to the copy we ship: a swapped file on GitHub, or anyone in between, fails before sudo runs anything
        let sha = std::fs::read(c.res.join("agent/install-agent.sh")).map(|b| sha256_hex(&b)).unwrap_or_default();
        let run = format!("d=$(mktemp -d); {{ curl -fsSLo \"$d/i.sh\" {url} || wget -qO \"$d/i.sh\" {url}; }} 2>/dev/null; if (sha256sum \"$d/i.sh\" 2>/dev/null || shasum -a 256 \"$d/i.sh\") | grep -q \"^{sha} \"; \
then printf \"%s\\n\" \"$t\" | sudo sh \"$d/i.sh\" {args}; else echo \"That installer is not the one this DevDock ships: not running it.\"; fi; rm -rf \"$d\"");
        // over SSH: echo off, then an invisible title sequence tells DevDock it may type the token
        if via_ssh { format!("sh -c 'stty -echo; printf \"\\033]0;{READY}\\007\"; IFS= read -r t; stty echo; {run}'") } else { format!("t={}; {run}", m.str_of("token")) }
    }

    /// A pending machine: try to pair. Succeeds once the agent is installed and reachable.
    /// Ok(None) = paired; Ok(Some(note)) = not yet.
    async fn try_pair(&self, master: &Master, m: &mut Value) -> ApiResult<Option<String>> {
        let token = m.str_of("token").to_string();
        let client = pin::client(master, None).map_err(|e| ApiErr::new(500, e))?;
        let hint: String = token.chars().take(8).collect();
        let r = match call(&client, m, "POST", "/v1/pair", Some(&json!({ "tokenHint": hint })), secs(3)).await {
            Ok(r) => r,
            Err(e) => return Ok(Some(if e == pin::REFUSED { "Waiting for the agent…".into() } else { e })),
        };
        if r.status != 200 {
            return Ok(Some(r.body.as_ref().and_then(|b| b["error"].as_str()).map(String::from).unwrap_or_else(|| format!("The agent answered {}", r.status))));
        }
        let Some(der) = r.peer else { return Ok(Some("The agent sent no certificate".into())) };
        let seen = sha256_hex(&der);
        // the agent must prove the token for the key we actually saw, or it's not our agent
        let body = r.body.unwrap_or(json!({}));
        if body.str_of("agentFp") != seen || !pair_proof_ok(&token, &seen, &master.fp, body.str_of("proof")) {
            return Ok(Some("Pairing proof is wrong: this may not be your machine. Nothing was saved.".into()));
        }
        // the token proves the agent read the command, not that nobody else did: you check its key too
        let o = m.as_object_mut().unwrap();
        o.insert("agentFp".into(), json!(seen));
        o.insert("agentCert".into(), json!(pin::pem_of(&der)));
        o.insert("pairedAt".into(), json!(now_ms()));
        o.remove("token");
        o.insert("confirmed".into(), json!(false));
        Ok(None)
    }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { return Ok(crate::demo::get("machines")); }
        let master = self.master(c).await?;
        let mut list = load(&c.data);
        let now = now_ms();
        // pending machines pair first (rare, and pairing writes the list)
        let mut pending: HashMap<String, String> = HashMap::new();
        let mut changed = false;
        for m in list.iter_mut().filter(|m| !has(m, "agentFp")) {
            match self.try_pair(&master, m).await? {
                Some(note) => { pending.insert(m.str_of("id").to_string(), note); }
                None => changed = true,
            }
        }
        if changed { save(c, &list)?; }
        let polls = list.iter().filter(|m| !pending.contains_key(m.str_of("id")) && m["confirmed"] != json!(false)).map(|m| self.poll(&master, m, now));
        futures_util::future::join_all(polls).await;
        let out: Vec<Value> = list.iter().map(|m| self.entry(c, &master, m, pending.get(m.str_of("id")), now)).collect();
        Ok(json!({ "masterFp": master.fp, "machines": out }))
    }

    /// Read the machine's snapshot and keep its history
    async fn poll(&self, master: &Master, m: &Value, now: i64) {
        let id = m.str_of("id").to_string();
        let got = match self.client(master, m) {
            Ok(cl) => call(&cl, m, "GET", "/v1/snapshot", None, secs(4)).await.and_then(|r| {
                if r.status == 200 { Ok(r.body.unwrap_or(Value::Null)) } else { Err(r.body.as_ref().and_then(|b| b["error"].as_str()).map(String::from).unwrap_or_else(|| format!("answered {}", r.status))) }
            }),
            Err(e) => Err(e),
        };
        let mut live = self.live.lock().unwrap();
        let st = live.entry(id).or_default();
        match got {
            Ok(body) => {
                let snap = clean(&body).unwrap_or(json!({}));
                record(st, &snap, now);
                watch_procs(st, &snap, now);
                st.snap = Some(snap);
                st.at = Some(now);
                st.error = None;
            }
            Err(e) => {
                st.error = Some(if e.to_lowercase().contains("key changed") { "This machine's key changed: it may have been reinstalled, or someone is impersonating it".into() } else { e });
                st.client = None; // a fresh connection next time
            }
        }
    }

    fn entry(&self, c: &Ctx, master: &Master, m: &Value, pending: Option<&String>, now: i64) -> Value {
        let mut base = Map::new();
        for k in ["id", "name", "emoji", "color", "host", "port", "scope", "networks", "addedAt"] { if let Some(v) = m.get(k) { base.insert(k.into(), v.clone()); } }
        let or_null = |k: &str| m.get(k).filter(|v| has(m, k) && **v != json!(0)).cloned().unwrap_or(Value::Null);
        base.insert("icon".into(), or_null("icon"));
        base.insert("picture".into(), or_null("picture"));
        base.insert("pairedAt".into(), or_null("pairedAt"));
        base.insert("ssh".into(), json!(m.str_of("ssh")));
        let with = |mut extra: Value| { for (k, v) in &base { if extra.get(k).is_none() { extra[k] = v.clone(); } } extra };
        if let Some(note) = pending {
            let mut v = Value::Object(base.clone());
            v["status"] = json!("pending");
            v["note"] = json!(note);
            v["expires"] = json!(m["addedAt"].as_i64().unwrap_or(0) + 3_600_000);
            v["command"] = json!(Self::install_command(c, master, m, false));
            return v;
        }
        // nothing is read from it until you've matched its key with what the install printed
        if m["confirmed"] == json!(false) {
            let mut v = Value::Object(base.clone());
            v["status"] = json!("confirm");
            v["keyCode"] = json!(key_code(m.str_of("agentFp")));
            return v;
        }
        let mut live = self.live.lock().unwrap();
        let st = live.entry(m.str_of("id").to_string()).or_default();
        // a different key on that address is never "online", however recent the last good answer
        let untrusted = st.error.as_deref().is_some_and(|e| e.contains("key changed"));
        let online = !untrusted && st.at.is_some_and(|a| now - a < 15_000);
        let status = if untrusted { "untrusted" } else if online { "online" } else { "offline" };
        let items = attention(m, st, status, now); // also refreshes st.agents
        let empty = vec![];
        let list = |k: &str| -> &Vec<Value> { if online { st.snap.as_ref().and_then(|s| s[k].as_array()).unwrap_or(&empty) } else { &empty } };
        let proc_series = |key: &str, f: fn(&Sample) -> f64| -> Vec<f64> { last24(series(&st.procs.get(key).map(|l| l.iter().map(f).collect::<Vec<_>>()).unwrap_or_default())) };
        let pkey = |p: &Value| format!("{}:{}", p["pid"], p.str_of("name"));
        let proc_spark: Map<String, Value> = list("processes").iter().map(|p| (p["pid"].to_string(), json!(proc_series(&pkey(p), |s| s.cpu)))).collect();
        let ctr_spark: Map<String, Value> = list("containers").iter().map(|x| {
            let k = format!("c:{}", x.str_of("id"));
            (x.str_of("id").to_string(), json!({ "cpu": proc_series(&k, |s| s.cpu), "mem": proc_series(&k, |s| s.mem) }))
        }).collect();
        // coding agents, with a state read from CPU alone (a remote agent has no hooks to say "needs you")
        let agents: Vec<Value> = list("processes").iter().filter(|p| AGENTS.contains(&p.str_of("name"))).map(|p| {
            let a = st.agents.get(&p["pid"].as_i64().unwrap_or(0)).copied().unwrap_or_default();
            let mut v = p.clone();
            v["state"] = match a.busy_since {
                Some(b) => json!({ "status": "working", "since": b }),
                None => json!({ "status": "idle", "since": a.finished_at.or(a.idle_since).unwrap_or(a.first_seen) }),
            };
            v
        }).collect();
        let h = |f: fn(&Hist) -> f64| json!(series(&st.hist.iter().map(f).collect::<Vec<_>>()));
        with(json!({
            "items": items, "agents": agents, "procSpark": proc_spark, "ctrSpark": ctr_spark,
            "status": status, "error": if online { Value::Null } else { json!(st.error) }, "lastSeen": st.at,
            "snap": if untrusted { Value::Null } else { st.snap.clone().unwrap_or(Value::Null) },
            "spark": { "cpu": h(|x| x.cpu), "mem": h(|x| x.mem), "rx": h(|x| x.rx), "tx": h(|x| x.tx) },
        }))
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        match name {
            "nearby" => self.nearby(c).await,
            "add" => self.add(c, p).await,
            "act" => self.act(c, p).await,
            "sessions" => remote_sessions(c, p).await,
            "customize" => customize(c, p),
            "picture" => picture(c, p),
            "repair" => {
                let mut list = load(&c.data);
                let id = p.str_of("id");
                let m = find(&mut list, id)?;
                let token = p.str_of("token").trim();
                if !re("^[0-9a-f]{64}$").is_match(token) { return Err(bad("Paste the 64-character code `sudo devdock-agent pair` printed")); }
                let o = m.as_object_mut().unwrap();
                o.insert("token".into(), json!(token));
                for k in ["agentFp", "agentCert", "pairedAt"] { o.remove(k); }
                o.insert("addedAt".into(), json!(now_ms()));
                self.live.lock().unwrap().remove(id);
                save(c, &list)?;
                Ok(json!({}))
            }
            // you compared the key DevDock shows with the one the install printed
            "confirm" => {
                let mut list = load(&c.data);
                let id = p.str_of("id").to_string();
                let m = find(&mut list, &id)?;
                if m["confirmed"] != json!(false) { return Ok(json!({})); }
                if p["matches"] != json!(true) { return self.forget(c, list, &id); }
                m["confirmed"] = json!(true);
                save(c, &list)?;
                Ok(json!({}))
            }
            "remove" => {
                let mut list = load(&c.data);
                let id = p.str_of("id").to_string();
                find(&mut list, &id)?;
                self.forget(c, list, &id)
            }
            _ => Err(crate::sources::unknown()),
        }
    }

    fn forget(&self, c: &Ctx, list: Vec<Value>, id: &str) -> ApiResult<Value> {
        self.live.lock().unwrap().remove(id);
        let _ = std::fs::remove_file(paths(&c.data).pics.join(format!("{id}.png")));
        save(c, &list.into_iter().filter(|m| m.str_of("id") != id).collect::<Vec<_>>())?;
        Ok(json!({}))
    }

    /// Machines this Mac already knows: ~/.ssh/config hosts, OrbStack VMs, Tailscale peers.
    /// Hints for the add sheet, nothing is contacted.
    async fn nearby(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo {
            return Ok(json!({ "found": [{ "host": "nas.local", "name": "nas", "from": "SSH config" }, { "host": "pi.tail1234.ts.net", "name": "pi", "from": "Tailscale" }, { "host": "dev.orb.local", "name": "dev", "from": "OrbStack" }] }));
        }
        let ok = re(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$");
        let mut found: Vec<Value> = vec![];
        let mut add = |host: &str, name: &str, from: &str| {
            if !host.is_empty() && ok.is_match(host) && !found.iter().any(|f| f.str_of("host") == host) {
                let name = if name.is_empty() { host.split('.').next().unwrap_or(host) } else { name };
                found.push(json!({ "host": host, "name": name, "from": from }));
            }
        };
        if let Ok(cfg) = std::fs::read_to_string(home().join(".ssh/config")) { for (h, a) in ssh_config_hosts(&cfg) { add(&h, &a, "SSH config"); } }
        if let Some(orb) = find_bin("orb") {
            let r = run(&orb, &["list", "-f", "json"], secs(4)).await;
            if let Ok(Value::Array(a)) = serde_json::from_str(&r.stdout) {
                for m in a.iter().filter(|m| m.str_of("state") == "running") { add(&format!("{}.orb.local", m.str_of("name")), m.str_of("name"), "OrbStack"); }
            }
        }
        let ts = find_bin("tailscale").or_else(|| Path::new("/Applications/Tailscale.app/Contents/MacOS/Tailscale").exists().then(|| "/Applications/Tailscale.app/Contents/MacOS/Tailscale".to_string()));
        if let Some(ts) = ts {
            let r = run(&ts, &["status", "--json"], secs(4)).await;
            if let Ok(v) = serde_json::from_str::<Value>(&r.stdout) {
                let phone = re("(?i)^(macOS|iOS|android)$");
                for p in v["Peer"].as_object().into_iter().flat_map(|o| o.values()) {
                    if p["Online"] == json!(true) && !phone.is_match(p.str_of("OS")) { add(p.str_of("DNSName").trim_end_matches('.'), p.str_of("HostName"), "Tailscale"); }
                }
            }
        }
        found.truncate(12);
        Ok(json!({ "found": found }))
    }

    /// Start adding a machine: a token and the install command that carries it
    async fn add(&self, c: &Ctx, p: &Value) -> ApiResult<Value> {
        let master = self.master(c).await?;
        let host = match &p["host"] { Value::String(s) => s.trim().to_string(), Value::Null => String::new(), v => v.to_string() };
        if !re(HOST).is_match(&host) { return Err(bad("Type the machine's hostname or IP, like nas.local or 192.168.1.20")); }
        let port = match p.get("port") { None | Some(Value::Null) => 7337.0, Some(v) => n(v) };
        if !(port > 0.0 && port < 65536.0) || port.fract() != 0.0 { return Err(bad("Port must be 1 to 65535")); }
        let scope = p.get("scope").filter(|s| s.is_object()).cloned().unwrap_or(json!({}));
        let truthy = |v: &Value| !matches!(v, Value::Null | Value::Bool(false)) && v != &json!(0) && v != &json!("");
        if truthy(&scope["actions"]) && master.action_key.is_none() { return Err(bad("Actions need Touch ID, and this Mac's Secure Enclave key couldn't be made")); }
        let mut list = load(&c.data);
        if list.iter().any(|m| m.str_of("host") == host && m["port"].as_f64() == Some(port)) { return Err(bad(format!("{host}:{port} is already in your machines"))); }
        let name = match &p["name"] { Value::String(s) if !s.is_empty() => s.clone(), _ => host.split('.').next().unwrap_or("").to_string() };
        let mut sc = Map::new();
        for k in SCOPES { sc.insert(k.into(), json!(truthy(&scope[k]))); }
        let m = json!({
            "id": random_hex(6), "host": host, "port": port as u64, "name": name.chars().take(40).collect::<String>(),
            "emoji": "", "color": COLORS[list.len() % 6], "scope": sc, "networks": if p.str_of("networks") == "any" { "any" } else { "private" },
            "token": random_hex(32), "addedAt": now_ms(),
        });
        let command = Self::install_command(c, &master, &m, false);
        let id = m["id"].clone();
        list.push(m);
        save(c, &list)?;
        Ok(json!({ "id": id, "command": command }))
    }

    /// One action on one machine: Touch ID signs it here, the agent checks the signature there
    async fn act(&self, c: &Ctx, p: &Value) -> ApiResult<Value> {
        let master = self.master(c).await?;
        let mut list = load(&c.data);
        let m = find(&mut list, p.str_of("id"))?.clone();
        let action = p.str_of("action");
        let label = action_label(action).ok_or_else(|| bad("Unknown action"))?;
        if !has(&m, "agentFp") || m["scope"]["actions"] != json!(true) { return Err(ApiErr::new(403, format!("{} doesn't allow actions", m.str_of("name")))); }
        let target = match &p["target"] { Value::Null => String::new(), Value::String(s) => s.clone(), v => v.to_string() };
        let nonce = random_hex(16);
        let expires = now_ms() / 1000 + 60;
        let text = format!("devdock-action-v1\n{}\n{action}\n{target}\n{nonce}\n{expires}", m.str_of("agentFp"));
        // the Touch ID prompt describes what is actually signed: the caller's label never reaches it
        let what = {
            let live = self.live.lock().unwrap();
            let s = live.get(m.str_of("id")).and_then(|l| l.snap.clone()).unwrap_or(Value::Null);
            let empty = vec![];
            if action.starts_with("process") {
                let name = s["processes"].as_array().unwrap_or(&empty).iter().find(|x| x["pid"] == target).map(|x| x.str_of("name").to_string()).filter(|x| !x.is_empty());
                format!("{} (pid {target})", name.unwrap_or("process".into()))
            } else if action.starts_with("stack") { format!("stack {target}") } else {
                let name = s["containers"].as_array().unwrap_or(&empty).iter().find(|x| x.str_of("id") == target || x.str_of("name") == target).map(|x| x.str_of("name").to_string()).filter(|x| !x.is_empty());
                format!("container {}", name.unwrap_or(target.clone()))
            }
        };
        let safe: String = what.chars().filter(|ch| ch.is_ascii_alphanumeric() || " _.()/:@-".contains(*ch)).take(80).collect();
        let reason = format!("{} {safe} on {}", label.to_lowercase(), m.str_of("name"));
        let sig = keytool(c, &["sign", &paths(&c.data).action_key.to_string_lossy(), &reason], Some(&text)).await?;
        let req = json!({ "action": action, "target": target, "nonce": nonce, "expires": expires, "sig": sig });
        let client = self.client(&master, &m).map_err(|e| ApiErr::new(500, e))?;
        let r = call(&client, &m, "POST", "/v1/action", Some(&req), secs(35)).await.map_err(|e| ApiErr::new(500, e))?;
        if r.status != 200 { return Err(bad(r.body.as_ref().and_then(|b| b["error"].as_str()).map(String::from).unwrap_or_else(|| format!("The agent answered {}", r.status)))); }
        Ok(json!({}))
    }

    /// Terminals go through your own SSH, never the agent: it can't start a shell, so it can't
    /// be turned into one. Pending machines: the install command. Paired: a shell, or attach.
    pub fn terminal(&self, c: &Ctx, p: &Value) -> ApiResult<Option<TermSpec>> {
        let list = load(&c.data);
        let Some(m) = list.iter().find(|x| x.str_of("id") == p.str_of("id")) else { return Ok(None) };
        let ssh = |args: Vec<String>| TermSpec { file: "/usr/bin/ssh".into(), args, ..Default::default() };
        let mut base = vec!["-t".to_string(), "--".into(), ssh_target(m)];
        if has(p, "kind") {
            let live = self.live.lock().unwrap();
            let s = live.get(m.str_of("id")).and_then(|l| l.snap.as_ref());
            let ctrs = s.and_then(|s| s["containers"].as_array());
            let (true, true, Some(ctrs)) = (has(m, "agentFp"), m["scope"]["containers"] == json!(true), ctrs) else { return Err(bad("This machine doesn't share its containers")) };
            base.push(docker_command(ctrs, p.str_of("kind"), &js_string(&p["target"]))?);
            return Ok(Some(ssh(base)));
        }
        if !has(m, "agentFp") {
            let master = self.master.lock().unwrap().clone();
            let (true, Some(master)) = (has(m, "token"), master) else { return Ok(None) };
            base.push(Self::install_command(c, &master, m, true));
            return Ok(Some(TermSpec { input: Some(format!("{}\n", m.str_of("token"))), input_when: Some(READY.into()), keep: true, ..ssh(base) }));
        }
        if !has(p, "mux") { return Ok(Some(ssh(base))); }
        let session = p.str_of("session");
        if !re(SESSION).is_match(session) { return Ok(None); }
        let cmd = match p.str_of("mux") { "tmux" => format!("tmux attach -t '={session}'"), "zellij" => format!("zellij attach '{session}'"), _ => return Ok(None) };
        base.push(cmd);
        Ok(Some(ssh(base)))
    }

    pub fn picture_path(&self, id: &str) -> Option<PathBuf> {
        if !re("^[0-9a-f]{12}$").is_match(id) { return None; }
        let f = paths(&crate::state::ctx().data).pics.join(format!("{id}.png"));
        f.exists().then_some(f)
    }
}

/// String(x) for what the page sent
fn js_string(v: &Value) -> String { match v { Value::Null => String::new(), Value::String(s) => s.clone(), v => v.to_string() } }

/// "Host alias" followed by its "HostName": (hostname, alias). Patterns and multi-name hosts are skipped.
pub fn ssh_config_hosts(cfg: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut alias: Option<String> = None;
    for line in cfg.split('\n') {
        let mut f = line.split_whitespace();
        let key = f.next().unwrap_or("").to_lowercase();
        let v: Vec<&str> = f.collect();
        if key == "host" { alias = (v.len() == 1 && !v[0].contains(['*', '?', '!'])).then(|| v[0].to_string()); }
        if key == "hostname" { if let Some(a) = alias.take() { out.push((v.first().copied().unwrap_or("").to_string(), a)); } }
    }
    out
}

/// Multiplexer sessions, over SSH with keys only: no prompt can hang it
async fn remote_sessions(c: &Ctx, p: &Value) -> ApiResult<Value> {
    let mut list = load(&c.data);
    let m = find(&mut list, p.str_of("id"))?;
    let r = run("/usr/bin/ssh", &["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", &ssh_target(m),
        "tmux ls -F \"tmux #{session_name} #{session_windows} #{session_attached}\" 2>/dev/null; zellij ls -n -s 2>/dev/null | sed \"s/^/zellij /\""], secs(12)).await;
    if r.code == 255 {
        let e = &r.stderr;
        let msg = if re("(?i)Host key|known_hosts").is_match(e) { "Open a shell once to trust its SSH key".to_string() }
            else if re("(?i)denied").is_match(e) { "SSH needs a key here: set who to connect as, or add your key to the machine".into() }
            else { format!("SSH couldn't connect: {}", e.trim().split('\n').next_back().unwrap_or("")) };
        return Ok(json!({ "error": msg }));
    }
    Ok(json!({ "sessions": parse_sessions(&r.stdout) }))
}

pub fn parse_sessions(out: &str) -> Vec<Value> {
    let ok = re(SESSION);
    out.split('\n').map(|l| l.split(' ').collect::<Vec<_>>()).filter(|f| f.len() >= 2 && (f[0] == "tmux" || f[0] == "zellij") && ok.is_match(f[1]))
        .map(|f| {
            let w = f.get(2).and_then(|x| x.parse::<f64>().ok()).filter(|x| *x != 0.0).unwrap_or(1.0);
            let a = f.get(3).copied().unwrap_or("");
            json!({ "mux": f[0], "name": f[1], "windows": num(w), "attached": a == "1" || a.parse::<f64>().is_ok_and(|x| x > 0.0) })
        }).collect()
}

/// One look at a time: a brand icon, an emoji or a picture; choosing one drops the others
fn customize(c: &Ctx, p: &Value) -> ApiResult<Value> {
    if c.demo { return Ok(json!({})); }
    let mut list = load(&c.data);
    let id = p.str_of("id").to_string();
    let pic = paths(&c.data).pics.join(format!("{id}.png"));
    let m = find(&mut list, &id)?;
    let given = |k: &str| p.get(k).filter(|v| !v.is_null());
    let plain = |m: &mut Value| { let _ = std::fs::remove_file(&pic); m["picture"] = Value::Null; };
    if let Some(name) = given("name") {
        let s: String = js_string(name).trim().chars().take(40).collect();
        if !s.is_empty() { m["name"] = json!(s); }
    }
    if let Some(e) = given("emoji") {
        m["emoji"] = json!(first_grapheme(&js_string(e))); // one emoji, ZWJ ones too
        if !m.str_of("emoji").is_empty() { m.as_object_mut().unwrap().remove("icon"); plain(m); }
    }
    match p.get("icon") {
        Some(Value::Null) => { m.as_object_mut().unwrap().remove("icon"); }
        Some(icon) => {
            let (slug, hex, d) = (icon.str_of("slug"), icon.str_of("hex"), &icon["path"]);
            let path_ok = d.as_str().is_some_and(|d| d.len() <= 30000 && re(r"^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$").is_match(d));
            if !re("^[a-z0-9]{1,64}$").is_match(slug) || !re("^[0-9A-Fa-f]{6}$").is_match(hex) || !path_ok { return Err(bad("That icon looks wrong")); }
            let title = match &icon["title"] { Value::String(s) if !s.is_empty() => s.clone(), _ => slug.to_string() };
            m["icon"] = json!({ "slug": slug, "title": title.chars().take(64).collect::<String>(), "hex": hex, "path": d });
            m["emoji"] = json!("");
            plain(m);
        }
        None => {}
    }
    if let Some(col) = given("color").and_then(|v| v.as_str()) { if re("(?i)^#[0-9a-f]{6}$").is_match(col) { m["color"] = json!(col); } }
    if let Some(ssh) = given("ssh") {
        let s = js_string(ssh);
        if !s.is_empty() && !re(SSH).is_match(&s) { return Err(bad("SSH target looks wrong: use host, user@host or an ~/.ssh/config name")); }
        if s.is_empty() { m.as_object_mut().unwrap().remove("ssh"); } else { m["ssh"] = json!(s); }
    }
    save(c, &list)?;
    Ok(json!({}))
}

/// A small picture, already resized by the page; stored as a file, served by /api/machines/:id/picture
fn picture(c: &Ctx, p: &Value) -> ApiResult<Value> {
    if c.demo { return Ok(json!({})); }
    let mut list = load(&c.data);
    let id = p.str_of("id").to_string();
    let pics = paths(&c.data).pics;
    let file = pics.join(format!("{id}.png"));
    let m = find(&mut list, &id)?;
    if p.get("dataUrl") == Some(&Value::Null) {
        let _ = std::fs::remove_file(&file);
        m["picture"] = Value::Null;
        save(c, &list)?;
        return Ok(json!({}));
    }
    let url = p.str_of("dataUrl");
    let b64 = re(r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$").captures(url).map(|x| x[2].to_string());
    let bytes = b64.filter(|b| b.len() <= 700_000).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok()).ok_or_else(|| bad("Use a PNG, JPEG or WebP under 500 KB"))?;
    mkdir(&pics).and_then(|_| write_private(&file, &bytes)).map_err(|e| ApiErr::new(500, e.to_string()))?;
    m["picture"] = json!(now_ms()); // also busts the page's cache
    m.as_object_mut().unwrap().remove("icon");
    m["emoji"] = json!("");
    save(c, &list)?;
    Ok(json!({}))
}

fn pair_proof_ok(token: &str, agent_fp: &str, master_fp: &str, proof: &str) -> bool {
    let Some(got) = hex_decode(proof) else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
    mac.update(format!("devdock-pair-v1|{agent_fp}|{master_fp}").as_bytes());
    mac.verify_slice(&got).is_ok() // constant time
}

fn record(st: &mut Live, s: &Value, now: i64) {
    let (rx, tx) = s["net"].as_array().into_iter().flatten().fold((0.0, 0.0), |(r, t), i| (r + n(&i["rx"]), t + n(&i["tx"])));
    let total = n(&s["mem"]["total"]);
    st.hist.push(Hist { t: now, cpu: n(&s["cpu"]["usage"]), mem: if total > 0.0 { n(&s["mem"]["used"]) / total * 100.0 } else { 0.0 }, rx, tx });
    st.hist.retain(|h| now - h.t <= KEEP);
}

/// history for the top processes and the running containers the agent reports
fn watch_procs(st: &mut Live, s: &Value, now: i64) {
    let mut seen = HashSet::new();
    let procs = s["processes"].as_array().into_iter().flatten().map(|p| (format!("{}:{}", p["pid"], p.str_of("name")), p));
    let ctrs = s["containers"].as_array().into_iter().flatten().filter(|c| c.str_of("state") == "running").map(|c| (format!("c:{}", c.str_of("id")), c));
    for (key, p) in procs.chain(ctrs) {
        let l = st.procs.entry(key.clone()).or_default();
        l.push(Sample { t: now, cpu: n(&p["cpu"]), mem: n(&p["mem"]) / 1048576.0 });
        l.retain(|x| now - x.t <= KEEP);
        seen.insert(key);
    }
    st.procs.retain(|k, _| seen.contains(k)); // ponytail: out of the top 20 = history lost
}

/// Only what needs you, like Home: each rule waits for its condition to hold
fn attention(m: &Value, st: &mut Live, status: &str, now: i64) -> Vec<Value> {
    let mut items = vec![];
    let mid = m.str_of("id").to_string();
    let mut add = |ty: &str, severity: &str, key: String, more: Value| {
        let mut v = json!({ "id": format!("{mid}:{ty}:{key}"), "type": ty, "severity": severity });
        for (k, x) in more.as_object().unwrap() { v[k] = x.clone(); }
        items.push(v);
    };
    if status == "offline" { if let Some(at) = st.at { add("offline", "critical", String::new(), json!({ "since": at, "error": st.error })); } }
    let Some(s) = st.snap.clone().filter(|_| status == "online") else { return items };
    let empty = vec![];
    let arr = |k: &str| s[k].as_array().unwrap_or(&empty).clone();
    for p in arr("processes") {
        let l = st.procs.get(&format!("{}:{}", p["pid"], p.str_of("name"))).cloned().unwrap_or_default();
        let subject = json!({ "pid": p["pid"], "name": p["name"], "user": p["user"] });
        if let Some(r) = runaway(&l, now) {
            add("cpu", "critical", p["pid"].to_string(), json!({ "subject": subject, "since": r.since, "value": r.value, "spark": l.iter().map(|x| x.cpu.round() as i64).collect::<Vec<_>>() }));
        }
        if let Some(k) = leak(&l, now) {
            add("mem", "critical", p["pid"].to_string(), json!({ "subject": subject, "since": k.since, "from": k.from, "value": k.value, "rate": k.rate, "spark": l.iter().map(|x| x.mem.round() as i64).collect::<Vec<_>>() }));
        }
    }
    coding(st, &arr("processes"), now, &mut add);
    let ctrs = arr("containers");
    let stopped: Vec<&Value> = ctrs.iter().filter(|c| matches!(c.str_of("state"), "exited" | "dead" | "created")).collect();
    if !stopped.is_empty() {
        let mut ids: Vec<&str> = stopped.iter().map(|c| c.str_of("id")).collect();
        ids.sort();
        add("stopped", "tidy", ids.join(","), json!({ "subjects": stopped.iter().map(|c| json!({ "id": c["id"], "name": c["name"], "status": c["status"] })).collect::<Vec<_>>() }));
    }
    for c in ctrs.iter().filter(|c| c.str_of("state") == "restarting") {
        add("crash", "critical", c.str_of("id").into(), json!({ "subject": { "id": c["id"], "name": c["name"], "image": c["image"] }, "status": c["status"] }));
    }
    for d in arr("disks") {
        let total = n(&d["total"]);
        let pct = if total != 0.0 { n(&d["used"]) / total * 100.0 } else { 0.0 };
        if pct >= 85.0 { add("disk", if pct >= 95.0 { "critical" } else { "warning" }, d.str_of("mount").into(), json!({ "subject": { "mount": d["mount"] }, "value": pct, "free": total - n(&d["used"]) })); }
    }
    // sustained for 5 minutes, not a spike
    let held = |f: fn(&Hist) -> f64, min: f64| -> Option<Vec<f64>> {
        let first = st.hist.first()?;
        if now - first.t < 5 * MIN { return None; }
        let r: Vec<f64> = st.hist.iter().filter(|h| now - h.t <= 5 * MIN).map(f).collect();
        (!r.is_empty() && r.iter().all(|x| *x >= min)).then_some(r)
    };
    if let Some(mp) = held(|h| h.mem, 90.0) { add("pressure", "critical", String::new(), json!({ "value": mp.last(), "spark": mp.iter().map(|x| x.round() as i64).collect::<Vec<_>>() })); }
    if let Some(cp) = held(|h| h.cpu, 90.0) { add("busy", "warning", String::new(), json!({ "value": cp.last(), "spark": cp.iter().map(|x| x.round() as i64).collect::<Vec<_>>() })); }
    items
}

/// Coding agents on the machine, like Home's: a turn of real work then quiet = just finished;
/// quiet for hours = left behind.
fn coding(st: &mut Live, procs: &[Value], now: i64, add: &mut impl FnMut(&str, &str, String, Value)) {
    let mut live = HashSet::new();
    for p in procs.iter().filter(|p| AGENTS.contains(&p.str_of("name"))) {
        let pid = p["pid"].as_i64().unwrap_or(0);
        live.insert(pid);
        let recent: Vec<f64> = st.procs.get(&format!("{}:{}", p["pid"], p.str_of("name"))).into_iter().flatten().filter(|x| now - x.t <= 15_000).map(|x| x.cpu).collect();
        let busy = !recent.is_empty() && recent.iter().sum::<f64>() / recent.len() as f64 >= 3.0;
        let a = st.agents.entry(pid).or_insert(AgentSt { first_seen: now, ..Default::default() });
        if busy { a.busy_since.get_or_insert(now); a.idle_since = None; } else {
            if a.busy_since.is_some_and(|b| now - b >= 30_000) { a.finished_at = Some(now); }
            a.busy_since = None;
            a.idle_since.get_or_insert(now);
        }
        let a = *a;
        let subject = json!({ "pid": p["pid"], "name": p["name"], "user": p["user"], "mem": p["mem"] });
        if let Some(f) = a.finished_at.filter(|f| now - f < 30 * MIN) { add("finished", "done", format!("{}:{f}", p["pid"]), json!({ "subject": subject, "since": f })); }
        if let Some(i) = a.idle_since.filter(|i| now - i >= 2 * 60 * MIN) { add("idle-agent", "tidy", p["pid"].to_string(), json!({ "subject": subject, "since": i })); }
    }
    st.agents.retain(|k, _| live.contains(k));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hostile_snapshot_comes_out_typed_and_harmless() {
        let x = "<img src=x onerror=alert(1)>";
        let s = clean(&json!({ "host": { "cores": x, "distro": 7 }, "cpu": { "usage": x, "load": x }, "processes": { "pid": 1 },
            "ports": [{ "port": x, "pid": x }], "containers": [{ "state": "\"><script>", "id": "a" }], "net": [{ "addrs": [x, 5] }], "disks": "nope", "extra": x })).unwrap();
        assert_eq!(s["host"]["cores"], 0);
        assert_eq!(s["host"]["distro"], "");
        assert_eq!(s["cpu"]["usage"], 0);
        assert_eq!(s["processes"], json!([]));
        assert_eq!(s["ports"][0]["port"], 0);
        assert!(s["ports"][0].get("pid").is_none());
        assert_eq!(s["containers"][0]["state"], "script");
        assert_eq!(s["net"][0]["addrs"], json!([x, ""])); // strings stay strings: the UI escapes them
        assert_eq!(s["disks"], json!([]));
        assert!(s.get("extra").is_none());
        assert_eq!(clean(&json!("junk")), None);
        assert_eq!(clean(&json!({ "processes": vec![json!({ "pid": 2 }); 500] })).unwrap()["processes"].as_array().unwrap().len(), 64);
        assert_eq!(n(&json!("12")), 12.0);
        assert_eq!(n(&json!(" 0x1A ")), 26.0);
        assert_eq!(n(&json!(true)), 1.0);
        assert_eq!(n(&json!(f64::MAX)), f64::MAX);
        assert_eq!(n(&json!("Infinity")), 0.0);
    }

    #[test]
    fn docker_commands_for_ssh_refuse_names_that_could_escape_the_remote_shell() {
        let ok = json!({ "id": "a".repeat(64), "name": "web", "state": "running", "project": "shop", "dir": "/srv/shop" });
        assert!(re("exec -it a{64} sh -c").is_match(&docker_command(std::slice::from_ref(&ok), "container-shell", ok.str_of("id")).unwrap()));
        assert!(docker_command(std::slice::from_ref(&ok), "stack-update", "shop").unwrap().contains("cd '/srv/shop' && $C -p 'shop' pull"));
        let with = |k: &str, v: &str| { let mut c = ok.clone(); c[k] = json!(v); c };
        let evil = [with("id", "a1;rm -rf /"), with("project", "x';reboot;'"), with("dir", "/srv/$(reboot)"), with("dir", "/srv/`reboot`"), with("dir", "/srv/a'b")];
        for c in &evil {
            for (kind, target) in [("container-shell", c.str_of("id")), ("stack-update", c.str_of("project"))] {
                if let Ok(cmd) = docker_command(std::slice::from_ref(c), kind, target) { assert!(!cmd.contains("reboot") && !cmd.contains("rm -rf"), "{kind} let through: {cmd}"); }
            }
        }
        let stopped = with("state", "exited");
        assert!(docker_command(&[stopped], "container-shell", ok.str_of("id")).unwrap_err().msg.contains("isn't running"));
    }

    #[test]
    fn pairing_proof_matches_the_agents_hmac() {
        // agent/identity.go pairProof: HMAC-SHA256(token, "devdock-pair-v1|" + agentFP + "|" + masterFP), hex
        let mut mac = Hmac::<Sha256>::new_from_slice(b"tok").unwrap();
        mac.update(b"devdock-pair-v1|aa|bb");
        let proof: String = mac.finalize().into_bytes().iter().map(|x| format!("{x:02x}")).collect();
        assert!(pair_proof_ok("tok", "aa", "bb", &proof));
        assert!(!pair_proof_ok("tok", "aa", "bc", &proof));
        assert!(!pair_proof_ok("tok", "aa", "bb", &proof[..10]));
        assert!(!pair_proof_ok("tok", "aa", "bb", "zz"));
        assert_eq!(key_code("abcdef0123456789ffff"), "ABCD EF01 2345 6789");
    }

    #[test]
    fn small_parsers() {
        assert_eq!(first_grapheme("👩‍💻 dev"), "👩‍💻");
        assert_eq!(first_grapheme("🇪🇬x"), "🇪🇬");
        assert_eq!(first_grapheme("👍🏽!"), "👍🏽");
        assert_eq!(first_grapheme("ab"), "a");
        assert_eq!(first_grapheme(""), "");
        assert_eq!(ssh_config_hosts("Host nas\n  HostName 192.168.1.20\nHost *.corp\n  HostName x\nHost a b\n HostName y\n"), [("192.168.1.20".to_string(), "nas".to_string())]);
        assert_eq!(parse_sessions("tmux main 3 1\nzellij dev\ntmux bad;name 1 0\nnoise\n"), [
            json!({ "mux": "tmux", "name": "main", "windows": 3, "attached": true }), json!({ "mux": "zellij", "name": "dev", "windows": 1, "attached": false })]);
        assert_eq!(series(&(0..100).map(|x| x as f64 / 3.0).collect::<Vec<_>>()).len(), 51);
    }

    #[test]
    fn rules_for_a_remote_machine() {
        let m = json!({ "id": "m1" });
        let mut st = Live::default();
        let mut now = 1_000_000_000_000;
        // a server busy 4 cores for 6 minutes, memory at 95%, a stopped container
        for _ in 0..(6 * 12) {
            let s = json!({ "cpu": { "usage": 50 }, "mem": { "total": 100, "used": 95 }, "processes": [{ "pid": 7, "name": "postgres", "user": "pg", "cpu": 400, "mem": 1048576 }],
                "containers": [{ "id": "c2", "name": "old", "state": "exited" }, { "id": "c1", "name": "web", "state": "running", "cpu": 1, "mem": 0 }], "disks": [{ "mount": "/", "total": 100, "used": 96 }] });
            record(&mut st, &s, now);
            watch_procs(&mut st, &s, now);
            st.snap = Some(s);
            now += 5000;
        }
        let types: Vec<String> = attention(&m, &mut st, "online", now - 5000).iter().map(|i| i.str_of("id").to_string()).collect();
        assert_eq!(types, ["m1:cpu:7", "m1:stopped:c2", "m1:disk:/", "m1:pressure:"]);
        st.at = Some(now);
        assert_eq!(attention(&m, &mut st, "offline", now)[0]["type"], "offline");
    }

    #[test]
    fn the_saved_machines_still_load() {
        // read-only: the file the Node app wrote parses, and each paired machine has a pin to check against
        let f = home().join("Library/Application Support/DevDock/machines.json");
        let Ok(text) = std::fs::read_to_string(&f) else { return };
        let list: Vec<Value> = serde_json::from_str(&text).expect("machines.json parses");
        for m in list.iter().filter(|m| has(m, "agentFp")) {
            let cert = m.str_of("agentCert");
            assert_eq!(pin::pem_fingerprint(cert).as_deref(), Some(m.str_of("agentFp")), "agentCert hashes to agentFp");
        }
        let dir = home().join("Library/Application Support/DevDock");
        if let (Ok(key), Ok(cert)) = (std::fs::read_to_string(dir.join("master-key.pem")), std::fs::read_to_string(dir.join("master-cert.pem"))) {
            let master = Master { fp: pin::pem_fingerprint(&cert).unwrap(), key, cert, action_key: None };
            pin::client(&master, Some("00")).expect("the master key loads into rustls");
        }
    }
}

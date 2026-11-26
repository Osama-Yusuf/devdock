//! What the whole app shares: settings, the process table, the latest ports, the sources,
//! and the hub that pushes changes to every open page. One instance, made at startup.
use crate::ports::{Scanner, Snapshot};
use crate::settings::Settings;
use crate::table::{Sampler, Table};
use crate::util::{now_ms, Get};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::sync::{broadcast, Notify};

/// Pushes messages to every connected page; knows whether anyone is looking
pub struct Hub {
    tx: broadcast::Sender<Arc<str>>,
    clients: AtomicUsize,
    /// a page connected while nobody was: refresh everything now
    pub joined: Notify,
}

impl Hub {
    fn new() -> Self { Hub { tx: broadcast::channel(256).0, clients: AtomicUsize::new(0), joined: Notify::new() } }
    pub fn send(&self, msg: impl Into<Arc<str>>) { let _ = self.tx.send(msg.into()); }
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> { self.tx.subscribe() }
    pub fn clients(&self) -> usize { self.clients.load(Ordering::SeqCst) }
    pub fn connect(&self) { if self.clients.fetch_add(1, Ordering::SeqCst) == 0 { self.joined.notify_waiters(); } }
    pub fn disconnect(&self) { self.clients.fetch_sub(1, Ordering::SeqCst); }
}

pub struct Ctx {
    pub demo: bool,
    /// public/, views/, native/, agent/: next to the binary when bundled, the repo in development
    pub res: PathBuf,
    /// ~/Library/Application Support/DevDock: settings, machines, keys; outside the bundle so updates keep it
    pub data: PathBuf,
    pub version: String,
    pub build: String,
    pub settings: Settings,
    pub table: RwLock<Arc<Table>>,
    sampler: Mutex<Sampler>,
    pub scanner: Scanner,
    snapshot: RwLock<Option<Arc<Snapshot>>>,
    scanning: tokio::sync::Mutex<()>,
    last_ports: Mutex<String>,
    ports_poke: Notify,
    pub claude: crate::detect::ClaudeStates,
    pub hub: Hub,
    /// plain HTTP to this Mac's own servers: no proxy, no redirects
    pub local_http: reqwest::Client,
    /// HTTPS to GitHub and the plan-usage services
    pub http: reqwest::Client,
    pub sources: crate::sources::Sources,
}

static CTX: OnceLock<Ctx> = OnceLock::new();

type Notifier = Box<dyn Fn(&str, &str) + Send + Sync>;
static NOTIFY: OnceLock<Notifier> = OnceLock::new();

/// How the app shows a notification; `serve` has none (a browser page notifies itself)
pub fn set_notifier(f: impl Fn(&str, &str) + Send + Sync + 'static) { let _ = NOTIFY.set(Box::new(f)); }

fn notify(title: &str, body: &str) { if let Some(f) = NOTIFY.get() { f(title, body); } }

/// Ports that came up or went down since the last scan, as notifications. The scan only lists a
/// port after it survived 2 scans and drops it after 2 misses, so these are real changes.
pub fn port_changes(before: &[Value], after: &[Value]) -> Vec<(String, String)> {
    let port = |p: &Value| p["port"].as_u64();
    let mut out = vec![];
    for p in after.iter().filter(|p| !before.iter().any(|b| port(b) == port(p))) {
        out.push((format!("Port {} is up", p["port"]), format!("{} process started ({})", p.str_of("runtimeName"), p.str_of("command"))));
    }
    for p in before.iter().filter(|b| !after.iter().any(|p| port(p) == port(b))) {
        out.push((format!("Port {} is down", p["port"]), format!("{} process stopped", p.str_of("runtimeName"))));
    }
    out
}

pub fn ctx() -> &'static Ctx { CTX.get().expect("state::init runs first") }

pub fn init(res: PathBuf, data: PathBuf, settings_file: PathBuf, demo: bool) -> &'static Ctx {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (version, build) = build_info(&res);
    CTX.get_or_init(|| Ctx {
        demo, res, data, version, build,
        settings: Settings::load(settings_file),
        table: RwLock::new(Arc::new(Table::new())),
        sampler: Mutex::new(Sampler::default()),
        scanner: Scanner::default(),
        snapshot: RwLock::new(None),
        scanning: tokio::sync::Mutex::new(()),
        last_ports: Mutex::new(String::new()),
        ports_poke: Notify::new(),
        claude: Default::default(),
        hub: Hub::new(),
        local_http: reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().expect("http client"),
        http: reqwest::Client::builder().user_agent("DevDock").timeout(Duration::from_secs(10)).build().expect("https client"),
        sources: crate::sources::Sources::default(),
    })
}

/// Version from the bundle, build from build.json (written at build time) or "dev"
fn build_info(res: &std::path::Path) -> (String, String) {
    let v: Value = std::fs::read_to_string(res.join("build.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    (v["version"].as_str().unwrap_or(env!("CARGO_PKG_VERSION")).to_string(), v["build"].as_str().unwrap_or("dev").to_string())
}

impl Ctx {
    pub fn table(&self) -> Arc<Table> { self.table.read().unwrap().clone() }

    /// Confirmed ports from the latest scan
    pub fn ports(&self) -> Vec<Value> { self.snapshot.read().unwrap().as_ref().map(|s| s.ports.clone()).unwrap_or_default() }

    pub fn poke_ports(&self) { self.ports_poke.notify_one(); }

    /// A fresh process table and port scan; scans never overlap
    pub async fn scan(&self) {
        let _g = self.scanning.lock().await;
        let table = if self.demo { crate::demo::table() } else { tokio::task::block_in_place(|| self.sampler.lock().unwrap().sample()) };
        *self.table.write().unwrap() = table.clone();
        let snap = if self.demo {
            let (snap, health) = crate::demo::ports();
            self.scanner.seed(health, crate::demo::get("transient").as_array().cloned().unwrap_or_default());
            snap
        } else { self.scanner.scan(&table, &self.settings).await };
        let before = self.snapshot.read().unwrap().as_ref().map(|s| s.ports.clone());
        if let Some(before) = before {
            if self.settings.get()["notifications"] == json!(true) {
                for (title, body) in port_changes(&before, &snap.ports) { notify(&title, &body); }
            }
        }
        *self.snapshot.write().unwrap() = Some(Arc::new(snap));
        self.broadcast_ports(false);
    }

    pub fn payload(&self) -> Value {
        let s = self.settings.get();
        let snap = self.snapshot.read().unwrap().clone();
        let ports = snap.as_ref().map(|s| s.ports.clone()).unwrap_or_default();
        let favorites = s["favorites"].as_array().cloned().unwrap_or_default();
        let key = |port: &Value, path: &Value| format!("{port}:{path}");
        let running: std::collections::HashSet<String> = ports.iter().map(|p| key(&p["port"], &p["scriptPath"])).collect();
        let history: Vec<Value> = if s["showHistory"] != json!(false) {
            s["history"].as_array().cloned().unwrap_or_default().into_iter()
                .filter(|h| !running.contains(&key(&h["port"], &h["scriptPath"])))
                .map(|mut h| {
                    h["stopped"] = json!(true);
                    h["pathExists"] = json!(h["scriptPath"].as_str().is_some_and(|p| std::path::Path::new(p).exists()));
                    h["favorite"] = json!(favorites.contains(&h["port"]));
                    h
                }).collect()
        } else { vec![] };
        json!({
            "timestamp": snap.as_ref().map(|s| s.timestamp.clone()).unwrap_or_else(|| crate::ports::iso(now_ms())),
            "count": ports.len(),
            "ports": ports,
            "history": history,
            "transient": self.scanner.transient(now_ms() - 10 * 60 * 1000),
        })
    }

    /// Push the ports when something visible changed (cpu and memory included, the timestamp not)
    pub fn broadcast_ports(&self, force: bool) {
        if self.hub.clients() == 0 { self.last_ports.lock().unwrap().clear(); return; }
        let mut body = self.payload();
        let sig = json!([body["ports"], body["history"].as_array().map_or(0, |a| a.len()), body["transient"].as_array().map_or(0, |a| a.len())]).to_string();
        {
            let mut last = self.last_ports.lock().unwrap();
            if sig == *last && !force { return; }
            *last = sig;
        }
        body["type"] = json!("ports");
        self.hub.send(body.to_string());
    }

    /// The main loop: every second while a page is open, every 5 seconds otherwise (the menu bar
    /// count, history and the idle reaper still need it)
    pub async fn ports_loop(&'static self) {
        loop {
            self.scan().await;
            let wait = if self.hub.clients() > 0 { 1 } else { 5 };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
                _ = self.ports_poke.notified() => {}
                _ = self.hub.joined.notified() => {}
            }
        }
    }

    /// Health of every live port again every 10s; the opt-in idle reaper every minute
    pub async fn housekeeping(&'static self) {
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            tick += 1;
            let live: Vec<u16> = self.ports().iter().filter_map(|p| p["port"].as_u64().map(|x| x as u16)).collect();
            self.scanner.reprobe(&live);
            if tick % 6 == 0 { self.reap_idle(); }
        }
    }

    /// Opt-in idle reaper. Never touches favorites, apps, or processes without a project dir.
    fn reap_idle(&self) {
        let s = self.settings.get();
        if s["autoKillIdle"] != json!(true) || s["idleAfterHours"].as_f64().unwrap_or(0.0) <= 0.0 || self.demo { return; }
        let me = std::process::id() as i32;
        let reaped: Vec<Value> = self.ports().into_iter().filter(|p| p["idle"] == json!(true) && p["favorite"] != json!(true)).filter_map(|p| {
            let pid: i32 = p["pid"].as_str()?.parse().ok()?;
            (pid != me && unsafe { libc::kill(pid, libc::SIGTERM) } == 0).then(|| json!({ "port": p["port"], "pid": p["pid"], "path": p["scriptPath"] }))
        }).collect();
        if reaped.is_empty() { return; }
        let ports: Vec<String> = reaped.iter().map(|r| format!(":{}", r["port"])).collect();
        notify("Idle servers stopped", &format!("Auto-killed {}: {}", reaped.len(), ports.join(", ")));
        self.hub.send(json!({ "type": "reaped", "reaped": reaped }).to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn announces_ports_that_came_and_went() {
        let p = |port: u64| json!({ "port": port, "runtimeName": "Node.js", "command": "node" });
        let c = port_changes(&[p(3000), p(4000)], &[p(4000), p(5173)]);
        assert_eq!(c, [("Port 5173 is up".into(), "Node.js process started (node)".into()), ("Port 3000 is down".into(), "Node.js process stopped".into())]);
        assert!(port_changes(&[p(1)], &[p(1)]).is_empty());
    }
}

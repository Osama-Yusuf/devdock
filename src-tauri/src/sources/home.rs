//! Home tab: only what needs attention right now. Every rule waits for a condition to hold
//! for a while (a build pinning the CPU for 20s is normal), and every item has a fix next to it.
//! Reads the other sources' latest scans; keeps 15 minutes of CPU and memory per process.
use crate::state::Ctx;
use crate::sys::{self, CpuTicks};
use crate::table::Table;
use crate::util::{basename, find_bin, now_ms, run, ApiErr, ApiResult, Get};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

pub const MIN: i64 = 60 * 1000;
const KEEP: i64 = 15 * MIN;
const RUNAWAY_CPU: f64 = 200.0; // % of one core: two cores flat out
const RUNAWAY_FOR: i64 = 3 * MIN;
const LEAK_MB: f64 = 1500.0;
const LEAK_FOR: i64 = 10 * MIN;
const LEAK_GROWTH: f64 = 1.25; // grew a quarter in those 10 minutes
const NEEDS_YOU_AFTER: i64 = MIN; // a permission prompt answered at once never shows
const FINISHED_FOR: i64 = 15 * MIN;
const FORGOTTEN_AFTER: i64 = 6 * 60 * MIN;
const CRASH_RESTARTS: i64 = 3;
const LIMIT_AT: f64 = 80.0; // % of a plan window used before Home warns (20% left)

/// One reading of a process: when, CPU (% of a core), memory (MB)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample { pub t: i64, pub cpu: f64, pub mem: f64 }

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Runaway { pub since: i64, pub value: f64 }

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Leak { pub since: i64, pub from: f64, pub value: f64, pub rate: f64 }

/// CPU pinned for minutes; a short dip (GC, a pause between requests) doesn't reset it
pub fn runaway(list: &[Sample], now: i64) -> Option<Runaway> {
    if list.is_empty() || now - list[0].t < RUNAWAY_FOR { return None; }
    let recent: Vec<&Sample> = list.iter().filter(|s| now - s.t <= RUNAWAY_FOR).collect();
    let hot = recent.iter().filter(|s| s.cpu >= RUNAWAY_CPU).count();
    if (hot as f64) < recent.len() as f64 * 0.9 { return None; }
    let mut since = now;
    for s in list.iter().rev() { if s.cpu < RUNAWAY_CPU * 0.8 { break; } since = s.t; }
    Some(Runaway { since, value: recent.iter().map(|s| s.cpu).sum::<f64>() / recent.len() as f64 })
}

/// Memory past 1.5 GB that grew a quarter in 10 minutes and is still climbing
pub fn leak(list: &[Sample], now: i64) -> Option<Leak> {
    let cur = list.last()?;
    if cur.mem < LEAK_MB || now - list[0].t < LEAK_FOR { return None; }
    let start = list.iter().find(|s| now - s.t <= LEAK_FOR).unwrap_or(&list[0]);
    if cur.mem < start.mem * LEAK_GROWTH { return None; }
    // still climbing: each third of the window averages higher than the one before
    let third = list.len() / 3;
    let avg = |a: &[Sample]| a.iter().map(|s| s.mem).sum::<f64>() / a.len() as f64; // empty: NaN, so it fails below
    let (a, b, c) = (avg(&list[..third]), avg(&list[third..2 * third]), avg(&list[2 * third..]));
    if !(a < b && b < c) { return None; }
    Some(Leak { since: start.t, from: start.mem, value: cur.mem, rate: (cur.mem - start.mem) / ((now - start.t) as f64 / MIN as f64) })
}

impl Runaway { pub fn json(&self) -> Value { json!({ "since": self.since, "value": self.value }) } }
impl Leak { pub fn json(&self) -> Value { json!({ "since": self.since, "from": self.from, "value": self.value, "rate": self.rate }) } }

/// 24 points for a sparkline
fn spark<T>(list: &[T], f: impl Fn(&T) -> f64) -> Vec<i64> {
    let step = (list.len() / 24).max(1);
    list.iter().enumerate().filter(|(i, _)| i % step == 0 || *i == list.len() - 1).map(|(_, s)| f(s).round() as i64).collect()
}

/// Copy the keys `v` has (a JS spread of picked fields leaves out undefined ones)
fn pick(v: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|k| v.get(*k).map(|x| (k.to_string(), x.clone()))).collect()
}
fn num(v: &Value) -> f64 { v.as_f64().unwrap_or(0.0) }
fn truthy(v: &Value) -> bool {
    match v { Value::Null => false, Value::Bool(b) => *b, Value::Number(n) => n.as_f64() != Some(0.0), Value::String(s) => !s.is_empty(), _ => true }
}
/// A pid as the page sends it: "41200" or 41200
fn pid_str(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_else(|| v.to_string()) }

#[derive(Clone, Copy)]
struct Total { t: i64, cpu: f64, mem: f64, mcpu: f64, mmem: f64 }
#[derive(Clone, Copy)]
struct Rate { t: i64, rx: f64, tx: f64 }

#[derive(Default)]
struct Net { iface: Option<String>, iface_at: i64, ts_ip: Option<String>, prev: Option<(i64, u64, u64)>, hist: Vec<Rate> }

#[derive(Default)]
struct State {
    samples: HashMap<String, Vec<Sample>>,
    totals: Vec<Total>,
    cpu: Option<CpuTicks>,
    net: Net,
}

#[derive(Default)]
pub struct Home { st: Mutex<State>, top: crate::top::Top }

/// What the rules found and the sums for the vitals
struct Found { items: Vec<Value>, servers: usize, sum_cpu: f64, sum_mem: f64 }

impl State {
    fn record(&mut self, key: &str, cpu: f64, mem: f64, now: i64) -> Vec<Sample> {
        let list = self.samples.entry(key.to_string()).or_default();
        list.push(Sample { t: now, cpu, mem });
        list.retain(|s| now - s.t <= KEEP);
        list.clone()
    }

    fn rules(&mut self, now: i64, procs: &Table, ports: &[Value], agents: &[Value], docker: Option<&Value>, limits: Option<&Value>) -> Found {
        let mut items = vec![];
        let mut live = HashSet::new();

        // one server per pid (a server on 3000 and 3001 is one process); in the order the ports came
        let mut servers: Vec<(String, Value)> = vec![];
        for p in ports {
            let sp = p.str_of("scriptPath");
            if sp.is_empty() || sp == "/" || truthy(&p["appName"]) { continue; }
            let pid = pid_str(&p["pid"]);
            match servers.iter_mut().find(|(k, _)| *k == pid) {
                Some((_, s)) => s["ports"].as_array_mut().unwrap().push(p["port"].clone()),
                None => { let mut s = p.clone(); s["ports"] = json!([p["port"]]); servers.push((pid, s)); }
            }
        }
        let server_subject = |s: &Value| -> Value {
            let mut o = pick(s, &["pid", "runtime", "ports", "branch", "runtimeIcon", "runtimeColor"]);
            o.insert("kind".into(), json!("server"));
            let key = if truthy(&s["procName"]) { "procName" } else { "runtimeName" };
            if let Some(n) = s.get(key) { o.insert("name".into(), n.clone()); }
            if let Some(c) = s.get("scriptPath") { o.insert("cwd".into(), c.clone()); }
            Value::Object(o)
        };
        let agent_subject = |a: &Value| -> Value {
            let mut o = pick(a, &["pid", "name", "agent", "cwd", "branch", "where", "ports"]);
            o.insert("kind".into(), json!("agent"));
            Value::Object(o)
        };

        // Runaway CPU and memory leaks, for servers and agents (an agent counts everything it started)
        let mut flagged: HashSet<String> = HashSet::new(); // servers already flagged: their agent isn't flagged for the same thing
        let mut watch = |st: &mut State, items: &mut Vec<Value>, key: String, subject: Value, cpu: f64, mem: f64, skip: &dyn Fn(&str, &HashSet<String>) -> bool| {
            live.insert(key.clone());
            let list = st.record(&key, cpu, mem, now);
            let pid = pid_str(&subject["pid"]);
            if let Some(r) = runaway(&list, now) { if !skip("cpu", &flagged) {
                flagged.insert(format!("cpu:{pid}"));
                items.push(json!({ "id": format!("cpu:{key}"), "type": "cpu", "severity": "critical", "subject": subject, "since": r.since, "value": r.value, "spark": spark(&list, |s| s.cpu) }));
            } }
            if let Some(l) = leak(&list, now) { if !skip("mem", &flagged) {
                flagged.insert(format!("mem:{pid}"));
                items.push(json!({ "id": format!("mem:{key}"), "type": "mem", "severity": "critical", "subject": subject, "since": l.since, "value": l.value, "from": l.from, "rate": l.rate, "spark": spark(&list, |s| s.mem) }));
            } }
        };
        for (pid, s) in &servers { watch(self, &mut items, format!("p{pid}"), server_subject(s), num(&s["cpu"]), num(&s["memMB"]), &|_, _| false); }
        let port_pid: HashMap<String, String> = ports.iter().map(|p| (p["port"].to_string(), pid_str(&p["pid"]))).collect();
        for a in agents {
            let aports: Vec<String> = a["ports"].as_array().map(|x| x.iter().map(|p| p.to_string()).collect()).unwrap_or_default();
            let skip = |ty: &str, flagged: &HashSet<String>| aports.iter().any(|p| port_pid.get(p).is_some_and(|pid| flagged.contains(&format!("{ty}:{pid}"))));
            watch(self, &mut items, format!("a{}", pid_str(&a["pid"])), agent_subject(a), num(&a["cpu"]), num(&a["memMB"]), &skip);
        }
        self.samples.retain(|k, _| live.contains(k));

        // Totals count each process once: an agent's tree often holds the very servers listed above
        let mut sum_cpu: f64 = servers.iter().map(|(_, s)| num(&s["cpu"])).sum();
        let mut sum_mem: f64 = servers.iter().map(|(_, s)| num(&s["memMB"])).sum();
        let mut counted: HashSet<String> = servers.iter().map(|(k, _)| k.clone()).collect();
        for a in agents {
            let Some(pids) = a["pids"].as_array() else { sum_cpu += num(&a["cpu"]); sum_mem += num(&a["memMB"]); continue };
            for x in pids {
                let k = pid_str(x);
                if counted.insert(k.clone()) {
                    if let Some(p) = k.parse::<i32>().ok().and_then(|n| procs.get(&n)) { sum_cpu += p.cpu; sum_mem += p.mem_mb; }
                }
            }
        }

        // Agents waiting on you, and ones that just finished a turn
        for a in agents {
            let st = &a["state"];
            let since = st["since"].as_i64();
            if st.str_of("status") == "needs-you" && now - since.unwrap_or(now) >= NEEDS_YOU_AFTER {
                items.push(json!({ "id": format!("needs:{}", pid_str(&a["pid"])), "type": "needs-you", "severity": "needs-you", "subject": agent_subject(a), "since": st["since"] }));
            } else if let (Some(since), "idle") = (since.filter(|s| *s != 0), st.str_of("status")) {
                // idle a little while after a turn (not just launched): it finished something
                if now - since <= FINISHED_FOR && since - a["startedAt"].as_i64().unwrap_or(0) > MIN {
                    items.push(json!({ "id": format!("done:{}:{since}", pid_str(&a["pid"])), "type": "finished", "severity": "done", "subject": agent_subject(a), "since": since }));
                }
            }
        }

        // Crash loops: Docker says "restarting"; Kubernetes names each attempt k8s_<container>_<pod>_<ns>_<uid>_<attempt>
        // ponytail: a pod that crashed 3 times days ago and has run fine since is skipped by the 15 min freshness check
        for c in docker.and_then(|d| d["containers"].as_array()).into_iter().flatten() {
            let k8s = &c["k8s"];
            let name = c.str_of("name");
            let attempt = if truthy(k8s) && !truthy(&k8s["sandbox"]) { trailing_number(name, '_').unwrap_or(0) } else { 0 };
            let created = c["createdAt"].as_i64().unwrap_or(0);
            let looping = c.str_of("state") == "restarting" || (attempt >= CRASH_RESTARTS && now - created <= 15 * MIN);
            if !looping { continue; }
            let restarts = if attempt != 0 { attempt } else { restarting_count(c.str_of("status")).unwrap_or(0) };
            let id = if truthy(k8s) { format!("{}/{}/{}", js_str(&k8s["namespace"]), js_str(&k8s["pod"]), js_str(&k8s["container"])) } else { js_str(&c["id"]) };
            let mut subject = json!({ "kind": "container", "id": c["id"], "image": c["image"], "status": c["status"] });
            subject["name"] = if truthy(k8s) { if truthy(&k8s["container"]) { k8s["container"].clone() } else { k8s["pod"].clone() } } else { c["name"].clone() };
            if truthy(k8s) {
                if let Some(x) = k8s.get("pod") { subject["pod"] = x.clone(); }
                if let Some(x) = k8s.get("namespace") { subject["namespace"] = x.clone(); }
            }
            items.push(json!({ "id": format!("crash:{id}"), "type": "crash", "severity": "critical", "subject": subject, "since": c["createdAt"], "value": restarts }));
        }

        // Forgotten: nothing owns it any more and it has done nothing for hours
        let mut forgotten: Vec<Value> = vec![];
        for (_, s) in &servers {
            let la = s["lastActive"].as_i64().filter(|x| *x != 0);
            if let Some(la) = la { if truthy(&s["orphan"]) && now - la >= FORGOTTEN_AFTER {
                let mut f = server_subject(s);
                f["memMB"] = json!(num(&s["memMB"]));
                f["idleSince"] = json!(la);
                forgotten.push(f);
            } }
        }
        for a in agents {
            let w = &a["where"];
            let loose = !truthy(&w["mux"]) && !truthy(&w["app"]) && !truthy(&w["background"]);
            let st = &a["state"];
            let started = a["startedAt"].as_i64().filter(|x| *x != 0);
            let quiet = if truthy(st) {
                st.str_of("status") == "idle" && now - st["since"].as_i64().filter(|x| *x != 0).unwrap_or(now) >= FORGOTTEN_AFTER
            } else { now - started.unwrap_or(now) >= FORGOTTEN_AFTER };
            if loose && quiet {
                let mut f = agent_subject(a);
                f["memMB"] = json!(num(&a["memMB"]));
                let since = st["since"].as_i64().filter(|x| *x != 0);
                f["idleSince"] = match since { Some(s) => json!(s), None => a.get("startedAt").cloned().unwrap_or(Value::Null) };
                forgotten.push(f);
            }
        }
        if !forgotten.is_empty() {
            let mut ids: Vec<String> = forgotten.iter().map(|f| pid_str(&f["pid"])).collect();
            ids.sort();
            let value: f64 = forgotten.iter().map(|f| num(&f["memMB"])).sum();
            items.push(json!({ "id": format!("forgotten:{}", ids.join(",")), "type": "forgotten", "severity": "tidy", "subjects": forgotten, "value": value }));
        }

        // Duplicates: two unrelated servers from the same folder (not a parent and its worker)
        let related = |a: &str, b: &str| -> bool {
            let mut cur = a.parse::<i32>().ok();
            for _ in 0..40 {
                let Some(c) = cur else { return false };
                if c == 1 { return false; }
                if c.to_string() == b { return true; }
                cur = procs.get(&c).map(|p| p.ppid);
            }
            false
        };
        let mut by_folder: Vec<(String, Vec<&(String, Value)>)> = vec![];
        for s in &servers {
            let k = s.1.str_of("scriptPath").to_string();
            match by_folder.iter_mut().find(|(f, _)| *f == k) { Some((_, l)) => l.push(s), None => by_folder.push((k, vec![s])) }
        }
        for (cwd, list) in &by_folder {
            let mut top: Vec<&(String, Value)> = list.iter().filter(|s| !list.iter().any(|o| o.0 != s.0 && related(&s.0, &o.0))).copied().collect();
            if top.len() < 2 { continue; }
            top.sort_by_key(|s| s.1["startedAt"].as_i64().unwrap_or(0));
            items.push(json!({ "id": format!("dup:{}", top.iter().map(|s| s.0.as_str()).collect::<Vec<_>>().join(",")), "type": "duplicate", "severity": "tidy",
                "subjects": top.iter().map(|s| server_subject(&s.1)).collect::<Vec<_>>(), "name": basename(cwd), "cwd": cwd }));
        }

        // A coding plan running low: under 20% of a window left. The reset time is in the id,
        // so each window alerts once and the card goes away when it resets.
        for t in limits.and_then(|l| l["tools"].as_array()).into_iter().flatten() {
            for l in t["limits"].as_array().into_iter().flatten() {
                if num(&l["used"]) >= LIMIT_AT {
                    let mut it = json!({ "id": format!("limit:{}:{}:{}", js_str(&t["tool"]), js_str(&l["label"]), if truthy(&l["resetsAt"]) { js_str(&l["resetsAt"]) } else { String::new() }),
                        "type": "limit", "severity": "limit", "tool": t["tool"], "plan": t["plan"], "label": l["label"], "used": l["used"] });
                    if let Some(r) = l.get("resetsAt") { it["resetsAt"] = r.clone(); }
                    items.push(it);
                }
            }
        }
        Found { items, servers: servers.len(), sum_cpu, sum_mem }
    }
}

/// A value as JS's template string writes it
fn js_str(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), Value::Null => "null".into(), v if v.is_number() => v.to_string(), _ => "undefined".into() }
}
/// k8s_web_pod_ns_uid_4 -> 4
fn trailing_number(s: &str, sep: char) -> Option<i64> {
    let (_, n) = s.rsplit_once(sep)?;
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then(|| n.parse().ok()).flatten()
}
/// "Restarting (5) 12 seconds ago" -> 5
fn restarting_count(status: &str) -> Option<i64> {
    let rest = &status[status.find("Restarting (")? + 12..];
    let n = &rest[..rest.find(')')?];
    n.parse().ok().filter(|_| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

const TS_APP: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// Tailscale's address, from Tailscale itself: 100.64.0.0/10 alone also means carrier NAT or another VPN
async fn tailscale_ip() -> Option<String> {
    let bin = find_bin("tailscale").or_else(|| std::path::Path::new(TS_APP).exists().then(|| TS_APP.to_string()))?;
    let out = run(&bin, &["ip", "-4"], Duration::from_secs(3)).await.stdout;
    let ip = out.trim().split('\n').next().unwrap_or("").to_string();
    ip.parse::<std::net::Ipv4Addr>().is_ok().then_some(ip)
}

/// The interface the default route uses
async fn default_iface() -> Option<String> {
    let out = run("/sbin/route", &["-n", "get", "default"], Duration::from_secs(3)).await.stdout;
    out.lines().find_map(|l| l.trim().strip_prefix("interface:")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl Home {
    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo { return Ok(crate::demo::get("home")); }
        let now = now_ms();
        let (procs, ports) = (c.table(), c.ports());
        let agents = c.sources.coding.last();
        let (docker, limits) = (c.sources.containers.last(), c.sources.limits.last());
        let net = self.network(now).await;
        let mut st = self.st.lock().unwrap();
        let f = st.rules(now, &procs, &ports, &agents, docker.as_ref(), limits.as_ref());
        // the whole Mac, like Activity Monitor: CPU load %, Memory Used, and the startup disk
        let ticks = sys::cpu_ticks();
        let mc = match (st.cpu, ticks) { (Some(p), Some(t)) => sys::cpu_percent(p, t), _ => None };
        st.cpu = ticks;
        let mm = sys::memory_used_mb();
        let md = sys::disk("/").map(|(total, free)| json!({ "total": total, "free": free }));
        st.totals.push(Total { t: now, cpu: f.sum_cpu, mem: f.sum_mem, mcpu: mc.unwrap_or(0.0), mmem: mm.unwrap_or(0.0) });
        st.totals.retain(|x| now - x.t <= KEEP);
        let status = |s: &str| agents.iter().filter(|a| a["state"].str_of("status") == s).count();
        let t = &st.totals;
        Ok(json!({
            "items": f.items,
            "vitals": {
                "servers": f.servers, "agents": agents.len(),
                "working": status("working"), "needsYou": status("needs-you"),
                "unknown": agents.iter().filter(|a| !truthy(&a["state"])).count(), // only Claude Code reports its state
                "cpu": f.sum_cpu, "mem": f.sum_mem, "cpuSpark": spark(t, |x| x.cpu), "memSpark": spark(t, |x| x.mem),
                "cores": sys::cores(), "totalMem": sys::total_memory() as f64 / 1048576.0,
                "machine": { "cpu": mc, "mem": mm, "disk": md, "cpuSpark": spark(t, |x| x.mcpu), "memSpark": spark(t, |x| x.mmem) },
                "net": net,
            },
        }))
    }

    /// Network speed of the interface the default route uses, from its byte counters.
    /// ponytail: one interface; traffic on a VPN that isn't the default route isn't counted.
    async fn network(&self, now: i64) -> Value {
        let stale = { let st = self.st.lock().unwrap(); st.net.iface.is_none() || now - st.net.iface_at > 30_000 };
        if stale {
            let (iface, ts) = (default_iface().await, tailscale_ip().await);
            let mut st = self.st.lock().unwrap();
            st.net.iface = iface;
            st.net.ts_ip = ts;
            st.net.iface_at = now;
        }
        let mut st = self.st.lock().unwrap();
        let n = &mut st.net;
        let Some(iface) = n.iface.clone() else { return Value::Null };
        let Some((rx, tx)) = sys::iface_bytes(&iface) else { return Value::Null };
        if let Some((t, prx, ptx)) = n.prev { if rx >= prx && tx >= ptx {
            let secs = match (now - t) as f64 / 1000.0 { 0.0 => 1.0, s => s };
            n.hist.push(Rate { t: now, rx: (rx - prx) as f64 / secs, tx: (tx - ptx) as f64 / secs });
            n.hist.retain(|h| now - h.t <= KEEP);
        } }
        n.prev = Some((now, rx, tx));
        let addrs = sys::ipv4_addrs();
        let last = n.hist.last().copied().unwrap_or(Rate { t: 0, rx: 0.0, tx: 0.0 });
        json!({
            "iface": iface, "rx": last.rx, "tx": last.tx, "rxSpark": spark(&n.hist, |h| h.rx), "txSpark": spark(&n.hist, |h| h.tx),
            "lan": addrs.iter().find(|(name, _)| *name == iface).map(|(_, ip)| ip),
            "tailscale": n.ts_ip.as_ref().filter(|ip| addrs.iter().any(|(_, a)| a == *ip)), // only while it's up on this Mac
        })
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        match name {
            // what's using the CPU, memory, disk or network, for the panels under Home's vitals
            "top" => Ok(self.top.scan(c, match p.str_of("by") { b @ ("mem" | "disk" | "net") => b, _ => "cpu" }).await),
            "kill" | "reveal" => Self::process(c, name, p).await,
            _ => Err(crate::sources::unknown()),
        }
    }
}

impl Home {
    /// A process from a panel: only yours, only one in the latest table, never DevDock
    async fn process(c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        let pid = crate::util::pid_of(&p["pid"]).ok_or_else(|| ApiErr::bad("Invalid PID"))?;
        let t = c.table();
        let proc = t.get(&pid).ok_or_else(|| ApiErr::gone("That process is gone"))?;
        if proc.uid != unsafe { libc::getuid() } { return Err(ApiErr::bad("That process belongs to macOS or another user")); }
        if name == "reveal" {
            if !proc.comm.starts_with('/') || !std::path::Path::new(&proc.comm).exists() { return Err(ApiErr::gone("Can't tell where it lives")); }
            run("/usr/bin/open", &["-R", &proc.comm], Duration::from_secs(10)).await;
            return Ok(json!({}));
        }
        if pid == std::process::id() as i32 { return Err(ApiErr::bad("That's DevDock itself")); }
        // the pid the page showed may have ended and been reused since
        if let Some(s) = p["started"].as_i64() { if proc.started_at != Some(s) { return Err(ApiErr::gone("That process is gone")); } }
        let sig = if p["force"].as_bool().unwrap_or(false) { libc::SIGKILL } else { libc::SIGTERM };
        if unsafe { libc::kill(pid, sig) } != 0 { return Err(ApiErr::new(500, format!("Couldn't stop {pid}: {}", std::io::Error::last_os_error()))); }
        c.poke_ports();
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// series(minute) -> (cpu, mem), sampled every 5 s for 15 min, like test/home.test.js
    fn run_series(series: impl Fn(f64) -> (f64, f64)) -> Vec<String> {
        let mut st = State::default();
        let mut now = 1_000_000_000_000;
        let mut out = vec![];
        let mut t = 0;
        while t <= 15 * 60 {
            let (cpu, mem) = series(t as f64 / 60.0);
            let server = json!({ "pid": "10", "port": 3000, "scriptPath": "/code/app", "procName": "node", "cpu": cpu, "memMB": mem });
            out = st.rules(now, &Table::new(), &[server], &[], None, None).items;
            t += 5;
            now += 5000;
        }
        out.iter().map(|i| i.str_of("type").to_string()).collect()
    }

    #[test]
    fn pinned_cpu_for_minutes_is_runaway_a_short_spike_is_not() {
        assert_eq!(run_series(|m| (if m > 5.0 { 250.0 } else { 5.0 }, 300.0)), ["cpu"]);
        assert!(run_series(|m| (if m > 14.0 { 400.0 } else { 5.0 }, 300.0)).is_empty());
    }

    #[test]
    fn steady_growth_past_1_5_gb_is_a_leak_a_big_flat_process_is_not() {
        assert_eq!(run_series(|m| (1.0, 1000.0 + m * 60.0)), ["mem"]);
        assert!(run_series(|_| (1.0, 3000.0)).is_empty());
    }

    #[test]
    fn counts_a_server_once_when_a_coding_agent_started_it() {
        // agent 3 (200 MB) started server 5 (300 MB): the real total is 500 MB, not 800
        let mut procs = Table::new();
        procs.insert(3, crate::table::Proc { pid: 3, cpu: 1.0, mem_mb: 200.0, ..Default::default() });
        procs.insert(5, crate::table::Proc { pid: 5, cpu: 2.0, mem_mb: 300.0, ..Default::default() });
        let ports = [json!({ "pid": "5", "port": 3000, "scriptPath": "/tmp/app", "cpu": 2, "memMB": 300 })];
        let agents = [json!({ "pid": 3, "pids": [3, 5], "agent": "Codex", "cpu": 3, "memMB": 500, "ports": [3000], "startedAt": now_ms() })];
        let f = State::default().rules(now_ms(), &procs, &ports, &agents, None, None);
        assert_eq!((f.sum_mem, f.sum_cpu), (500.0, 3.0));
    }

    #[test]
    fn crash_loops_duplicates_and_limits() {
        let now = 1_000_000_000_000;
        let docker = json!({ "containers": [
            { "id": "a", "name": "web-1", "image": "x", "state": "restarting", "status": "Restarting (5) 12 seconds ago", "createdAt": now - 1000, "k8s": null },
            { "id": "b", "name": "k8s_api_pod-1_default_uid_4", "image": "y", "state": "running", "status": "Up", "createdAt": now - 1000, "k8s": { "namespace": "default", "pod": "pod-1", "container": "api" } },
            { "id": "c", "name": "k8s_ok_pod-2_default_uid_1", "image": "y", "state": "running", "status": "Up", "createdAt": now - 1000, "k8s": { "namespace": "default", "pod": "pod-2", "container": "ok" } },
        ] });
        let limits = json!({ "tools": [{ "tool": "Codex", "plan": "plus", "limits": [{ "label": "5-hour", "used": 91, "resetsAt": 7 }, { "label": "Weekly", "used": 10 }] }] });
        let mut procs = Table::new();
        procs.insert(21, crate::table::Proc { pid: 21, ppid: 20, ..Default::default() });
        let ports = [
            json!({ "pid": "20", "port": 3000, "scriptPath": "/code/web", "startedAt": 2 }),
            json!({ "pid": "21", "port": 3001, "scriptPath": "/code/web", "startedAt": 3 }), // its worker: not a duplicate
            json!({ "pid": "30", "port": 3002, "scriptPath": "/code/web", "startedAt": 1 }),
        ];
        let f = State::default().rules(now, &procs, &ports, &[], Some(&docker), Some(&limits));
        let ids: Vec<&str> = f.items.iter().map(|i| i.str_of("id")).collect();
        assert_eq!(ids, ["crash:a", "crash:default/pod-1/api", "dup:30,20", "limit:Codex:5-hour:7"]);
        assert_eq!(f.items[0]["value"], 5);
        assert_eq!(f.items[1]["value"], 4);
        assert!(f.items[0]["subject"].get("pod").is_none());
    }

    #[test]
    fn restart_counts() {
        assert_eq!(restarting_count("Restarting (12) 3 seconds ago"), Some(12));
        assert_eq!(restarting_count("Up 5 days"), None);
        assert_eq!(trailing_number("k8s_a_b_c_d_7", '_'), Some(7));
        assert_eq!(trailing_number("web", '_'), None);
    }
}

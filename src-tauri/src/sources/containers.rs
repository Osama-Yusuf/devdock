//! Docker containers, images, volumes and build cache, read from the Engine API over
//! its unix socket (exact bytes and timestamps; the CLI prints "33.4MB").
//!
//! Facts this relies on (Engine API v1.47 spec, checked against OrbStack's daemon, API 1.56):
//!   GET /system/df          Images[], Containers[], Volumes[] (UsageData.RefCount/Size), BuildCache[]
//!   GET /containers/{id}/json  State.StartedAt / State.FinishedAt ("0001-..." = never)
//!   Deleting anything still in use is refused by Docker itself with 409.
//!   Kubernetes on Docker (OrbStack, Docker Desktop, kind's nodes aside) labels each container
//!   io.kubernetes.pod.name/.namespace/.container.name; docker.type is "podsandbox" for
//!   the pause container that holds a pod's network.
//! Docker has no "last used" for images or volumes: it's the latest time a container
//! using them stopped, and "running" when one of them is up right now.
use crate::detect::parse_time;
use crate::sources::{unknown, TermSpec};
use crate::state::Ctx;
use crate::util::{find_bin, home, now_ms, round1, run, secs, ApiErr, ApiResult, Get};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const PINNED_API: f64 = 1.47; // stable /system/df shape; older daemons get their own version
const SOCKETS: [&str; 5] = ["~/.orbstack/run/docker.sock", "~/.docker/run/docker.sock", "/var/run/docker.sock", "~/.colima/default/docker.sock", "~/.rd/docker.sock"];
const SHELL: &str = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
const KEEP_MS: i64 = 15 * 60_000;

/// The daemon we talk to: its socket, the API version prefix, and a client bound to the socket
#[derive(Clone)]
struct Conn { socket: String, prefix: String, http: reqwest::Client }

/// One stats reading; CPU and network are rates, so each comes from this one and the one before
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Reading { t: i64, cpu: f64, sys: f64, rx: f64, tx: f64 }

/// A rate sample kept for the sparklines
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Usage { pub t: i64, pub cpu: f64, pub mem: f64, pub limit: f64, pub rx: f64, pub tx: f64 }

#[derive(Default)]
pub struct Containers {
    conn: Mutex<Option<Conn>>,
    /// latest scan; actions only accept ids from it
    last: Mutex<Option<Value>>,
    inspect: Mutex<HashMap<String, (String, Option<i64>)>>, // id -> (state, when it last ran)
    usage: Mutex<HashMap<String, Vec<Usage>>>,              // running id -> the last 15 min
    raw: Mutex<HashMap<String, Reading>>,                    // id -> previous reading
}

fn err(status: u16, msg: impl Into<String>) -> ApiErr { ApiErr::new(status, msg) }

/// encodeURIComponent: ids and names go into URL paths
pub fn encode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

fn filters(f: Value) -> String { format!("filters={}", encode(&f.to_string())) }

/// Compose files you pointed DevDock at after a stack's folder moved: stack name -> file
fn located_file(c: &Ctx) -> PathBuf { c.data.join("compose-files.json") }
fn located(c: &Ctx) -> Value {
    std::fs::read_to_string(located_file(c)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
}

pub fn k8s_of(labels: &Value) -> Value {
    let pod = labels.str_of("io.kubernetes.pod.name");
    if pod.is_empty() { return Value::Null; }
    let or_null = |k: &str| labels.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map_or(Value::Null, |s| json!(s));
    json!({
        "pod": pod, "namespace": or_null("io.kubernetes.pod.namespace"), "container": or_null("io.kubernetes.container.name"),
        "sandbox": labels.str_of("io.kubernetes.docker.type") == "podsandbox",
    })
}

/// "/v1.47", or the daemon's own version when it's older
pub fn prefix(api_version: &str) -> String {
    let v: f64 = api_version.parse().ok().filter(|v: &f64| *v > 0.0).unwrap_or(PINNED_API);
    format!("/v{:.2}", v.min(PINNED_API))
}

/// RFC 3339 from Docker; the zero time means never
fn docker_time(v: &Value) -> Option<i64> { v.as_str().filter(|s| !s.starts_with("0001-")).and_then(parse_time) }

/// One container from /system/df, as the page gets it (lastUsed and stats come after)
pub fn container(c: &Value) -> Value {
    let id = c.str_of("Id");
    let labels = &c["Labels"];
    let label = |k: &str| labels.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map_or(Value::Null, |s| json!(s));
    let name = c["Names"][0].as_str().unwrap_or(&id[..id.len().min(12)]);
    let mut ports: Vec<u64> = c["Ports"].as_array().into_iter().flatten().filter_map(|p| p["PublicPort"].as_u64()).filter(|p| *p > 0).collect();
    ports.sort();
    ports.dedup();
    json!({
        "id": id, "name": name.strip_prefix('/').unwrap_or(name),
        "image": c["Image"], "imageId": c["ImageID"], "state": c["State"], "status": c["Status"],
        "createdAt": c["Created"].as_i64().unwrap_or(0) * 1000,
        "lastUsed": null,
        "size": c["SizeRw"].as_i64().unwrap_or(0),
        "project": label("com.docker.compose.project"),
        "service": label("com.docker.compose.service"),
        "composeDir": label("com.docker.compose.project.working_dir"),
        "composeFiles": labels.str_of("com.docker.compose.project.config_files").split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
        "k8s": k8s_of(labels),
        "ports": ports,
        "volumes": c["Mounts"].as_array().into_iter().flatten().filter(|m| m.str_of("Type") == "volume").map(|m| m["Name"].clone()).collect::<Vec<_>>(),
    })
}

/// 30 points per series for sparklines
pub fn series(list: &[Usage], f: fn(&Usage) -> f64) -> Vec<f64> {
    let step = (list.len() / 30).max(1);
    list.iter().enumerate().filter(|(i, _)| i % step == 0 || *i == list.len() - 1).map(|(_, x)| round1(f(x))).collect()
}

/// localeCompare, near enough for names: case-insensitive, lowercase first on a tie.
/// ponytail: not ICU collation; accents sort by code point
fn locale_cmp(a: &str, b: &str) -> Ordering { a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a)) }

fn num(v: &Value) -> f64 { v.as_f64().unwrap_or(0.0) }
fn latest(list: &[&Value]) -> Value {
    let m = list.iter().map(|c| c["lastUsed"].as_i64().unwrap_or(0)).max().unwrap_or(0);
    if m > 0 { json!(m) } else { Value::Null }
}
fn any_running(list: &[&Value]) -> bool { list.iter().any(|c| c.str_of("state") == "running") }
fn sum(list: &[&Value], f: impl Fn(&Value) -> f64) -> f64 { list.iter().map(|x| f(x).max(0.0)).sum() }

/// Compose projects as stacks: their services, where the compose file lives, what they use.
/// `exists` and `located` are the file checks, passed in so tests (and demo mode) can fake them.
pub fn stacks_of(containers: &[Value], exists: impl Fn(&str) -> bool, located: &Value) -> Vec<Value> {
    let mut by: Vec<(String, Vec<&Value>)> = vec![];
    for c in containers.iter().filter(|c| c["project"].is_string() && c["k8s"].is_null()) {
        let p = c.str_of("project");
        match by.iter_mut().find(|(n, _)| n == p) { Some((_, l)) => l.push(c), None => by.push((p.to_string(), vec![c])) }
    }
    let mut out: Vec<Value> = by.into_iter().map(|(name, list)| {
        let mut files: Vec<String> = vec![];
        for f in list.iter().flat_map(|c| c["composeFiles"].as_array().cloned().unwrap_or_default()) {
            if let Some(f) = f.as_str() { if !files.iter().any(|x| x == f) { files.push(f.into()); } }
        }
        let live: Vec<&Value> = list.iter().copied().filter(|c| c.str_of("state") == "running").collect();
        let mut dir = list.iter().find(|c| c["composeDir"].is_string()).map(|c| c["composeDir"].clone()).unwrap_or(Value::Null);
        let mut found: Vec<String> = files.iter().filter(|f| exists(f)).cloned().collect();
        let moved = if found.is_empty() { located[&name].as_str().filter(|s| !s.is_empty()) } else { None };
        if let Some(m) = moved.filter(|m| exists(m)) {
            found = vec![m.to_string()];
            dir = json!(Path::new(m).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into()));
        }
        let mut services: Vec<Value> = list.iter().map(|c| json!({
            "id": c["id"], "name": if c["service"].is_string() { &c["service"] } else { &c["name"] },
            "state": c["state"], "status": c["status"], "image": c["image"],
        })).collect();
        services.sort_by(|a, b| locale_cmp(a.str_of("name"), b.str_of("name")));
        let mut ports: Vec<u64> = list.iter().flat_map(|c| c["ports"].as_array().cloned().unwrap_or_default()).filter_map(|p| p.as_u64()).collect();
        ports.sort();
        ports.dedup();
        json!({
            "name": name, "dir": dir, "files": files, "filesFound": found, "located": moved.is_some(),
            "services": services, "running": live.len(), "total": list.len(), "ports": ports,
            "cpu": live.iter().map(|c| num(&c["stats"]["cpu"])).sum::<f64>(),
            "mem": live.iter().map(|c| num(&c["stats"]["mem"])).sum::<f64>(),
            "lastUsed": latest(&list),
            "createdAt": list.iter().filter_map(|c| c["createdAt"].as_i64().filter(|t| *t > 0)).min(), // its oldest container
        })
    }).collect();
    out.sort_by(|a, b| (b["running"].as_u64() > Some(0)).cmp(&(a["running"].as_u64() > Some(0))).then_with(|| locale_cmp(a.str_of("name"), b.str_of("name"))));
    out
}

/// Images, volumes, build cache and what each prune would remove, from /system/df and the containers
pub fn summary(d: &Value, containers: &[Value]) -> Value {
    let arr = |k: &str| d[k].as_array().cloned().unwrap_or_default();
    let images: Vec<Value> = arr("Images").iter().map(|i| {
        let users: Vec<&Value> = containers.iter().filter(|c| c["imageId"] == i["Id"]).collect();
        let size = i["Size"].as_i64().unwrap_or(0);
        let shared = i["SharedSize"].as_i64().filter(|s| *s >= 0);
        json!({
            "id": i["Id"],
            "tags": i["RepoTags"].as_array().into_iter().flatten().filter(|t| t.as_str() != Some("<none>:<none>")).collect::<Vec<_>>(),
            "size": i["Size"],
            "unique": shared.map_or(size, |s| size - s), // freed if removed alone
            "createdAt": i["Created"].as_i64().unwrap_or(0) * 1000,
            "containers": users.len(), "running": any_running(&users), "lastUsed": latest(&users),
        })
    }).collect();
    let volumes: Vec<Value> = arr("Volumes").iter().map(|v| {
        let users: Vec<&Value> = containers.iter().filter(|c| c["volumes"].as_array().is_some_and(|a| a.contains(&v["Name"]))).collect();
        let name = v.str_of("Name");
        json!({
            "name": v["Name"],
            "size": v["UsageData"]["Size"].as_i64().unwrap_or(-1), // -1: Docker didn't measure it
            "containers": v["UsageData"]["RefCount"].as_i64().unwrap_or(users.len() as i64),
            "createdAt": v["CreatedAt"].as_str().and_then(parse_time),
            "running": any_running(&users), "lastUsed": latest(&users),
            "anonymous": name.len() == 64 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), // created by a container, no name given
            "project": v["Labels"].get("com.docker.compose.project").and_then(|p| p.as_str()).filter(|s| !s.is_empty()),
        })
    }).collect();
    let cache = arr("BuildCache");
    let cache: Vec<&Value> = cache.iter().collect();
    let free: Vec<&Value> = cache.iter().copied().filter(|c| !c.bool_of("InUse")).collect();
    let size = |x: &Value| num(&x["Size"]);
    let last_cache = cache.iter().filter_map(|c| c["LastUsedAt"].as_str().and_then(parse_time)).max().unwrap_or(0);
    let build = json!({
        "count": cache.len(), "size": sum(&cache, size), "reclaimable": sum(&free, size),
        "lastUsed": if last_cache > 0 { json!(last_cache) } else { Value::Null },
    });
    let stopped: Vec<&Value> = containers.iter().filter(|c| !["running", "paused", "restarting"].contains(&c.str_of("state"))).collect();
    let unused: Vec<&Value> = images.iter().filter(|i| i["containers"] == json!(0)).collect();
    let dangling: Vec<&Value> = unused.iter().copied().filter(|i| i["tags"].as_array().is_none_or(|t| t.is_empty())).collect(); // what `docker image prune` takes
    let unused_vol: Vec<&Value> = volumes.iter().filter(|v| v["containers"] == json!(0)).collect();
    let unique = |i: &Value| num(&i["unique"]);
    json!({
        "images": images, "volumes": volumes, "buildCache": build,
        "reclaimable": {
            "containers": { "count": stopped.len(), "size": sum(&stopped, |c| num(&c["size"])) },
            // ponytail: layers shared only between unused images are counted once per image
            "images": { "count": unused.len(), "size": sum(&unused, unique) },
            "dangling": { "count": dangling.len(), "size": sum(&dangling, unique) },
            "volumes": { "count": unused_vol.len(), "size": sum(&unused_vol, |v| num(&v["size"])) },
            "build": { "count": free.len(), "size": build["reclaimable"] },
        },
    })
}

/// A rate from a one-shot stats body and the reading before it (None on the first)
fn rate(s: &Value, prev: Option<Reading>, now: i64) -> (Option<Reading>, Option<Usage>) {
    let cpu = &s["cpu_stats"];
    if !cpu.is_object() { return (None, None); }
    let (mut rx, mut tx) = (0.0, 0.0);
    for n in s["networks"].as_object().into_iter().flat_map(|o| o.values()) { rx += num(&n["rx_bytes"]); tx += num(&n["tx_bytes"]); }
    let cur = Reading { t: now, cpu: num(&cpu["cpu_usage"]["total_usage"]), sys: num(&cpu["system_cpu_usage"]), rx, tx };
    // same as `docker stats`: page cache isn't the container's memory
    let m = &s["memory_stats"];
    let inactive = m["stats"].get("inactive_file").or_else(|| m["stats"].get("total_inactive_file")).map_or(0.0, num);
    let mem = (num(&m["usage"]) - inactive).max(0.0) / 1048576.0;
    let Some(prev) = prev.filter(|p| cur.sys > p.sys) else { return (Some(cur), None) }; // first reading: no rate yet
    let secs = match (now - prev.t) as f64 / 1000.0 { 0.0 => 1.0, s => s };
    let online = cpu["online_cpus"].as_f64().filter(|n| *n > 0.0).unwrap_or(1.0);
    (Some(cur), Some(Usage {
        t: now, cpu: (cur.cpu - prev.cpu) / (cur.sys - prev.sys) * online * 100.0, mem, limit: num(&m["limit"]) / 1048576.0,
        rx: (cur.rx - prev.rx).max(0.0) / secs, tx: (cur.tx - prev.tx).max(0.0) / secs,
    }))
}

/// A Kubernetes name: what pod, namespace and container names are allowed to be
pub fn k8s_name(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 253 && ok(b[0]) && ok(b[b.len() - 1]) && b.iter().all(|c| ok(*c) || *c == b'.' || *c == b'-')
}

/// The lines of a container's state, for an agent's prompt
pub fn state_text(s: &Value) -> String {
    let mut l = vec![format!("state: {}", s["Status"].as_str().unwrap_or("undefined"))];
    if let Some(c) = s["ExitCode"].as_i64().filter(|c| *c != 0) { l.push(format!("exit code: {c}")); }
    if s.bool_of("OOMKilled") { l.push("OOM killed: yes".into()); }
    if !s.str_of("Error").is_empty() { l.push(format!("error: {}", s.str_of("Error"))); }
    if s["Health"].is_object() { l.push(format!("health: {}", s["Health"]["Status"].as_str().unwrap_or("undefined"))); }
    if s.bool_of("Restarting") { l.push("restarting: yes".into()); }
    l.join("\n")
}

fn docker() -> ApiResult<String> { find_bin("docker").ok_or_else(|| err(400, "The docker command isn't installed")) }

impl Containers {
    /// DOCKER_HOST, then the active docker context, then the usual sockets.
    /// ponytail: unix sockets only; a tcp:// DOCKER_HOST reports Docker as unavailable.
    async fn connect(&self) -> Option<Conn> {
        if let Some(c) = self.conn.lock().unwrap().clone().filter(|c| Path::new(&c.socket).exists()) { return Some(c); }
        *self.conn.lock().unwrap() = None;
        let mut host = std::env::var("DOCKER_HOST").unwrap_or_default();
        if host.is_empty() {
            if let Some(d) = find_bin("docker") { host = run(&d, &["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], secs(10)).await.stdout.trim().to_string(); }
        }
        let h = home().to_string_lossy().into_owned();
        let socket = host.strip_prefix("unix://").map(String::from).into_iter()
            .chain(SOCKETS.iter().map(|s| s.replacen('~', &h, 1)))
            .find(|p| Path::new(p).exists())?;
        let http = reqwest::Client::builder().unix_socket(socket.as_str()).no_proxy().build().ok()?;
        let mut conn = Conn { socket, prefix: String::new(), http };
        let (status, v) = request(&conn, "GET", "/version", 30).await;
        if status != 200 { return None; }
        conn.prefix = prefix(v.str_of("ApiVersion"));
        *self.conn.lock().unwrap() = Some(conn.clone());
        Some(conn)
    }

    pub fn last(&self) -> Option<Value> { self.last.lock().unwrap().clone() }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        if c.demo {
            let mut d = crate::demo::get("containers");
            d["stacks"] = json!(stacks_of(d["containers"].as_array().map_or(&[][..], |v| v), |_| true, &located(c)));
            *self.last.lock().unwrap() = Some(d.clone());
            return Ok(d);
        }
        let Some(conn) = self.connect().await else { return Ok(json!({ "available": false, "reason": "Docker isn't running" })) };
        let (status, d) = api(&conn, "GET", "/system/df", 30).await;
        if status != 200 {
            *self.conn.lock().unwrap() = None;
            return Ok(json!({ "available": false, "reason": d["message"].as_str().unwrap_or("Docker isn't answering") }));
        }
        let raw = d["Containers"].as_array().cloned().unwrap_or_default();
        let mut containers: Vec<Value> = raw.iter().map(container).collect();
        let last_runs = futures_util::future::join_all(raw.iter().map(|r| self.last_run(&conn, r))).await;
        for (c, l) in containers.iter_mut().zip(last_runs) { c["lastUsed"] = json!(l); }
        self.stats(&conn, &mut containers).await;
        let ids: HashSet<&str> = containers.iter().map(|c| c.str_of("id")).collect();
        self.inspect.lock().unwrap().retain(|k, _| ids.contains(k.as_str()));

        let mut out = summary(&d, &containers);
        let loc = located(c);
        out["stacks"] = json!(stacks_of(&containers, |f| Path::new(f).exists(), &loc));
        out["available"] = json!(true);
        // kubectl context of the cluster these k8s containers belong to, so commands never hit
        // whatever context is current. ponytail: OrbStack and Docker Desktop only, by socket path.
        out["k8sContext"] = if conn.socket.contains("/.orbstack/") { json!("orbstack") } else if conn.socket.contains("/.docker/") { json!("docker-desktop") } else { Value::Null };
        out["containers"] = json!(containers);
        *self.last.lock().unwrap() = Some(out.clone());
        Ok(out)
    }

    /// When a stopped container last ran; None while running (see `running`)
    async fn last_run(&self, conn: &Conn, c: &Value) -> Option<i64> {
        let (id, state) = (c.str_of("Id"), c.str_of("State"));
        if state == "running" { return None; }
        if let Some((s, at)) = self.inspect.lock().unwrap().get(id) { if s == state { return *at; } }
        let (_, d) = api(conn, "GET", &format!("/containers/{id}/json"), 30).await;
        let at = docker_time(&d["State"]["FinishedAt"]).filter(|t| *t != 0).or_else(|| docker_time(&d["State"]["StartedAt"])).filter(|t| *t != 0);
        self.inspect.lock().unwrap().insert(id.to_string(), (state.to_string(), at));
        at
    }

    /// One-shot stats (no 1s wait for Docker's own second sample) for each running container
    async fn stats(&self, conn: &Conn, containers: &mut [Value]) {
        let now = now_ms();
        let live: Vec<usize> = (0..containers.len()).filter(|i| containers[*i].str_of("state") == "running" && !containers[*i]["k8s"]["sandbox"].as_bool().unwrap_or(false)).collect();
        let bodies = futures_util::future::join_all(live.iter().map(|i| {
            let id = containers[*i].str_of("id").to_string();
            async move { api(conn, "GET", &format!("/containers/{id}/stats?stream=false&one-shot=true"), 4).await.1 }
        })).await;
        let ids: HashSet<String> = live.iter().map(|i| containers[*i].str_of("id").to_string()).collect();
        let (mut raw, mut usage) = (self.raw.lock().unwrap(), self.usage.lock().unwrap());
        for (i, body) in live.into_iter().zip(bodies) {
            let id = containers[i].str_of("id").to_string();
            let (cur, u) = rate(&body, raw.get(&id).copied(), now);
            if let Some(cur) = cur { raw.insert(id.clone(), cur); }
            let Some(u) = u else { continue };
            let list = usage.entry(id).or_default();
            list.push(u);
            list.retain(|x| now - x.t <= KEEP_MS);
            containers[i]["stats"] = json!({
                "cpu": u.cpu, "mem": u.mem, "limit": u.limit, "rx": u.rx, "tx": u.tx,
                "cpuSpark": series(list, |x| x.cpu), "memSpark": series(list, |x| x.mem),
                "rxSpark": series(list, |x| x.rx), "txSpark": series(list, |x| x.tx),
            });
        }
        usage.retain(|k, _| ids.contains(k));
        raw.retain(|k, _| ids.contains(k));
    }

    /// Only ids Docker reported; the list may be stale if nobody was watching, so rescan once.
    /// Gives the matching item and the value encoded for a URL.
    async fn known(&self, c: &Ctx, kind: &str, key: &str, value: &str) -> ApiResult<(Value, String)> {
        let find = || self.last.lock().unwrap().as_ref().and_then(|l| l[kind].as_array()?.iter().find(|x| x[key].as_str() == Some(value)).cloned());
        if find().is_none() { let _ = self.scan(c).await; }
        let item = find().ok_or_else(|| err(404, "It is gone already"))?;
        Ok((item, encode(value)))
    }

    /// The kubelet owns these: a stop or remove is undone in seconds, or breaks the pod
    async fn not_k8s(&self, c: &Ctx, id: &str) -> ApiResult<(Value, String)> {
        let (item, enc) = self.known(c, "containers", "id", id).await?;
        if !item["k8s"].is_null() { return Err(err(400, "Kubernetes manages this container; change it with kubectl")); }
        Ok((item, enc))
    }

    async fn running(&self, c: &Ctx, id: &str) -> ApiResult<Value> {
        let (item, _) = self.not_k8s(c, id).await?;
        if item.str_of("state") != "running" { return Err(err(400, format!("{} isn't running", item.str_of("name")))); }
        Ok(item)
    }

    fn is_k8s(&self, id: &str) -> bool {
        self.last.lock().unwrap().as_ref().and_then(|l| l["containers"].as_array()?.iter().find(|x| x.str_of("id") == id).map(|x| !x["k8s"].is_null())).unwrap_or(false)
    }

    /// Kubernetes containers: kubectl exec, pinned to the cluster these came from, never the current context
    async fn k8s_exec(&self, c: &Ctx, id: &str, cmd: &str, tty: bool) -> ApiResult<TermSpec> {
        let (item, _) = self.known(c, "containers", "id", id).await?;
        let k = &item["k8s"];
        let ctx_name = self.last().and_then(|l| l["k8sContext"].as_str().map(String::from));
        let Some(ctx_name) = ctx_name.filter(|_| k.is_object()) else { return Err(err(400, "Can't tell which cluster this container is in")) };
        if !["pod", "namespace", "container"].iter().all(|f| k8s_name(k.str_of(f))) { return Err(err(400, "Unexpected pod name")); }
        let kubectl = find_bin("kubectl").ok_or_else(|| err(400, "The kubectl command isn't installed"))?;
        let mut args = vec!["--context".to_string(), ctx_name, "-n".into(), k.str_of("namespace").into(), "exec".into()];
        if tty { args.push("-it".into()); }
        args.extend([k.str_of("pod").into(), "-c".into(), k.str_of("container").into(), "--".into(), "sh".into(), "-c".into(), cmd.into()]);
        Ok(TermSpec { file: kubectl, args, ..Default::default() })
    }

    async fn stack(&self, c: &Ctx, name: &str) -> ApiResult<Value> {
        let find = || self.last().and_then(|l| l["stacks"].as_array()?.iter().find(|s| s.str_of("name") == name).cloned());
        if find().is_none() { let _ = self.scan(c).await; }
        find().ok_or_else(|| err(404, "That stack is gone"))
    }

    fn socket(&self) -> String { self.conn.lock().unwrap().as_ref().map(|c| c.socket.clone()).unwrap_or_default() }

    /// `docker compose` for one stack. -p alone is enough to start, stop, restart or take down
    /// what's running; pulling and recreating needs the compose files it was started from.
    fn compose(&self, s: &Value, with_files: bool) -> Vec<String> {
        let mut a = vec!["-H".to_string(), format!("unix://{}", self.socket()), "compose".into(), "-p".into(), s.str_of("name").into()];
        if with_files {
            a.extend(["--project-directory".into(), s.str_of("dir").into()]);
            for f in s["filesFound"].as_array().into_iter().flatten() { a.extend(["-f".into(), f.as_str().unwrap_or("").into()]); }
        }
        a
    }

    /// State and recent logs of one container, as text for an agent's prompt (a JSON string)
    pub async fn snapshot(&self, c: &Ctx, id: &str) -> ApiResult<Value> {
        let (_, enc) = self.known(c, "containers", "id", id).await?;
        let conn = self.connect().await.ok_or_else(|| err(500, "Docker isn't running"))?;
        let (_, d) = api(&conn, "GET", &format!("/containers/{enc}/json"), 30).await;
        let state = state_text(&d["State"]);
        // the CLI demuxes the log stream; -H pins it to the daemon this source reads
        let logs = match find_bin("docker") {
            Some(bin) => {
                let o = run(&bin, &["-H", &format!("unix://{}", conn.socket), "logs", "--tail", "30", "--timestamps", id], secs(10)).await;
                (o.stdout + &o.stderr).trim().split('\n')
                    .map(|l| if l.chars().count() > 300 { format!("{}…", l.chars().take(300).collect::<String>()) } else { l.to_string() })
                    .collect::<Vec<_>>().join("\n")
            }
            None => String::new(),
        };
        Ok(json!(if logs.is_empty() { state } else { format!("{state}\nRecent logs:\n{logs}") }))
    }

    /// Commands that run inside DevDock's terminal, so you watch them happen
    pub async fn terminal(&self, c: &Ctx, p: &Value) -> ApiResult<Option<TermSpec>> {
        if c.demo { return Ok(None); }
        match p.str_of("kind") {
            "shell" if self.is_k8s(p.str_of("id")) => self.k8s_exec(c, p.str_of("id"), SHELL, true).await.map(Some),
            "shell" => {
                let item = self.running(c, p.str_of("id")).await?;
                // bash if the image has it, else sh; values ride as argv, never inside the script
                let args = ["-H", &format!("unix://{}", self.socket()), "exec", "-it", item.str_of("id"), "sh", "-c", SHELL].map(String::from).to_vec();
                Ok(Some(TermSpec { file: docker()?, args, ..Default::default() }))
            }
            "update" => {
                let s = self.stack(c, p.str_of("stack")).await?;
                if s["filesFound"].as_array().is_none_or(|f| f.is_empty()) { return Err(err(400, format!("Can't find {}'s compose file", s.str_of("name")))); }
                let mut args = vec!["-c".to_string(), "\"$0\" \"$@\" pull && \"$0\" \"$@\" up -d && echo && echo \"Updated. Close with ⌘.\"".into(), docker()?];
                args.extend(self.compose(&s, true));
                Ok(Some(TermSpec { file: "/bin/sh".into(), cwd: Some(s.str_of("dir").into()), args, ..Default::default() }))
            }
            _ => Ok(None),
        }
    }

    /// 2xx (and 304 "already stopped/started") is success; anything else is Docker's message
    async fn call(&self, method: &str, path: &str, timeout: u64) -> ApiResult<Value> {
        let conn = self.connect().await.ok_or_else(|| err(500, "Docker isn't running"))?;
        let (status, body) = api(&conn, method, path, timeout).await;
        if (200..300).contains(&status) || status == 304 { return Ok(body); }
        let msg = body["message"].as_str().map(String::from).unwrap_or_else(|| format!("Docker answered {status}"));
        Err(err(if status == 409 { 409 } else { 500 }, msg))
    }

    pub async fn action(&self, c: &Ctx, name: &str, p: &Value) -> ApiResult<Value> {
        let id = p.str_of("id");
        match name {
            // compose up/down/start/stop for a whole stack; down keeps volumes
            "stack" => {
                let op = p.str_of("op");
                if !["start", "stop", "restart", "down"].contains(&op) { return Err(err(400, "Unknown stack action")); }
                if c.demo { return Ok(json!({})); }
                let s = self.stack(c, p.str_of("stack")).await?;
                let mut args = self.compose(&s, false);
                args.push(op.into());
                let r = run(&docker()?, &args.iter().map(String::as_str).collect::<Vec<_>>(), secs(180)).await;
                if r.code != 0 {
                    let text = if r.stderr.is_empty() { &r.stdout } else { &r.stderr };
                    let line = text.trim().split('\n').next_back().unwrap_or("");
                    return Err(err(500, if line.is_empty() { format!("docker compose {op} failed") } else { line.to_string() }));
                }
                Ok(json!({}))
            }
            // The stack's folder moved: pick its compose file in the Finder, remembered from then on
            "locateCompose" => {
                let s = self.stack(c, p.str_of("stack")).await?;
                let r = run("/usr/bin/osascript", &["-e", "on run argv", "-e", "POSIX path of (choose file with prompt (\"Find the compose file for \" & item 1 of argv))", "-e", "end run", s.str_of("name")], secs(300)).await;
                let file = r.stdout.trim().to_string();
                if r.code != 0 || file.is_empty() { return Ok(json!({ "cancelled": true })); }
                let lower = file.to_lowercase();
                if !(lower.ends_with(".yaml") || lower.ends_with(".yml")) { return Err(err(400, "Pick the compose .yaml or .yml file")); }
                let mut all = located(c);
                if !all.is_object() { all = json!({}); }
                all[s.str_of("name")] = json!(file);
                save_private(&located_file(c), &serde_json::to_string_pretty(&all).unwrap_or_default()).map_err(|e| err(500, e.to_string()))?;
                let _ = self.scan(c).await;
                Ok(json!({ "file": file }))
            }
            // can we open a shell? distroless and scratch images have none
            "canShell" => {
                if c.demo { return Ok(json!({ "ok": true })); }
                if self.is_k8s(id) {
                    let k = self.k8s_exec(c, id, "exit 0", false).await?;
                    let ok = run(&k.file, &k.args.iter().map(String::as_str).collect::<Vec<_>>(), secs(10)).await.code == 0;
                    return Ok(json!({ "ok": ok }));
                }
                let item = self.running(c, id).await?;
                let r = run(&docker()?, &["-H", &format!("unix://{}", self.socket()), "exec", item.str_of("id"), "sh", "-c", "exit 0"], secs(8)).await;
                Ok(json!({ "ok": r.code == 0 }))
            }
            "start" => { let (_, e) = self.not_k8s(c, id).await?; self.call("POST", &format!("/containers/{e}/start"), 30).await?; Ok(json!({})) }
            "stop" => { let (_, e) = self.not_k8s(c, id).await?; self.call("POST", &format!("/containers/{e}/stop"), 60).await?; Ok(json!({})) }
            // no force: Docker refuses running containers and images or volumes still in use
            "removeContainer" => { let (_, e) = self.not_k8s(c, id).await?; self.call("DELETE", &format!("/containers/{e}"), 30).await?; Ok(json!({})) }
            "removeImage" => { let (_, e) = self.known(c, "images", "id", id).await?; self.call("DELETE", &format!("/images/{e}"), 30).await?; Ok(json!({})) }
            "removeVolume" => { let (_, e) = self.known(c, "volumes", "name", p.str_of("name")).await?; self.call("DELETE", &format!("/volumes/{e}"), 30).await?; Ok(json!({})) }
            // kinds run in this order: removing stopped containers first frees their images
            "prune" => {
                let kinds = p["kinds"].as_array().cloned().unwrap_or_default();
                let order: Vec<&str> = ["containers", "dangling", "images", "build", "volumes"].into_iter().filter(|k| kinds.contains(&json!(k))).collect();
                if order.is_empty() { return Err(err(400, "Nothing to clean")); }
                let mut reclaimed = 0.0;
                for k in order { reclaimed += num(&self.call("POST", &prune_path(k), 300).await?["SpaceReclaimed"]); }
                Ok(json!({ "reclaimed": reclaimed }))
            }
            _ => Err(unknown()),
        }
    }
}

/// What each prune kind asks Docker for
pub fn prune_path(kind: &str) -> String {
    match kind {
        "containers" => "/containers/prune".into(),                                        // stopped containers
        "images" => format!("/images/prune?{}", filters(json!({ "dangling": ["false"] }))), // every image no container uses
        "dangling" => "/images/prune".into(),                                              // untagged ones only
        "build" => "/build/prune?all=true".into(),
        _ => format!("/volumes/prune?{}", filters(json!({ "all": ["true"] }))),             // named ones too, not just anonymous
    }
}

/// Written readable by you only, folders made as needed
fn save_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(d) = path.parent() { std::fs::create_dir_all(d)?; }
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?.write_all(text.as_bytes())
}

async fn api(conn: &Conn, method: &str, path: &str, timeout: u64) -> (u16, Value) {
    request(conn, method, &format!("{}{path}", conn.prefix), timeout).await
}

/// Status and JSON body (or the text as a string); a failure reads as status 0 with its message
async fn request(conn: &Conn, method: &str, path: &str, timeout: u64) -> (u16, Value) {
    let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let sent = conn.http.request(m, format!("http://docker{path}")).timeout(Duration::from_secs(timeout)).send().await;
    match sent {
        Ok(r) => {
            let status = r.status().as_u16();
            let text = r.text().await.unwrap_or_default();
            (status, if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(json!(text)) })
        }
        Err(e) if e.is_timeout() => (0, json!({ "message": "Docker did not answer in time" })),
        Err(e) => (0, json!({ "message": e.to_string() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df_container(id: &str, state: &str, labels: Value) -> Value {
        json!({ "Id": id, "Names": [format!("/{id}")], "Image": "img", "ImageID": "sha256:i1", "State": state, "Status": "Up", "Created": 100,
            "SizeRw": 10, "Labels": labels, "Ports": [{ "PublicPort": 8080 }, { "PublicPort": 8080 }, { "PrivatePort": 1 }, { "PublicPort": 80 }],
            "Mounts": [{ "Type": "volume", "Name": "data" }, { "Type": "bind", "Name": "x" }] })
    }

    #[test]
    fn api_version_is_pinned_unless_older() {
        assert_eq!(prefix("1.56"), "/v1.47");
        assert_eq!(prefix("1.41"), "/v1.41");
        assert_eq!(prefix("nope"), "/v1.47");
    }

    #[test]
    fn reads_a_container() {
        let c = container(&df_container("abc", "running", json!({ "com.docker.compose.project": "shop", "com.docker.compose.project.config_files": "/a.yml,/b.yml," })));
        assert_eq!(c["name"], "abc");
        assert_eq!(c["ports"], json!([80, 8080]));
        assert_eq!(c["volumes"], json!(["data"]));
        assert_eq!(c["composeFiles"], json!(["/a.yml", "/b.yml"]));
        assert_eq!((c["createdAt"].clone(), c["service"].clone(), c["k8s"].clone()), (json!(100_000), Value::Null, Value::Null));
        let unnamed = container(&json!({ "Id": "0123456789abcdef", "Labels": {} }));
        assert_eq!(unnamed["name"], "0123456789ab");
        let k = k8s_of(&json!({ "io.kubernetes.pod.name": "p", "io.kubernetes.docker.type": "podsandbox" }));
        assert_eq!(k, json!({ "pod": "p", "namespace": null, "container": null, "sandbox": true }));
    }

    #[test]
    fn docker_times() {
        assert_eq!(docker_time(&json!("0001-01-01T00:00:00Z")), None);
        assert_eq!(docker_time(&json!("2026-11-26T16:21:36.142891392Z")), parse_time("2026-11-26T16:21:36.142Z"));
    }

    #[test]
    fn stacks_group_compose_projects() {
        let mk = |id: &str, svc: &str, state: &str, cpu: f64, last: Option<i64>| json!({
            "id": id, "name": format!("shop-{svc}-1"), "service": svc, "state": state, "status": "", "image": "i", "project": "shop",
            "composeDir": "/code/shop", "composeFiles": ["/code/shop/compose.yaml"], "k8s": null, "ports": [5432],
            "lastUsed": last, "createdAt": id.parse::<i64>().unwrap() * 1000, "stats": if state == "running" { json!({ "cpu": cpu, "mem": 10.0 }) } else { Value::Null },
        });
        let list = vec![mk("1", "web", "running", 2.5, None), mk("2", "db", "exited", 9.0, Some(500)),
            json!({ "id": "3", "name": "solo", "project": "idle", "state": "exited", "ports": [], "composeFiles": ["/gone.yml"], "k8s": null, "lastUsed": null }),
            json!({ "id": "4", "name": "k", "project": "shop", "state": "running", "ports": [], "k8s": { "pod": "p" } })];
        let s = stacks_of(&list, |f| f != "/gone.yml" && f != "/moved/compose.yml", &json!({}));
        assert_eq!(s.iter().map(|x| x.str_of("name")).collect::<Vec<_>>(), ["shop", "idle"]); // running first
        assert_eq!((s[0]["running"].clone(), s[0]["total"].clone(), s[0]["cpu"].clone(), s[0]["mem"].clone()), (json!(1), json!(2), json!(2.5), json!(10.0)));
        assert_eq!(s[0]["services"].as_array().unwrap().iter().map(|x| x.str_of("name")).collect::<Vec<_>>(), ["db", "web"]);
        assert_eq!((s[0]["ports"].clone(), s[0]["lastUsed"].clone(), s[0]["createdAt"].clone()), (json!([5432]), json!(500), json!(1000)));
        assert_eq!(s[1]["createdAt"], Value::Null); // no container says when
        assert_eq!((s[1]["filesFound"].clone(), s[1]["located"].clone(), s[1]["dir"].clone()), (json!([]), json!(false), Value::Null));
        // a compose file you pointed DevDock at after the folder moved
        let s = stacks_of(&list, |f| f == "/code/shop/compose.yaml" || f == "/new/idle.yml", &json!({ "idle": "/new/idle.yml" }));
        assert_eq!((s[1]["filesFound"].clone(), s[1]["located"].clone(), s[1]["dir"].clone()), (json!(["/new/idle.yml"]), json!(true), json!("/new")));
        assert_eq!(locale_cmp("a", "B"), Ordering::Less);
        assert_eq!(locale_cmp("a", "A"), Ordering::Less);
    }

    #[test]
    fn images_volumes_and_what_cleaning_frees() {
        let containers = vec![
            json!({ "id": "1", "imageId": "sha256:a", "state": "running", "size": 5, "volumes": ["named"], "lastUsed": null }),
            json!({ "id": "2", "imageId": "sha256:a", "state": "exited", "size": 7, "volumes": [], "lastUsed": 900 }),
        ];
        let d = json!({
            "Images": [
                { "Id": "sha256:a", "RepoTags": ["app:1"], "Size": 100, "SharedSize": 40, "Created": 1 },
                { "Id": "sha256:b", "RepoTags": ["<none>:<none>"], "Size": 50, "SharedSize": -1, "Created": 2 },
                { "Id": "sha256:c", "RepoTags": ["old:1"], "Size": 30, "Created": 3 },
            ],
            "Volumes": [
                { "Name": "named", "CreatedAt": "2026-11-26T20:21:35+04:00", "UsageData": { "Size": 64, "RefCount": 1 }, "Labels": { "com.docker.compose.project": "shop" } },
                { "Name": "a".repeat(64), "UsageData": { "Size": -1, "RefCount": 0 }, "Labels": null },
            ],
            "BuildCache": [{ "Size": 10, "InUse": true, "LastUsedAt": "2026-01-01T00:00:00Z" }, { "Size": 20, "InUse": false, "LastUsedAt": null }],
        });
        let s = summary(&d, &containers);
        let img = &s["images"];
        assert_eq!((img[0]["unique"].clone(), img[0]["containers"].clone(), img[0]["running"].clone(), img[0]["lastUsed"].clone()), (json!(60), json!(2), json!(true), json!(900)));
        assert_eq!((img[1]["tags"].clone(), img[1]["unique"].clone(), img[2]["unique"].clone()), (json!([]), json!(50), json!(30)));
        let vol = &s["volumes"];
        assert_eq!((vol[0]["running"].clone(), vol[0]["project"].clone(), vol[0]["createdAt"].clone()), (json!(true), json!("shop"), json!(parse_time("2026-11-26T16:21:35Z").unwrap())));
        assert_eq!((vol[1]["anonymous"].clone(), vol[1]["size"].clone(), vol[1]["project"].clone()), (json!(true), json!(-1), Value::Null));
        let r = &s["reclaimable"];
        assert_eq!(r["containers"], json!({ "count": 1, "size": 7.0 }));
        assert_eq!(r["images"], json!({ "count": 2, "size": 80.0 }));
        assert_eq!(r["dangling"], json!({ "count": 1, "size": 50.0 }));
        assert_eq!(r["volumes"], json!({ "count": 1, "size": 0.0 })); // Docker didn't measure it
        assert_eq!(r["build"], json!({ "count": 1, "size": 20.0 }));
        assert_eq!((s["buildCache"]["size"].clone(), s["buildCache"]["lastUsed"].clone()), (json!(30.0), json!(parse_time("2026-01-01T00:00:00Z").unwrap())));
    }

    #[test]
    fn stats_are_rates_between_readings() {
        let body = |cpu: f64, sys: f64, rx: f64| json!({
            "cpu_stats": { "cpu_usage": { "total_usage": cpu }, "system_cpu_usage": sys, "online_cpus": 4 },
            "memory_stats": { "usage": 3.0 * 1048576.0, "limit": 1048576.0 * 1024.0, "stats": { "inactive_file": 1048576.0 } },
            "networks": { "eth0": { "rx_bytes": rx, "tx_bytes": 0 }, "eth1": { "rx_bytes": rx, "tx_bytes": 10 } },
        });
        let (first, none) = rate(&body(100.0, 1000.0, 0.0), None, 0);
        assert!(none.is_none());
        let (_, u) = rate(&body(150.0, 1100.0, 500.0), first, 2000);
        assert_eq!(u.unwrap(), Usage { t: 2000, cpu: 200.0, mem: 2.0, limit: 1024.0, rx: 500.0, tx: 0.0 });
        assert_eq!(rate(&json!({}), None, 0), (None, None));
        let list: Vec<Usage> = (0..95).map(|i| Usage { t: i, cpu: i as f64 + 0.04, mem: 0.0, limit: 0.0, rx: 0.0, tx: 0.0 }).collect();
        let s = series(&list, |x| x.cpu);
        assert_eq!((s.len(), s[0], s[1], *s.last().unwrap()), (33, 0.0, 3.0, 94.0)); // every 3rd, plus the last
    }

    #[test]
    fn urls_names_and_prompts() {
        assert_eq!(encode("sha256:ab/c d"), "sha256%3Aab%2Fc%20d");
        assert_eq!(prune_path("images"), "/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D");
        assert_eq!(prune_path("volumes"), "/volumes/prune?filters=%7B%22all%22%3A%5B%22true%22%5D%7D");
        assert!(k8s_name("coredns-64d64f99dd-96zg8") && k8s_name("kube-system") && k8s_name("a"));
        assert!(!k8s_name("") && !k8s_name("-a") && !k8s_name("a;b") && !k8s_name("A") && !k8s_name(&"a".repeat(254)));
        assert_eq!(state_text(&json!({ "Status": "exited", "ExitCode": 137, "OOMKilled": true, "Error": "", "Health": { "Status": "unhealthy" }, "Restarting": false })),
            "state: exited\nexit code: 137\nOOM killed: yes\nhealth: unhealthy");
        assert_eq!(state_text(&json!({ "Status": "running", "ExitCode": 0 })), "state: running");
    }
}

//! Usage history: what each app used, minute by minute, so Home's panels can rank by the last hour
//! or day instead of the last 2 seconds, where bursty apps jump around. One ps reading a minute
//! (the process table is read anyway). Kept on this Mac only, in usage.jsonl next to the settings,
//! for `usageDays` (1 or 7), and off with `usageHistory`. CPU and disk are exact averages over each
//! minute, from cumulative counters; memory is the reading at the minute; network counts only the
//! seconds the Network panel was open, as nettop costs too much to run always. The Mac's own
//! network total, from the interface, is always recorded.
use crate::state::Ctx;
use crate::sys::{self, CpuTicks};
use crate::table::Table;
use crate::top::{self, Ps, Row};
use crate::util::{basename, now_ms, round1, Get};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Mutex;

const FILE: &str = "usage.jsonl";
const KEYS: &str = "usage-keys.json";
const KEEP: usize = 25; // groups kept a minute, per measure
const SPARK: usize = 30;

#[derive(Default)]
pub struct Usage { prev: Mutex<Option<Snap>>, keys: Mutex<Option<Map<String, Value>>>, pruned: Mutex<(i64, u64)>, file: Mutex<()> }

struct Snap { at: i64, ps: Ps, ticks: Option<CpuTicks>, disk: HashMap<i32, (Option<i64>, (u64, u64))>, iface: Option<(u64, u64)> }

/// Who a group is, the same across restarts: servers and agents by their folder, not their pid
fn hkey(g: &Value) -> String {
    match g.str_of("kind") {
        "server" => format!("srv:{}", Some(g.str_of("cwd")).filter(|c| !c.is_empty()).unwrap_or(g.str_of("name"))),
        "agent" => format!("agent:{}:{}", g.str_of("agent"), Some(g.str_of("cwd")).filter(|c| !c.is_empty()).unwrap_or(g.str_of("key"))),
        _ => g.str_of("key").to_string(),
    }
}

/// One minute between two readings: a line for the file, and who each group is
fn minute(p: &Snap, cur: &Snap, t: &Table, me: u32, net: &HashMap<i32, (String, (u64, u64))>, net_secs: f64, ports: &[Value], agents: &[Value], apps: &[Value]) -> Option<(Value, Vec<(String, Value)>)> {
    let secs = (cur.at - p.at) as f64 / 1000.0;
    if !(20.0..=300.0).contains(&secs) { return None; } // asleep, or stalled: not a minute
    // a process new since the last reading (or a reused pid) used all its CPU time in this minute
    let cpu: HashMap<i32, f64> = cur.ps.iter().map(|(pid, c)| {
        let used = match p.ps.get(pid) { Some(q) if c.1 >= q.1 && q.3 == c.3 => c.1 - q.1, _ => c.1 };
        (*pid, round1(used / secs * 100.0))
    }).collect();
    let mut rows: Vec<Row> = top::mine(t, me, &cpu).into_iter().filter(|r| cur.ps.contains_key(&r.pid)).collect();
    let known: HashSet<i32> = rows.iter().map(|r| r.pid).collect();
    rows.extend(top::others(&cur.ps, &cpu, me));
    // ours the table hasn't seen yet (it reads every few seconds)
    rows.extend(cur.ps.iter().filter(|(pid, c)| c.0 == me && !known.contains(pid)).map(|(&pid, c)| Row {
        pid, mine: true, name: basename(&c.3).to_string(), path: c.3.clone(), mem: c.2, cpu: cpu[&pid], ..Default::default()
    }));
    for r in rows.iter_mut() {
        (r.dr, r.dw) = (0.0, 0.0);
        if let Some(&(started, (rd, wr))) = cur.disk.get(&r.pid) {
            let base = match p.disk.get(&r.pid) {
                Some(&(s, d)) if s == started && rd >= d.0 && wr >= d.1 => d,
                _ if started.is_some_and(|s| s >= p.at) => (0, 0), // started this minute
                _ => (rd, wr), // no reading to measure from
            };
            (r.dr, r.dw) = (((rd - base.0) as f64 / secs).round(), ((wr - base.1) as f64 / secs).round());
        }
        if net_secs > 0.0 { if let Some((_, (rx, tx))) = net.get(&r.pid) { (r.rx, r.tx) = ((*rx as f64 / net_secs).round(), (*tx as f64 / net_secs).round()); } }
    }
    // traffic of processes that ended during the minute: by what the last reading knew of them, else nettop's name
    if net_secs > 0.0 {
        rows.extend(net.iter().filter(|(pid, _)| !cur.ps.contains_key(pid)).map(|(&pid, (name, (rx, tx)))| {
            let (mine, name, path) = match p.ps.get(&pid) { Some(q) => (q.0 == me, basename(&q.3).to_string(), q.3.clone()), None => (false, name.clone(), String::new()) };
            Row { pid, mine, name, path, rx: (*rx as f64 / net_secs).round(), tx: (*tx as f64 / net_secs).round(), ..Default::default() }
        }));
    }
    let total = p.ticks.zip(cur.ticks).and_then(|(a, b)| sys::cpu_percent(a, b)).map(|x| x * sys::cores() as f64);
    rows.extend(total.and_then(|x| top::kernel(x, &rows)));

    let groups = top::group(&rows, ports, agents, apps, "any");
    let measure = |g: &Value, m: usize| match m { 0 => g.f64_of("cpu"), 1 => g.f64_of("mem"), 2 => g.f64_of("diskR") + g.f64_of("diskW"), _ => g.f64_of("rx") + g.f64_of("tx") };
    let mut keep: HashSet<usize> = HashSet::new();
    for m in 0..4 {
        let mut idx: Vec<usize> = (0..groups.len()).filter(|&i| measure(&groups[i], m) > 0.0).collect();
        idx.sort_by(|&a, &b| measure(&groups[b], m).total_cmp(&measure(&groups[a], m)));
        keep.extend(idx.into_iter().take(KEEP));
    }
    let mut entries = vec![];
    let mut who = vec![];
    for (_, g) in groups.into_iter().enumerate().filter(|(i, _)| keep.contains(i)) {
        let k = hkey(&g);
        entries.push(json!([k, g["cpu"], g["mem"], g["diskR"], g["diskW"], g["rx"], g["tx"]]));
        let mut meta = g;
        if let Some(m) = meta.as_object_mut() { for f in ["key", "pid", "cpu", "mem", "diskR", "diskW", "rx", "tx", "count", "pids", "starts", "procs"] { m.remove(f); } }
        who.push((k, meta));
    }
    let iface = p.iface.zip(cur.iface).filter(|(a, b)| b.0 >= a.0 && b.1 >= a.1).map(|(a, b)| (((b.0 - a.0) as f64 / secs).round(), ((b.1 - a.1) as f64 / secs).round()));
    Some((json!({ "t": cur.at, "s": secs, "ns": round1(net_secs), "cpu": total.map(round1), "rx": iface.map(|i| i.0), "tx": iface.map(|i| i.1), "g": entries }), who))
}

/// "{"t":123,..." -> 123, without parsing the rest of a line that's too old to matter
fn t_of(line: &str) -> Option<i64> {
    let rest = line.strip_prefix("{\"t\":")?;
    rest[..rest.find(|c: char| !c.is_ascii_digit())?].parse().ok()
}

impl Usage {
    fn keys<'a>(dir: &Path, k: &'a mut Option<Map<String, Value>>) -> &'a mut Map<String, Value> {
        k.get_or_insert_with(|| std::fs::read(dir.join(KEYS)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default())
    }

    /// Once a minute, from housekeeping. The file work runs off the async threads.
    pub async fn record(&'static self, c: &'static Ctx) {
        let (net, net_secs) = c.sources.home.top.net.take(); // always, so nothing piles up while it's off
        if c.demo { return; }
        let s = c.settings.get();
        let days = s["usageDays"].as_u64().unwrap_or(1).clamp(1, 7);
        let entry = if s["usageHistory"] == json!(false) { *self.prev.lock().unwrap() = None; None } else { self.minute(c, net, net_secs).await };
        // the retention holds while it's off too
        let dir = c.data.clone();
        match tokio::task::spawn_blocking(move || self.store(&dir, entry, days)).await {
            Ok(Err(e)) => eprintln!("usage history: {e}"),
            Err(e) => eprintln!("usage history: {e}"),
            _ => {}
        }
    }

    async fn minute(&self, c: &Ctx, net: HashMap<i32, (String, (u64, u64))>, net_secs: f64) -> Option<(Value, Vec<(String, Value)>)> {
        let ps = top::parse_ps(&crate::util::run("/bin/ps", &["-A", "-o", "pid=,uid=,time=,rss=,comm="], crate::util::secs(5)).await.stdout);
        if ps.is_empty() { return None; }
        let iface = match crate::sources::home::default_iface().await { Some(i) => sys::iface_bytes(&i), None => None };
        let t = c.table();
        let cur = Snap {
            at: now_ms(), ps, ticks: sys::cpu_ticks(), iface,
            disk: t.values().filter_map(|p| Some((p.pid, (p.started_at, p.disk_total?)))).collect(),
        };
        // with no page open the app and agent lists aren't kept up: refresh them for the grouping
        if c.hub.clients() == 0 { for id in ["apps", "coding"] { c.sources.poll(c, id).await; } }
        let prev = self.prev.lock().unwrap().replace(cur);
        let p = prev?;
        let g = self.prev.lock().unwrap();
        let s = &c.sources;
        minute(&p, g.as_ref().unwrap(), &t, unsafe { libc::getuid() }, &net, net_secs, &c.ports(), &s.coding.last(), &s.apps.last())
    }

    /// Appends a minute, if there is one, and keeps to the retention. One lock with `clear`, so a
    /// prune can't bring back what was just deleted.
    fn store(&self, dir: &Path, entry: Option<(Value, Vec<(String, Value)>)>, days: u64) -> std::io::Result<()> {
        let _file = self.file.lock().unwrap();
        let path = dir.join(FILE);
        let mut new = false;
        let mut k = self.keys.lock().unwrap();
        if let Some((line, who)) = entry {
            std::fs::create_dir_all(dir)?;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).read(true).open(&path)?;
            // a line cut short (a crash, a full disk) stays on its own, not glued to this one
            let len = f.metadata()?.len();
            if len > 0 {
                use std::io::{Read, Seek, SeekFrom};
                let mut last = [0u8];
                f.seek(SeekFrom::Start(len - 1))?;
                f.read_exact(&mut last)?;
                if last[0] != b'\n' { writeln!(f)?; }
            }
            writeln!(f, "{line}")?;
            let keys = Self::keys(dir, &mut k);
            new = who.iter().any(|(key, _)| !keys.contains_key(key));
            for (key, meta) in who { keys.insert(key, meta); }
        }
        if !path.exists() { return Ok(()); }
        let keys = Self::keys(dir, &mut k);
        // the retention, hourly, or as soon as it's shortened
        let now = now_ms();
        let mut pr = self.pruned.lock().unwrap();
        if now - pr.0 >= 3_600_000 || pr.1 != days {
            *pr = (now, days);
            prune(dir, keys, now - days as i64 * 86_400_000)?;
        } else if new {
            std::fs::write(dir.join(KEYS), serde_json::to_vec(&*keys)?)?;
        }
        Ok(())
    }

}

/// Drops minutes older than `cutoff`, and who's no longer in what's left
fn prune(dir: &Path, keys: &mut Map<String, Value>, cutoff: i64) -> std::io::Result<()> {
    let path = dir.join(FILE);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let kept: Vec<&str> = text.lines().filter(|l| t_of(l).is_some_and(|t| t >= cutoff)).collect();
    if kept.len() != text.lines().count() {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, kept.iter().map(|l| format!("{l}\n")).collect::<String>())?;
        std::fs::rename(tmp, &path)?;
    }
    let seen: HashSet<String> = kept.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .flat_map(|v| v["g"].as_array().cloned().unwrap_or_default()).filter_map(|e| e[0].as_str().map(String::from)).collect();
    keys.retain(|k, _| seen.contains(k));
    std::fs::write(dir.join(KEYS), serde_json::to_vec(&*keys)?)
}

impl Usage {
    /// Who used the most `by` over the last `mins`: averages and the busiest minute.
    /// ponytail: reads the file each time (7 days is about 25 MB); an index if it gets slow.
    pub fn query(&self, dir: &Path, by: &str, mins: i64) -> Value {
        let now = now_ms();
        let from = now - mins * 60_000;
        let lines: Vec<Value> = std::fs::File::open(dir.join(FILE)).map(|f| std::io::BufReader::new(f).lines().map_while(Result::ok)
            .filter(|l| t_of(l).is_some_and(|t| t > from)).filter_map(|l| serde_json::from_str(&l).ok()).collect()).unwrap_or_default();
        let net = by == "net";
        let (mut covered, mut net_covered, mut since) = (0.0, 0.0, None::<i64>);
        let (mut tot_cpu, mut tot_rx, mut tot_tx, mut if_secs) = (0.0, 0.0, 0.0, 0.0);
        let mut bucket_secs = [0.0; SPARK];
        // per group: sums of value x seconds for the six measures, its busiest minute, its sparkline
        let mut agg: HashMap<String, ([f64; 6], f64, [f64; SPARK])> = HashMap::new();
        for l in &lines {
            let (t, s, ns) = (l["t"].as_i64().unwrap_or(0), l.f64_of("s"), l.f64_of("ns"));
            let start = t - (s * 1000.0) as i64;
            since = Some(since.map_or(start, |x| x.min(start)));
            covered += s; net_covered += ns;
            tot_cpu += l.f64_of("cpu") * s;
            if l["rx"].is_number() { tot_rx += l.f64_of("rx") * s; tot_tx += l.f64_of("tx") * s; if_secs += s; }
            let w = if net { ns } else { s };
            let b = (((t - from) as f64 / (now - from) as f64 * SPARK as f64) as usize).min(SPARK - 1);
            bucket_secs[b] += w;
            for e in l["g"].as_array().into_iter().flatten() {
                let Some(k) = e[0].as_str() else { continue };
                let v: Vec<f64> = (1..7).map(|i| e[i].as_f64().unwrap_or(0.0)).collect();
                let a = agg.entry(k.to_string()).or_insert(([0.0; 6], 0.0, [0.0; SPARK]));
                for i in 0..6 { a.0[i] += v[i] * if i >= 4 { ns } else { s }; }
                let m = match by { "mem" => v[1], "disk" => v[2] + v[3], "net" => v[4] + v[5], _ => v[0] };
                if !net || ns >= 30.0 { a.1 = a.1.max(m); } // a busiest "minute" of a few watched seconds isn't one
                a.2[b] += m * w;
            }
        }
        let avg = |sum: f64, secs: f64| if secs > 0.0 { round1(sum / secs) } else { 0.0 };
        let mut k = self.keys.lock().unwrap();
        let keys = Self::keys(dir, &mut k);
        let mut groups: Vec<(f64, Value)> = agg.into_iter().map(|(key, (sum, peak, spark))| {
            let mut g = keys.get(&key).cloned().unwrap_or_else(|| json!({ "kind": "process", "name": key.split_once(':').map_or(key.as_str(), |x| x.1) }));
            g["key"] = json!(key);
            for (i, f) in ["cpu", "mem", "diskR", "diskW", "rx", "tx"].iter().enumerate() { g[*f] = json!(avg(sum[i], if i >= 4 { net_covered } else { covered })); }
            g["peak"] = json!(round1(peak));
            g["spark"] = json!((0..SPARK).filter(|&b| bucket_secs[b] > 0.0).map(|b| avg(spark[b], bucket_secs[b])).collect::<Vec<_>>()); // time not recorded isn't 0
            let v = match by { "mem" => g.f64_of("mem"), "disk" => g.f64_of("diskR") + g.f64_of("diskW"), "net" => g.f64_of("rx") + g.f64_of("tx"), _ => g.f64_of("cpu") };
            (v, g)
        }).filter(|(v, _)| *v > 0.0).collect();
        groups.sort_by(|a, b| b.0.total_cmp(&a.0));
        let count = groups.len();
        let sum = |f: &str| round1(groups.iter().map(|g| g.1.f64_of(f)).sum());
        json!({ "by": by, "mins": mins, "count": count, "since": since, "covered": round1(covered), "netCovered": round1(net_covered),
            "total": { "cpu": avg(tot_cpu, covered), "diskR": sum("diskR"), "diskW": sum("diskW"), "rx": avg(tot_rx, if_secs), "tx": avg(tot_tx, if_secs) },
            "groups": groups.into_iter().take(40).map(|g| g.1).collect::<Vec<_>>() })
    }

    /// What's stored, for Settings
    pub fn info(&self, dir: &Path) -> Value {
        let size = |n: &str| std::fs::metadata(dir.join(n)).map(|m| m.len()).unwrap_or(0);
        let first = std::fs::File::open(dir.join(FILE)).ok().and_then(|f| std::io::BufReader::new(f).lines().map_while(Result::ok).next()).and_then(|l| t_of(&l));
        json!({ "path": dir.join(FILE).to_string_lossy(), "bytes": size(FILE) + size(KEYS), "since": first })
    }

    pub fn clear(&self, dir: &Path) {
        let _file = self.file.lock().unwrap();
        let _ = std::fs::remove_file(dir.join(FILE));
        let _ = std::fs::remove_file(dir.join(KEYS));
        *self.keys.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ps(rows: &[(i32, u32, f64, &str)]) -> Ps { rows.iter().map(|&(p, u, t, c)| (p, (u, t, 10.0, c.to_string()))).collect() }
    fn snap(at: i64, p: Ps) -> Snap { Snap { at, ps: p, ticks: None, disk: HashMap::new(), iface: None } }

    #[test]
    fn a_minute_is_exact_averages_and_new_processes_count_whole() {
        let a = snap(0, ps(&[(10, 0, 100.0, "/usr/sbin/WindowServer"), (20, 501, 5.0, "/bin/zsh")]));
        let b = snap(60_000, ps(&[(10, 0, 130.0, "/usr/sbin/WindowServer"), (20, 501, 5.0, "/bin/zsh"), (30, 501, 6.0, "/usr/bin/make")]));
        let net = HashMap::from([(40, ("curl".to_string(), (6_000_000, 60_000)))]); // ended before the reading
        let (line, who) = minute(&a, &b, &Table::new(), 501, &net, 60.0, &[], &[], &[]).unwrap();
        let g = |k: &str| line["g"].as_array().unwrap().iter().find(|e| e[0] == k).cloned();
        assert_eq!(g("s:curl").unwrap()[5], json!(100_000.0), "an ended process keeps its traffic, by nettop's name");
        assert_eq!(g("s:WindowServer").unwrap()[1], json!(50.0), "30 s of CPU in 60 s");
        assert_eq!(g("p:make").unwrap()[1], json!(10.0), "started this minute: all 6 s count");
        assert_eq!(g("p:zsh").unwrap()[1], json!(0.0), "kept for its memory");
        assert_eq!(line["s"], json!(60.0));
        assert!(who.iter().all(|(_, m)| m.get("pids").is_none() && m.get("cpu").is_none()), "who it is, not what it used");
        assert!(minute(&a, &snap(3_600_000, b.ps.clone()), &Table::new(), 501, &HashMap::new(), 0.0, &[], &[], &[]).is_none(), "an hour asleep isn't a minute");
    }

    #[test]
    fn a_period_is_the_average_of_its_minutes_and_the_busiest_one() {
        let dir = std::env::temp_dir().join(format!("devdock-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let u = Usage::default();
        let now = now_ms();
        let line = |ago: i64, cpu: f64, ns: f64, rx: f64| json!({ "t": now - ago * 60_000, "s": 60.0, "ns": ns, "cpu": 100.0, "rx": 1000.0, "tx": 0.0,
            "g": [["a:chrome", cpu, 500.0, 0.0, 0.0, rx, 0.0]] });
        let who = || vec![("a:chrome".to_string(), json!({ "kind": "app", "name": "Chrome" }))];
        u.store(&dir, Some((line(90, 99.0, 0.0, 0.0), who())), 1).unwrap(); // outside the hour
        u.store(&dir, Some((line(2, 80.0, 30.0, 2000.0), who())), 1).unwrap();
        // a line cut short by a crash stays apart from the next one
        std::fs::OpenOptions::new().append(true).open(dir.join(FILE)).unwrap().write_all(br#"{"t":1,"s":6"#).unwrap();
        u.store(&dir, Some((line(1, 20.0, 0.0, 0.0), who())), 1).unwrap();
        let q = u.query(&dir, "cpu", 60);
        let g = &q["groups"][0];
        assert_eq!((g["name"].clone(), g["cpu"].clone(), g["peak"].clone()), (json!("Chrome"), json!(50.0), json!(80.0)));
        assert_eq!(g["rx"], json!(2000.0), "network averages over the seconds it was watched");
        assert_eq!((q["covered"].clone(), q["total"]["rx"].clone()), (json!(120.0), json!(1000.0)));
        assert_eq!(u.info(&dir)["since"].as_i64(), Some(now - 90 * 60_000));
        prune(&dir, &mut Map::new(), now - 60 * 60_000).unwrap();
        assert_eq!(u.info(&dir)["since"].as_i64(), Some(now - 2 * 60_000), "older than the retention is gone");
        u.clear(&dir);
        assert_eq!(u.info(&dir)["bytes"], json!(0));
        u.store(&dir, None, 1).unwrap();
        assert!(!dir.join(KEYS).exists(), "with nothing recorded, nothing is written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lines_are_found_by_time_without_parsing() {
        assert_eq!(t_of(r#"{"t":1795792322000,"s":60.0}"#), Some(1795792322000));
        assert_eq!(t_of("junk"), None);
    }

    #[test]
    fn servers_and_agents_keep_their_key_across_restarts() {
        assert_eq!(hkey(&json!({ "key": "s:123", "kind": "server", "cwd": "/r/shop", "name": "shop" })), "srv:/r/shop");
        assert_eq!(hkey(&json!({ "key": "g:9", "kind": "agent", "agent": "Claude Code", "cwd": "/r/x" })), "agent:Claude Code:/r/x");
        assert_eq!(hkey(&json!({ "key": "a:com.x/Applications/X.app", "kind": "app" })), "a:com.x/Applications/X.app");
    }
}

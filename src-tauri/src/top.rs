//! What's using the Mac, for Home's CPU, Memory and Disk panels: every process, grouped by who
//! it belongs to (a dev server, a coding agent, an app) and ranked. Memory and disk of our own
//! processes come from the table. Other users' (WindowServer, coreaudiod, mds_stores) only `ps`
//! can read, as it runs setuid root, so it runs while a panel is open: about 10 ms of CPU every
//! 2 seconds. Every CPU figure comes from the same two ps readings, so they add up to the Mac's
//! own total over that window. What's left is the kernel (which ps can't see) and processes that
//! came and went between two readings: checked against top, kernel_task alone is a fraction of it.
use crate::sys::{self, CpuTicks};
use crate::table::{children, tree, Table};
use crate::util::{basename, round1, Get};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

type Ps = HashMap<i32, (u32, f64, f64, String)>;

/// The last ps reading and the Mac's CPU ticks with it, so each refresh needs one spawn, not two
#[derive(Default)]
pub struct Top { last: Mutex<Option<(Instant, Ps, Option<CpuTicks>)>> }

impl Top {
    pub async fn scan(&self, c: &crate::state::Ctx, by: &str) -> Value {
        let me = unsafe { libc::getuid() };
        let mut rows = mine(&c.table(), me, &HashMap::new());
        if !c.demo {
            let read = || async { parse_ps(&crate::util::run("/bin/ps", &["-A", "-o", "pid=,uid=,time=,rss=,comm="], crate::util::secs(5)).await.stdout) };
            // a rate needs two readings: the one from the last refresh, or one taken just now
            let prev = self.last.lock().unwrap().take().filter(|(at, _, _)| at.elapsed() < Duration::from_secs(10));
            let (at, before, t0) = match prev {
                Some(p) => p,
                None => { let p = read().await; let r = (Instant::now(), p, sys::cpu_ticks()); tokio::time::sleep(Duration::from_millis(700)).await; r }
            };
            let (now, t1) = (read().await, sys::cpu_ticks());
            let rates = cpu_rates(&before, &now, at.elapsed().as_secs_f64());
            rows = mine(&c.table(), me, &rates);
            rows.extend(others(&now, &rates, me));
            let total = t0.zip(t1).and_then(|(a, b)| sys::cpu_percent(a, b)).map(|p| p * sys::cores() as f64);
            rows.extend(total.and_then(|t| kernel(t, &rows)));
            *self.last.lock().unwrap() = Some((Instant::now(), now, t1));
        }
        let s = &c.sources;
        json!({ "by": by, "groups": group(&rows, &c.ports(), &s.coding.last(), &s.apps.last(), by) })
    }
}

/// One process, whoever owns it
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Row { pub pid: i32, pub ppid: i32, pub mine: bool, pub name: String, pub path: String, pub cpu: f64, pub mem: f64, pub dr: f64, pub dw: f64 }

/// "8188:32.45" (minutes:seconds, as macOS ps prints TIME) in seconds
pub fn cpu_time(s: &str) -> Option<f64> {
    let (m, sec) = s.split_once(':')?;
    Some(m.parse::<f64>().ok()? * 60.0 + sec.parse::<f64>().ok()?)
}

/// `ps -A -o pid=,uid=,time=,rss=,comm=`: pid -> (uid, CPU seconds, resident MB, path)
pub fn parse_ps(out: &str) -> Ps {
    out.lines().filter_map(|l| {
        let mut f = l.split_whitespace();
        let (pid, uid, time, rss) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, cpu_time(f.next()?)?, f.next()?.parse::<f64>().ok()?);
        let path = f.collect::<Vec<_>>().join(" ");
        Some((pid, (uid, time, round1(rss / 1024.0), path)))
    }).collect()
}

/// CPU % (of one core) of every process in both ps readings, `secs` apart
pub fn cpu_rates(prev: &Ps, cur: &Ps, secs: f64) -> HashMap<i32, f64> {
    cur.iter().filter_map(|(pid, c)| prev.get(pid).filter(|p| c.1 >= p.1 && secs > 0.0).map(|p| (*pid, round1((c.1 - p.1) / secs * 100.0)))).collect()
}

/// Other users' processes: resident memory only, the kernel doesn't tell us their footprint
pub fn others(cur: &Ps, rates: &HashMap<i32, f64>, me: u32) -> Vec<Row> {
    cur.iter().filter(|(_, c)| c.0 != me).map(|(&pid, c)| Row {
        pid, mine: false, name: basename(&c.3).to_string(), path: c.3.clone(), mem: c.2, cpu: rates.get(&pid).copied().unwrap_or(0.0),
        ..Default::default()
    }).collect()
}

/// Ours, with CPU from the ps window when there is one
pub fn mine(t: &Table, me: u32, rates: &HashMap<i32, f64>) -> Vec<Row> {
    t.values().filter(|p| p.uid == me).map(|p| Row {
        pid: p.pid, ppid: p.ppid, mine: true, name: basename(&p.comm).to_string(), path: p.comm.clone(),
        cpu: rates.get(&p.pid).copied().unwrap_or(p.cpu), mem: p.mem_mb, dr: p.disk_r, dw: p.disk_w,
    }).collect()
}

/// The Mac's total CPU (% of one core) less every process we saw twice
pub fn kernel(total: f64, rows: &[Row]) -> Option<Row> {
    let left = round1(total - rows.iter().map(|r| r.cpu).sum::<f64>());
    (left >= 1.0).then(|| Row { pid: 0, name: "Kernel and short-lived processes".into(), cpu: left, ..Default::default() })
}

fn pid(v: &Value) -> Option<i32> { v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64().map(|n| n as i32)) }

/// Groups, biggest first by `by` (cpu, mem or disk). Claimed in order: dev servers with what
/// they started, coding agents with what they started, apps with their own processes; the rest
/// by name, ours apart from macOS's.
pub fn group(rows: &[Row], ports: &[Value], agents: &[Value], apps: &[Value], by: &str) -> Vec<Value> {
    let t: Table = rows.iter().map(|r| (r.pid, crate::table::Proc { pid: r.pid, ppid: r.ppid, ..Default::default() })).collect();
    let kids = children(&t);
    let by_pid: HashMap<i32, &Row> = rows.iter().map(|r| (r.pid, r)).collect();
    let mut taken: HashSet<i32> = HashSet::new();
    let mut out: Vec<(Value, Vec<i32>)> = vec![];
    let claim = |pids: Vec<i32>, taken: &mut HashSet<i32>| -> Vec<i32> { pids.into_iter().filter(|p| by_pid.contains_key(p) && taken.insert(*p)).collect() };

    let mut servers: Vec<(i32, Vec<u64>, &Value)> = vec![];
    for p in ports {
        let (Some(pid), Some(port)) = (pid(&p["pid"]), p["port"].as_u64()) else { continue };
        match servers.iter_mut().find(|s| s.0 == pid) { Some(s) => s.1.push(port), None => servers.push((pid, vec![port], p)) }
    }
    for (pid, mut ports, p) in servers {
        let pids = claim(tree(pid, &kids), &mut taken);
        if pids.is_empty() { continue; }
        ports.sort();
        // the project it serves, like Ports shows it; else what the process calls itself
        let dir = p.str_of("scriptPath").trim_end_matches('/');
        let name = [basename(dir), p.str_of("procName"), p.str_of("runtimeName"), p.str_of("name")].into_iter().find(|n| !n.is_empty() && *n != "/").unwrap_or("server");
        out.push((json!({ "key": format!("s:{pid}"), "kind": "server", "pid": pid.to_string(), "name": name, "cwd": dir, "ports": ports,
            "runtime": p["runtime"], "runtimeColor": p["runtimeColor"] }), pids));
    }
    for a in agents {
        let Some(pid) = pid(&a["pid"]) else { continue };
        let pids = claim(tree(pid, &kids), &mut taken);
        if pids.is_empty() { continue; }
        out.push((json!({ "key": format!("g:{pid}"), "kind": "agent", "pid": pid.to_string(), "name": a.str_of("name"), "agent": a["agent"], "cwd": a["cwd"] }), pids));
    }
    for a in apps {
        let own: Vec<i32> = a["processes"].as_array().into_iter().flatten().filter(|p| p["own"] == json!(true)).filter_map(|p| pid(&p["pid"])).collect();
        let pids = claim(own, &mut taken);
        if pids.is_empty() { continue; }
        out.push((json!({ "key": format!("a:{}", a.str_of("bundleId").to_string() + a.str_of("path")), "kind": "app", "pid": a["pid"], "name": a["name"],
            "bundleId": a["bundleId"], "path": a["path"], "hasIcon": a["hasIcon"] }), pids));
    }
    let mut rest: HashMap<(bool, String), Vec<i32>> = HashMap::new();
    for r in rows.iter().filter(|r| !taken.contains(&r.pid)) { rest.entry((r.mine, r.name.clone())).or_default().push(r.pid); }
    for ((mine, name), pids) in rest {
        let kind = if pids == [0] { "rest" } else if mine { "process" } else { "system" };
        let path = by_pid[&pids[0]].path.clone();
        out.push((json!({ "key": format!("{}:{name}", &kind[..1]), "kind": kind, "pid": pids[0].to_string(), "name": name, "path": path }), pids));
    }

    let val = |r: &Row| match by { "mem" => r.mem, "disk" => r.dr + r.dw, _ => r.cpu };
    let mut groups: Vec<(f64, Value)> = out.into_iter().map(|(mut g, mut pids)| {
        let rs: Vec<&Row> = pids.iter().map(|p| by_pid[p]).collect();
        let sum = |f: fn(&Row) -> f64| round1(rs.iter().map(|r| f(r)).sum());
        pids.sort_by(|a, b| val(by_pid[b]).total_cmp(&val(by_pid[a])));
        g["cpu"] = json!(sum(|r| r.cpu)); g["mem"] = json!(sum(|r| r.mem));
        g["diskR"] = json!(sum(|r| r.dr)); g["diskW"] = json!(sum(|r| r.dw));
        g["count"] = json!(pids.len());
        g["pids"] = json!(pids.iter().map(|p| p.to_string()).collect::<Vec<_>>());
        g["procs"] = json!(pids.iter().take(8).map(|p| { let r = by_pid[p];
            json!({ "pid": r.pid.to_string(), "name": r.name, "mine": r.mine, "cpu": r.cpu, "mem": r.mem, "diskR": r.dr, "diskW": r.dw }) }).collect::<Vec<_>>());
        (rs.iter().map(|r| val(r)).sum(), g)
    }).filter(|(v, _)| *v > 0.0).collect();
    groups.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.str_of("key").cmp(b.1.str_of("key"))));
    groups.into_iter().take(40).map(|(_, g)| g).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: i32, ppid: i32, name: &str, cpu: f64, mem: f64) -> Row {
        Row { pid, ppid, mine: true, name: name.into(), path: format!("/bin/{name}"), cpu, mem, ..Default::default() }
    }

    #[test]
    fn ps_time_and_lines() {
        assert_eq!(cpu_time("8188:32.45"), Some(8188.0 * 60.0 + 32.45));
        assert_eq!(cpu_time("0:00.01"), Some(0.01));
        assert_eq!(cpu_time("junk"), None);
        let p = parse_ps("  414    88 8188:32.45 236736 /System/Library/WindowServer\n 9 501 0:01.00 1024 /Applications/My App.app/Contents/MacOS/My App\nbad line\n");
        assert_eq!(p[&414], (88, 8188.0 * 60.0 + 32.45, 231.2, "/System/Library/WindowServer".into()));
        assert_eq!(p[&9].3, "/Applications/My App.app/Contents/MacOS/My App");
        assert_eq!(p.len(), 2);
    }

    #[test]
    fn cpu_is_a_rate_between_two_ps_readings_and_the_rest_is_the_kernel() {
        let a = parse_ps("414 88 10:00.00 1024 /x/WindowServer\n1 0 1:00.00 2048 /sbin/launchd\n7 501 0:01.00 10 /bin/mine\n");
        let b = parse_ps("414 88 10:01.00 1024 /x/WindowServer\n1 0 1:00.00 2048 /sbin/launchd\n7 501 0:02.00 10 /bin/mine\n55 0 0:09.00 10 /usr/sbin/new\n");
        let rates = cpu_rates(&a, &b, 2.0);
        assert_eq!((rates[&414], rates[&7], rates.get(&55)), (50.0, 50.0, None), "a new one waits for a second reading");
        let mut o = others(&b, &rates, 501);
        o.sort_by_key(|r| r.pid);
        assert_eq!(o.iter().map(|r| (r.pid, r.name.as_str(), r.cpu, r.mine)).collect::<Vec<_>>(),
            vec![(1, "launchd", 0.0, false), (55, "new", 0.0, false), (414, "WindowServer", 50.0, false)], "mine skipped");
        let mut t = Table::new();
        t.insert(7, crate::table::Proc { pid: 7, uid: 501, comm: "/bin/mine".into(), cpu: 9.0, mem_mb: 3.0, ..Default::default() });
        t.insert(8, crate::table::Proc { pid: 8, uid: 501, comm: "/bin/fresh".into(), cpu: 4.0, ..Default::default() });
        let m = mine(&t, 501, &rates);
        assert_eq!(m.iter().find(|r| r.pid == 7).unwrap().cpu, 50.0, "the ps window, like everyone else");
        assert_eq!(m.iter().find(|r| r.pid == 8).unwrap().cpu, 4.0, "the table's when ps hasn't seen it twice");
        let rows = [o, m].concat();
        assert_eq!(kernel(120.0, &rows).map(|k| (k.pid, k.cpu)), Some((0, 16.0)));
        assert_eq!(kernel(104.5, &rows), None, "under one percent is noise");
    }

    #[test]
    fn groups_servers_agents_apps_then_by_name() {
        let mut rows = vec![
            row(100, 1, "node", 20.0, 300.0), row(101, 100, "esbuild", 30.0, 50.0), // a server and what it started
            row(200, 1, "claude", 5.0, 400.0), row(201, 200, "rg", 40.0, 10.0),       // an agent and its search
            row(300, 1, "Google Chrome", 10.0, 500.0), row(301, 300, "Google Chrome Helper", 25.0, 900.0), row(302, 300, "zsh", 1.0, 5.0),
            row(400, 1, "rustc", 15.0, 100.0), row(401, 1, "rustc", 15.0, 100.0),
            row(500, 1, "idle", 0.0, 0.0),
        ];
        rows.push(Row { pid: 414, ppid: 1, mine: false, name: "WindowServer".into(), path: "/x/WindowServer".into(), cpu: 12.0, mem: 200.0, ..Default::default() });
        let ports = vec![json!({ "pid": "100", "port": 5173, "scriptPath": "/r/shop/web/" }), json!({ "pid": "100", "port": 3000 })];
        let agents = vec![json!({ "pid": "200", "agent": "Claude Code", "name": "devdock" })];
        let apps = vec![json!({ "pid": "300", "name": "Google Chrome", "bundleId": "com.google.Chrome", "path": "/Applications/Google Chrome.app",
            "processes": [{ "pid": "300", "own": true }, { "pid": "301", "own": true }, { "pid": "302", "own": false }] })];

        let g = group(&rows, &ports, &agents, &apps, "cpu");
        let brief: Vec<(&str, f64, u64)> = g.iter().map(|x| (x["kind"].as_str().unwrap(), x["cpu"].as_f64().unwrap(), x["count"].as_u64().unwrap())).collect();
        assert_eq!(brief, vec![("server", 50.0, 2), ("agent", 45.0, 2), ("app", 35.0, 2), ("process", 30.0, 2), ("system", 12.0, 1), ("process", 1.0, 1)],
            "idle dropped; the shell Chrome launched isn't Chrome");
        assert_eq!((g[0]["name"].as_str(), &g[0]["ports"]), (Some("web"), &json!([3000, 5173])), "named for its project");
        assert_eq!(g[2]["procs"][0]["pid"], "301", "processes ranked too");
        assert_eq!(g[3]["name"], "rustc");
        assert_eq!(group(&rows, &ports, &agents, &apps, "mem")[0]["kind"], "app");
    }
}

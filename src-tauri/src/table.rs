//! The process table every part reads: one kernel pass per scan, with CPU as a rate.
//! CPU like Activity Monitor: CPU time used since the last reading, over the time between.
//! The kernel counts CPU time in nanoseconds, so a one-second window is exact.
use crate::procs;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Default)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub uid: u32,
    pub comm: String,
    pub name: String,
    pub nfiles: u32,
    /// % of one core
    pub cpu: f64,
    /// Activity Monitor's Memory (phys footprint), MB; RSS when the footprint isn't readable
    pub mem_mb: f64,
    pub rss_mb: f64,
    pub cpu_sec: Option<f64>,
    /// ms since the epoch
    pub started_at: Option<i64>,
}

pub type Table = HashMap<i32, Proc>;

#[derive(Default)]
pub struct Sampler {
    reader: procs::Reader,
    prev: HashMap<i32, (u64, Option<u64>, Instant, f64)>, // pid -> (cpu ns, started, when, cpu %)
}

impl Sampler {
    pub fn sample(&mut self) -> Arc<Table> {
        let raw = self.reader.snapshot();
        self.from(raw, Instant::now())
    }

    pub fn from(&mut self, raw: HashMap<i32, procs::Proc>, now: Instant) -> Arc<Table> {
        let mut table = HashMap::with_capacity(raw.len());
        let mut next = HashMap::with_capacity(raw.len());
        for (pid, p) in raw {
            let cpu = match p.cpu_ns {
                None => 0.0,
                Some(ns) => match self.prev.get(&pid) {
                    // same process (a reused pid starts at another time), measured over 0.9s or more
                    Some(&(pns, started, t, last)) if started == p.started && ns >= pns => {
                        let dt = now.duration_since(t).as_secs_f64();
                        if dt < 0.9 { next.insert(pid, (pns, started, t, last)); last }
                        else { let c = crate::util::round1((ns - pns) as f64 / 1e9 / dt * 100.0); next.insert(pid, (ns, p.started, now, c)); c }
                    }
                    _ => { next.insert(pid, (ns, p.started, now, 0.0)); 0.0 } // first sight: a rate needs two readings
                },
            };
            let rss_mb = p.rss.map(|b| b as f64 / 1048576.0).unwrap_or(0.0);
            table.insert(pid, Proc {
                pid, ppid: p.ppid, uid: p.uid, nfiles: p.nfiles,
                cpu,
                mem_mb: crate::util::round1(p.footprint.or(p.rss).map(|b| b as f64 / 1048576.0).unwrap_or(0.0)),
                rss_mb,
                cpu_sec: p.cpu_ns.map(|n| n as f64 / 1e9),
                started_at: p.started.map(|s| s as i64 * 1000),
                comm: p.comm, name: p.name,
            });
        }
        self.prev = next; // forgets pids that are gone
        Arc::new(table)
    }
}

/// Children of each pid
pub fn children(t: &Table) -> HashMap<i32, Vec<i32>> {
    let mut kids: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in t.values() { kids.entry(p.ppid).or_default().push(p.pid); }
    kids
}

/// pid and everything under it
pub fn tree(root: i32, kids: &HashMap<i32, Vec<i32>>) -> Vec<i32> {
    let mut out = vec![];
    let mut stack = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(x) = stack.pop() {
        if !seen.insert(x) { continue; }
        out.push(x);
        if let Some(k) = kids.get(&x) { stack.extend(k); }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn raw(pid: i32, cpu_ns: u64, started: u64) -> procs::Proc {
        procs::Proc { pid, ppid: 1, uid: 501, comm: "x".into(), name: "x".into(), nfiles: 0, started: Some(started), cpu_ns: Some(cpu_ns), footprint: Some(10 << 20), rss: Some(20 << 20) }
    }

    #[test]
    fn cpu_is_a_rate_between_readings() {
        let mut s = Sampler::default();
        let t0 = Instant::now();
        let a = s.from(HashMap::from([(7, raw(7, 0, 100))]), t0);
        assert_eq!(a[&7].cpu, 0.0); // first sight
        assert_eq!(a[&7].mem_mb, 10.0); // footprint, not rss
        // 0.5 s of CPU in 2 s: 25%
        let b = s.from(HashMap::from([(7, raw(7, 500_000_000, 100))]), t0 + Duration::from_secs(2));
        assert_eq!(b[&7].cpu, 25.0);
        // a quick rescan keeps the last full window
        let c = s.from(HashMap::from([(7, raw(7, 510_000_000, 100))]), t0 + Duration::from_millis(2100));
        assert_eq!(c[&7].cpu, 25.0);
        // a reused pid (another start time) starts over
        let d = s.from(HashMap::from([(7, raw(7, 9_000_000_000, 200))]), t0 + Duration::from_secs(4));
        assert_eq!(d[&7].cpu, 0.0);
    }

    #[test]
    fn a_busy_thread_reads_as_about_one_core() {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let st = stop.clone();
        let h = std::thread::spawn(move || { let mut x = 0u64; while !st.load(std::sync::atomic::Ordering::Relaxed) { x = x.wrapping_add(1); } x });
        let mut s = Sampler::default();
        s.sample();
        std::thread::sleep(Duration::from_millis(1200));
        let t = s.sample();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        h.join().unwrap();
        let me = t[&(std::process::id() as i32)].cpu;
        // at least the spinning thread; other tests run in this process too
        assert!(me >= 80.0 && me <= crate::sys::cores() as f64 * 100.0, "{me}%");
    }

    #[test]
    fn trees() {
        let mut t = Table::new();
        for (pid, ppid) in [(1, 0), (10, 1), (11, 10), (12, 11), (20, 1)] { t.insert(pid, Proc { pid, ppid, ..Default::default() }); }
        let k = children(&t);
        let mut tr = tree(10, &k); tr.sort();
        assert_eq!(tr, vec![10, 11, 12]);
    }
}

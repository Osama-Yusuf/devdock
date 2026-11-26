//! The process table, read straight from the kernel (libproc), the way Activity Monitor does.
//! Replaces spawning `ps`, `top` and `lsof`: one in-process pass costs milliseconds, not a
//! child process per question.
//!
//! What each field matches, checked against the tools in the tests below:
//!   `comm`      ps -o comm   (argv[0]: what a process calls itself, e.g. "claude bg-pty-host")
//!   `cpu_ns`    ps -o time   (user + system CPU time)
//!   `footprint` top's MEM / Activity Monitor's Memory column (phys_footprint)
//!   `rss`       ps -o rss
use std::collections::HashMap;
use std::ffi::CStr;
use std::mem::{size_of, zeroed};
use std::os::raw::{c_int, c_void};
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub uid: u32,
    /// argv[0], or the executable path when argv can't be read (another user's process)
    pub comm: String,
    /// the kernel's short name (p_comm, at most 16 bytes): what `lsof` calls COMMAND
    pub name: String,
    /// size of its file table, for reading its descriptors
    pub nfiles: u32,
    /// seconds since the epoch. None, like cpu and memory, for another user's process:
    /// the kernel only tells us its parent, owner and executable
    pub started: Option<u64>,
    /// user + system CPU time, nanoseconds
    pub cpu_ns: Option<u64>,
    /// bytes
    pub footprint: Option<u64>,
    pub rss: Option<u64>,
}

/// CPU times come in Mach ticks: 1 ns on Intel, 125/3 ns on Apple silicon
fn ticks_to_ns(t: u64) -> u64 {
    #[repr(C)]
    struct Timebase { numer: u32, denom: u32 }
    unsafe extern "C" { fn mach_timebase_info(info: *mut Timebase) -> c_int; }
    static TB: OnceLock<(u64, u64)> = OnceLock::new();
    let (n, d) = *TB.get_or_init(|| {
        let mut i = Timebase { numer: 0, denom: 0 };
        unsafe { mach_timebase_info(&mut i) };
        if i.denom == 0 { (1, 1) } else { (i.numer as u64, i.denom as u64) }
    });
    (t as u128 * n as u128 / d as u128) as u64
}

fn pidinfo<T>(pid: i32, flavor: c_int) -> Option<T> {
    let mut v: T = unsafe { zeroed() };
    let size = size_of::<T>() as c_int;
    let n = unsafe { libc::proc_pidinfo(pid, flavor, 0, &mut v as *mut T as *mut c_void, size) };
    (n == size).then_some(v)
}

fn cstr(chars: &[libc::c_char]) -> String {
    unsafe { CStr::from_ptr(chars.as_ptr()) }.to_string_lossy().into_owned()
}

pub fn all_pids() -> Vec<i32> {
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 { return vec![]; }
    let mut buf = vec![0 as c_int; n as usize + 64]; // room for processes born since the count
    let got = unsafe { libc::proc_listallpids(buf.as_mut_ptr() as *mut c_void, (buf.len() * size_of::<c_int>()) as c_int) };
    buf.truncate(got.max(0) as usize);
    buf.retain(|&p| p > 0);
    buf
}

/// argv[0] from KERN_PROCARGS2: [argc: i32][exec path\0][\0 padding][argv[0]\0]...
/// Only readable for our own processes; None otherwise.
pub fn argv0(pid: i32) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 8 {
        return None;
    }
    let mut buf = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr() as *mut c_void, &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buf.truncate(size);
    let rest = &buf[size_of::<c_int>()..];
    let exec_end = rest.iter().position(|&b| b == 0)?;
    let args = &rest[exec_end..];
    let start = args.iter().position(|&b| b != 0)?;
    let arg = &args[start..];
    let end = arg.iter().position(|&b| b == 0).unwrap_or(arg.len());
    let s = String::from_utf8_lossy(&arg[..end]).into_owned();
    (!s.is_empty()).then_some(s)
}

pub fn exe_path(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

/// The process's working directory (what `lsof -d cwd` reports)
pub fn cwd(pid: i32) -> Option<PathBuf> {
    let v: libc::proc_vnodepathinfo = pidinfo(pid, libc::PROC_PIDVNODEPATHINFO)?;
    let flat: &[libc::c_char] = unsafe {
        std::slice::from_raw_parts(v.pvi_cdir.vip_path.as_ptr() as *const libc::c_char, libc::MAXPATHLEN as usize)
    };
    let p = cstr(flat);
    (!p.is_empty()).then(|| PathBuf::from(p))
}

/// When any process started, other users' too: sysctl kern.proc.pid needs no privileges.
/// kinfo_proc (648 bytes on 64-bit) starts with extern_proc, whose first field is a union
/// holding p_starttime, a timeval: so the seconds are the first 8 bytes.
pub fn start_time(pid: i32) -> Option<u64> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let mut buf = [0u8; 648];
    let mut len = buf.len();
    let r = unsafe { libc::sysctl(mib.as_mut_ptr(), 4, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if r != 0 || len != buf.len() { return None; } // len 0: no such process
    let secs = i64::from_ne_bytes(buf[..8].try_into().ok()?);
    (secs > 0).then_some(secs as u64)
}

/// One process, or None when it exited mid-read
pub fn read(pid: i32) -> Option<Proc> { Reader::default().read(pid) }

/// Every process we can see, keyed by pid
pub fn snapshot() -> HashMap<i32, Proc> { Reader::default().snapshot() }

/// What doesn't change while a process lives: its argv[0] (or executable) and, for another
/// user's process, its start time. Both cost more to read than all its live stats together.
struct Fixed { key: (u64, String), comm: String, started: Option<u64> }

/// Reads the table, remembering each process's fixed parts between reads. A process younger
/// than a minute is always read fresh: Node servers retitle themselves (process.title) just
/// after starting, so their argv[0] isn't settled yet.
#[derive(Default)]
pub struct Reader { fixed: HashMap<i32, Fixed> }

const SETTLED: u64 = 60;

impl Reader {
    pub fn read(&mut self, pid: i32) -> Option<Proc> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let Some(bsd) = pidinfo::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO) else {
            // another user's: the kernel only tells us its parent, owner and executable
            let s: libc::proc_bsdshortinfo = pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
            let name = cstr(&s.pbsi_comm);
            let key = (s.pbsi_ppid as u64, name.clone()); // no start time to tell a reused pid by
            let f = self.fixed(pid, key, false, || {
                let started = start_time(pid);
                (exe_path(pid).unwrap_or_else(|| name.clone()), started)
            });
            return Some(Proc {
                pid, ppid: s.pbsi_ppid as i32, uid: s.pbsi_uid, comm: f.0, name, nfiles: 0,
                started: f.1, cpu_ns: None, footprint: None, rss: None,
            });
        };
        let name = cstr(&bsd.pbi_comm);
        let started = bsd.pbi_start_tvsec;
        let young = now.saturating_sub(started) < SETTLED;
        let (comm, _) = self.fixed(pid, (started, name.clone()), young, || {
            (argv0(pid).or_else(|| exe_path(pid)).unwrap_or_else(|| name.clone()), Some(started))
        });
        // rusage carries CPU time, footprint and resident size in one call
        let mut ru: libc::rusage_info_v4 = unsafe { zeroed() };
        let ru_ok = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, &mut ru as *mut _ as *mut libc::rusage_info_t) } == 0;
        Some(Proc {
            pid, ppid: bsd.pbi_ppid as i32, uid: bsd.pbi_uid, comm, name, nfiles: bsd.pbi_nfiles,
            started: Some(started),
            cpu_ns: ru_ok.then(|| ticks_to_ns(ru.ri_user_time + ru.ri_system_time)),
            footprint: ru_ok.then_some(ru.ri_phys_footprint),
            rss: ru_ok.then_some(ru.ri_resident_size),
        })
    }

    fn fixed(&mut self, pid: i32, key: (u64, String), fresh: bool, read: impl FnOnce() -> (String, Option<u64>)) -> (String, Option<u64>) {
        match self.fixed.get(&pid) {
            Some(f) if !fresh && f.key == key => (f.comm.clone(), f.started),
            _ => {
                let (comm, started) = read();
                self.fixed.insert(pid, Fixed { key, comm: comm.clone(), started });
                (comm, started)
            }
        }
    }

    /// Every process we can see, keyed by pid; forgets the ones that are gone
    pub fn snapshot(&mut self) -> HashMap<i32, Proc> {
        let out: HashMap<i32, Proc> = all_pids().into_iter().filter_map(|p| self.read(p)).map(|p| (p.pid, p)).collect();
        self.fixed.retain(|pid, _| out.contains_key(pid));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// ps's own view of a pid: (ppid, cpu seconds, rss KB, comm)
    fn ps(pid: i32) -> (i32, f64, u64, String) {
        let out = Command::new("ps").args(["-o", "ppid=,time=,rss=,comm=", "-p", &pid.to_string()]).env("LC_ALL", "C").output().unwrap();
        let line = String::from_utf8(out.stdout).unwrap();
        let mut it = line.split_whitespace();
        let ppid = it.next().unwrap().parse().unwrap();
        let secs = it.next().unwrap().split(':').fold(0.0, |a, v| a * 60.0 + v.parse::<f64>().unwrap());
        let rss = it.next().unwrap().parse().unwrap();
        (ppid, secs, rss, it.collect::<Vec<_>>().join(" "))
    }

    #[test]
    fn start_time_of_any_process_matches_ps() {
        let me = std::process::id() as i32;
        assert_eq!(start_time(me), read(me).unwrap().started);
        // a root process: proc_pidinfo can't read it, the sysctl can
        let root = Command::new("pgrep").args(["-U", "0", "-x", "syslogd"]).output().unwrap();
        let pid: i32 = String::from_utf8(root.stdout).unwrap().trim().parse().unwrap();
        assert!(pidinfo::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO).is_none(), "run the tests as yourself, not root");
        let lstart = Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).env("LC_ALL", "C").output().unwrap();
        let lstart = String::from_utf8(lstart.stdout).unwrap();
        let epoch = Command::new("date").args(["-j", "-f", "%a %b %e %T %Y", lstart.trim(), "+%s"]).env("LC_ALL", "C").output().unwrap();
        let want: u64 = String::from_utf8(epoch.stdout).unwrap().trim().parse().unwrap();
        assert_eq!(start_time(pid), Some(want));
        assert_eq!(read(pid).unwrap().started, Some(want));
        assert_eq!(start_time(999_999), None);
    }

    #[test]
    fn own_process_matches_ps() {
        // burn some CPU so the time is measurable
        let t = std::time::Instant::now();
        let mut x = 0u64;
        while t.elapsed().as_millis() < 300 { x = x.wrapping_mul(31).wrapping_add(7); }
        assert!(x != 1);
        let me = std::process::id() as i32;
        // other tests burn CPU in this process meanwhile, so ps's reading must land between two of ours
        let p = read(me).unwrap();
        let (ppid, secs, rss_kb, comm) = ps(me);
        let after = read(me).unwrap().cpu_ns.unwrap() as f64 / 1e9;
        assert_eq!(p.ppid, ppid);
        assert_eq!(p.comm, comm);
        let ours = p.cpu_ns.unwrap() as f64 / 1e9;
        assert!(secs > ours - 0.02 && secs < after + 0.02, "ps {secs}s outside ours {ours}s..{after}s");
        assert!(ours >= 0.25, "300ms of spinning should show, got {ours}s");
        let rss = p.rss.unwrap() / 1024;
        assert!((rss as i64 - rss_kb as i64).abs() < 2048, "rss {rss}KB vs ps {rss_kb}KB");
        assert!(p.footprint.unwrap() > 0);
    }

    #[test]
    fn retitled_and_spaced_names_read_like_ps() {
        // a child with a path containing spaces, renamed through argv[0], like "claude bg-pty-host"
        let mut child = Command::new("/bin/sh").args(["-c", "exec -a 'claude bg-test' /bin/sleep 5"]).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let pid = child.id() as i32;
        let (_, _, _, comm) = ps(pid);
        assert_eq!(read(pid).unwrap().comm, comm);
        assert_eq!(comm, "claude bg-test");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn snapshot_sees_what_ps_sees() {
        let ours = snapshot();
        // zombies (exited, not yet reaped) have no task left for the kernel to describe
        let out = Command::new("ps").args(["-axo", "pid=,stat="]).output().unwrap();
        let theirs: Vec<i32> = String::from_utf8(out.stdout).unwrap().lines()
            .filter_map(|l| { let mut it = l.split_whitespace(); let pid = it.next()?.parse().ok()?; (!it.next()?.starts_with('Z')).then_some(pid) })
            .collect();
        // a pid only counts as missed if it's still alive: processes exit between the two reads
        let alive = |p: i32| unsafe { libc::kill(p, 0) == 0 || *libc::__error() == libc::EPERM };
        let unread: Vec<i32> = theirs.into_iter().filter(|p| !ours.contains_key(p) && read(*p).is_none()).collect();
        // other tests spawn processes too, and one caught mid-exec can't be read for a moment
        std::thread::sleep(std::time::Duration::from_millis(100));
        let what = |p: i32| String::from_utf8(Command::new("ps").args(["-o", "pid=,ppid=,user=,stat=,comm=", "-p", &p.to_string()]).output().unwrap().stdout).unwrap();
        let zombie = |p: i32| what(p).split_whitespace().nth(3).is_some_and(|st| st.starts_with('Z'));
        let missing: Vec<_> = unread.into_iter().filter(|&p| alive(p) && read(p).is_none() && !zombie(p)).collect();
        assert!(missing.is_empty(), "{} live pids ps sees but we can't read: {:?}", missing.len(), missing.iter().take(10).map(|p| what(*p)).collect::<Vec<_>>());
        // launchd: root's, so only its parent and path
        let init = &ours[&1];
        assert_eq!((init.ppid, init.comm.as_str(), init.cpu_ns), (0, "/sbin/launchd", None));
    }

    #[test]
    fn cwd_matches_lsof() {
        let me = std::process::id() as i32;
        assert_eq!(cwd(me).unwrap(), std::env::current_dir().unwrap());
    }

    #[test]
    fn footprint_matches_top() {
        // top's MEM column for this test process, in its own units (e.g. "12M")
        let me = std::process::id() as i32;
        let out = Command::new("top").args(["-l", "1", "-pid", &me.to_string(), "-stats", "pid,mem"]).output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let mem = text.lines().filter_map(|l| { let mut it = l.split_whitespace(); (it.next()? == me.to_string()).then(|| it.next().map(str::to_string)).flatten() }).next().unwrap();
        let num: f64 = mem.trim_end_matches(['+', '-']).trim_end_matches(['K', 'M', 'G', 'B']).parse().unwrap();
        let mb = match mem.trim_end_matches(['+', '-']).chars().last().unwrap() { 'K' => num / 1024.0, 'G' => num * 1024.0, 'M' => num, _ => num / 1048576.0 };
        let ours = read(me).unwrap().footprint.unwrap() as f64 / 1048576.0;
        assert!((ours - mb).abs() <= mb * 0.15 + 1.0, "footprint {ours:.1}MB vs top {mb:.1}MB");
    }

    #[test]
    fn snapshot_is_fast() {
        let mut r = Reader::default();
        r.snapshot(); // warm: what the 1s poll does after its first tick
        let t = std::time::Instant::now();
        let n = r.snapshot().len();
        let ms = t.elapsed().as_millis();
        eprintln!("snapshot: {n} processes in {ms}ms");
        assert!(ms < 200, "{n} processes took {ms}ms");
    }
}
#[cfg(test)]
mod bench {
    use super::*;
    #[test]
    #[ignore]
    fn where_a_snapshot_spends() {
        let t = |name: &str, f: &dyn Fn()| { let s = std::time::Instant::now(); for _ in 0..5 { f(); } println!("{name}: {:?}", s.elapsed() / 5); };
        let pids = all_pids();
        println!("{} pids", pids.len());
        t("all_pids", &|| { all_pids(); });
        t("bsdinfo", &|| { for &p in &pids { let _: Option<libc::proc_bsdinfo> = pidinfo(p, libc::PROC_PIDTBSDINFO); } });
        t("taskinfo", &|| { for &p in &pids { let _: Option<libc::proc_taskinfo> = pidinfo(p, libc::PROC_PIDTASKINFO); } });
        t("rusage", &|| { for &p in &pids { let mut ru: libc::rusage_info_v4 = unsafe { zeroed() }; unsafe { libc::proc_pid_rusage(p, libc::RUSAGE_INFO_V4, &mut ru as *mut _ as *mut libc::rusage_info_t) }; } });
        t("argv0", &|| { for &p in &pids { argv0(p); } });
        t("exe_path", &|| { for &p in &pids { exe_path(p); } });
        t("start_time", &|| { for &p in &pids { start_time(p); } });
        t("snapshot, cold", &|| { snapshot(); });
        let warm = std::cell::RefCell::new(Reader::default());
        warm.borrow_mut().snapshot();
        t("snapshot, warm", &|| { warm.borrow_mut().snapshot(); });
    }
}

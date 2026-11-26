//! Open files and sockets of a process, from the kernel (libproc): what `lsof` reported,
//! without spawning it. Only our own user's processes are readable, as with plain `lsof`.
use libproc::libproc::file_info::{pidfdinfo, ListFDs, PIDFDInfo, PIDFDInfoFlavor, ProcFDType};
use libproc::libproc::net_info::{SocketFDInfo, SocketInfoKind, TcpSIState};
use libproc::libproc::proc_pid::listpidinfo;
use std::ffi::CStr;

/// A TCP socket a process listens on
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Listener {
    pub port: u16,
}

fn fds(pid: i32, max: usize) -> Vec<(i32, ProcFDType)> {
    listpidinfo::<ListFDs>(pid, max)
        .map(|v| v.into_iter().map(|f| (f.proc_fd, ProcFDType::from(f.proc_fdtype))).collect())
        .unwrap_or_default()
}

/// Every TCP port this process is listening on (IPv4 and IPv6 both give the same port once)
pub fn listening(pid: i32, nfiles: usize) -> Vec<Listener> {
    let mut out = vec![];
    for (fd, kind) in fds(pid, nfiles.max(64)) {
        if !matches!(kind, ProcFDType::Socket) { continue; }
        let Ok(s) = pidfdinfo::<SocketFDInfo>(pid, fd) else { continue };
        if s.psi.soi_kind != SocketInfoKind::Tcp as i32 { continue; }
        let tcp = unsafe { s.psi.soi_proto.pri_tcp };
        if !matches!(TcpSIState::from(tcp.tcpsi_state), TcpSIState::Listen) { continue; }
        // the port is stored in network byte order in the low 16 bits
        let port = u16::from_be(tcp.tcpsi_ini.insi_lport as u16);
        let l = Listener { port };
        if !out.contains(&l) { out.push(l); }
    }
    out
}

#[repr(C)]
struct VnodeFdInfoWithPath {
    pfi: libproc::libproc::net_info::ProcFileInfo,
    pvip: libc::vnode_info_path,
}
impl Default for VnodeFdInfoWithPath {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}
impl PIDFDInfo for VnodeFdInfoWithPath {
    fn flavor() -> PIDFDInfoFlavor { PIDFDInfoFlavor::VNodePathInfo }
}

/// What a file descriptor points at, in lsof's words: REG (a file), CHR (a terminal), PIPE
#[derive(Debug, Clone, PartialEq)]
pub struct Fd {
    pub fd: i32,
    pub kind: &'static str,
    pub path: Option<String>,
}

const VREG: i32 = 1;
const VCHR: i32 = 4;

/// The given descriptors of a process (stdout and stderr for logs)
pub fn describe(pid: i32, which: &[i32]) -> Vec<Fd> {
    let mut out = vec![];
    for (fd, kind) in fds(pid, 4096) {
        if !which.contains(&fd) { continue; }
        match kind {
            ProcFDType::Pipe => out.push(Fd { fd, kind: "PIPE", path: None }),
            ProcFDType::VNode => {
                let Ok(v) = pidfdinfo::<VnodeFdInfoWithPath>(pid, fd) else { continue };
                let flat: &[libc::c_char] = unsafe {
                    std::slice::from_raw_parts(v.pvip.vip_path.as_ptr() as *const libc::c_char, libc::MAXPATHLEN as usize)
                };
                let path = unsafe { CStr::from_ptr(flat.as_ptr()) }.to_string_lossy().into_owned();
                let kind = match v.pvip.vip_vi.vi_type { VREG => "REG", VCHR => "CHR", _ => "VNODE" };
                out.push(Fd { fd, kind, path: (!path.is_empty()).then_some(path) });
            }
            _ => out.push(Fd { fd, kind: "OTHER", path: None }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn sees_our_own_listener_like_lsof() {
        let l4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let l6 = std::net::TcpListener::bind("[::1]:0").unwrap();
        let (p4, p6) = (l4.local_addr().unwrap().port(), l6.local_addr().unwrap().port());
        let me = std::process::id() as i32;
        let ours: Vec<u16> = listening(me, 64).into_iter().map(|l| l.port).collect();
        assert!(ours.contains(&p4) && ours.contains(&p6), "{ours:?} missing {p4} or {p6}");
        // lsof agrees
        let out = Command::new("lsof").args(["-a", "-p", &me.to_string(), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"]).output().unwrap();
        let theirs: Vec<u16> = String::from_utf8_lossy(&out.stdout).lines()
            .filter_map(|l| l.strip_prefix('n')?.rsplit(':').next()?.parse().ok()).collect();
        let mut a = ours.clone(); a.sort(); a.dedup();
        let mut b = theirs; b.sort(); b.dedup();
        assert_eq!(a, b);
    }

    #[test]
    fn closed_listener_is_gone() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let me = std::process::id() as i32;
        assert!(!listening(me, 64).iter().any(|x| x.port == port));
    }

    #[test]
    fn stdout_to_a_file_and_a_pipe() {
        let dir = std::env::temp_dir().join(format!("devdock-fds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("out.log");
        let f = std::fs::File::create(&log).unwrap();
        let mut child = Command::new("/bin/sleep").arg("5").stdout(f).stderr(std::process::Stdio::piped()).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let fds = describe(child.id() as i32, &[1, 2]);
        child.kill().unwrap();
        child.wait().unwrap();
        let out = fds.iter().find(|f| f.fd == 1).unwrap();
        assert_eq!(out.kind, "REG");
        assert_eq!(std::fs::canonicalize(out.path.as_ref().unwrap()).unwrap(), std::fs::canonicalize(&log).unwrap());
        assert_eq!(fds.iter().find(|f| f.fd == 2).unwrap().kind, "PIPE");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn every_listener_on_this_mac_matches_lsof() {
        // the whole table, as the port scan reads it, against lsof's own listing
        let snap = crate::procs::snapshot();
        let mut ours: Vec<(i32, u16)> = snap.keys().flat_map(|&pid| listening(pid, 256).into_iter().map(move |l| (pid, l.port))).collect();
        let out = Command::new("lsof").args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pn"]).output().unwrap();
        let mut theirs = vec![];
        let mut pid = 0;
        for l in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(p) = l.strip_prefix('p') { pid = p.parse().unwrap(); }
            if let Some(n) = l.strip_prefix('n') { theirs.push((pid, n.rsplit(':').next().unwrap().parse::<u16>().unwrap())); }
        }
        ours.sort(); ours.dedup(); theirs.sort(); theirs.dedup();
        // a listener may open or close between the two reads
        let diff: Vec<_> = theirs.iter().filter(|x| !ours.contains(x)).chain(ours.iter().filter(|x| !theirs.contains(x))).collect();
        assert!(diff.len() <= 2, "differs from lsof: {diff:?}\nours {ours:?}\nlsof {theirs:?}");
    }
}

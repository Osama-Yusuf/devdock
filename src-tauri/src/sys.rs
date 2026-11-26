//! The whole Mac, like Activity Monitor: CPU load, Memory Used, the startup disk, and the
//! byte counters of a network interface. Kernel calls only; nothing is spawned.
#![allow(deprecated)] // libc points mach calls at the mach2 crate; these are the same calls
use std::ffi::CString;
use std::mem::{size_of, zeroed};

/// Busy and total CPU ticks over all cores since boot
#[derive(Debug, Clone, Copy, Default)]
pub struct CpuTicks { pub busy: u64, pub all: u64 }

pub fn cpu_ticks() -> Option<CpuTicks> {
    let mut info: libc::host_cpu_load_info = unsafe { zeroed() };
    let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
    let r = unsafe { libc::host_statistics(libc::mach_host_self(), libc::HOST_CPU_LOAD_INFO, &mut info as *mut _ as *mut i32, &mut count) };
    if r != 0 { return None; }
    let t = |i: i32| info.cpu_ticks[i as usize] as u64;
    let busy = t(libc::CPU_STATE_USER) + t(libc::CPU_STATE_SYSTEM) + t(libc::CPU_STATE_NICE);
    Some(CpuTicks { busy, all: busy + t(libc::CPU_STATE_IDLE) })
}

/// Busy share of all cores between two readings, in percent (one decimal)
pub fn cpu_percent(prev: CpuTicks, cur: CpuTicks) -> Option<f64> {
    (cur.all > prev.all).then(|| ((cur.busy - prev.busy) as f64 / (cur.all - prev.all) as f64 * 1000.0).round() / 10.0)
}

fn sysctl_u64(name: &str) -> Option<u64> {
    let c = CString::new(name).ok()?;
    let mut buf = [0u8; 8];
    let mut len = buf.len();
    let r = unsafe { libc::sysctlbyname(c.as_ptr(), buf.as_mut_ptr() as *mut _, &mut len, std::ptr::null_mut(), 0) };
    if r != 0 { return None; }
    Some(match len { 4 => u32::from_ne_bytes(buf[..4].try_into().ok()?) as u64, 8 => u64::from_ne_bytes(buf), _ => return None })
}

pub fn total_memory() -> u64 { sysctl_u64("hw.memsize").unwrap_or(0) }

pub fn cores() -> u64 { sysctl_u64("hw.logicalcpu").unwrap_or(1) }

/// Activity Monitor's "Memory Used" in MB: app memory (anonymous minus purgeable) + wired + compressed.
/// Cached files aren't in it: macOS hands that memory back the moment an app asks.
pub fn memory_used_mb() -> Option<f64> {
    let mut vm: libc::vm_statistics64 = unsafe { zeroed() };
    let mut count = (size_of::<libc::vm_statistics64>() / size_of::<libc::integer_t>()) as u32;
    let r = unsafe { libc::host_statistics64(libc::mach_host_self(), libc::HOST_VM_INFO64, &mut vm as *mut _ as *mut i32, &mut count) };
    if r != 0 { return None; }
    let page = sysctl_u64("hw.pagesize")?;
    let internal = sysctl_u64("vm.page_pageable_internal_count")?;
    let purgeable = sysctl_u64("vm.page_purgeable_count")?;
    let pages = internal.saturating_sub(purgeable) + vm.wire_count as u64 + vm.compressor_page_count as u64;
    let mb = (pages * page) as f64 / 1048576.0;
    (mb > 0.0).then_some(mb)
}

/// Startup disk in MB. APFS volumes share one container, so / reports the container's space.
pub fn disk(path: &str) -> Option<(f64, f64)> {
    let c = CString::new(path).ok()?;
    let mut s: libc::statfs = unsafe { zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 { return None; }
    let b = s.f_bsize as f64 / 1048576.0;
    Some((s.f_blocks as f64 * b, s.f_bavail as f64 * b))
}

/// Bytes in and out of one interface since boot, from the interface MIB as `netstat -ib` reads it.
/// (NET_RT_IFLIST2 hands unprivileged readers counters wrapped at 32 bits.)
pub fn iface_bytes(name: &str) -> Option<(u64, u64)> {
    #[repr(C)]
    struct IfMibData {
        name: [libc::c_char; libc::IFNAMSIZ],
        pcount: i32, flags: i32, snd_len: i32, snd_maxlen: i32, snd_drops: i32, filler: [i32; 4],
        data: libc::if_data64,
    }
    const NETLINK_GENERIC: i32 = 0;
    const IFMIB_IFDATA: i32 = 2;
    const IFDATA_GENERAL: i32 = 1;
    let cname = CString::new(name).ok()?;
    let index = unsafe { libc::if_nametoindex(cname.as_ptr()) };
    if index == 0 { return None; }
    let mut mib = [libc::CTL_NET, libc::PF_LINK, NETLINK_GENERIC, IFMIB_IFDATA, index as i32, IFDATA_GENERAL];
    let mut d: IfMibData = unsafe { zeroed() };
    let mut len = size_of::<IfMibData>();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 6, &mut d as *mut _ as *mut _, &mut len, std::ptr::null_mut(), 0) } != 0 { return None; }
    let data = d.data;
    Some((data.ifi_ibytes, data.ifi_obytes))
}

/// IPv4 addresses of the interfaces that are up, not loopback: (interface, address)
pub fn ipv4_addrs() -> Vec<(String, String)> {
    let mut out = vec![];
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 { return out; }
    let mut cur = head;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        cur = a.ifa_next;
        if a.ifa_addr.is_null() || a.ifa_flags & libc::IFF_LOOPBACK as u32 != 0 || a.ifa_flags & libc::IFF_UP as u32 == 0 { continue; }
        if unsafe { (*a.ifa_addr).sa_family } as i32 != libc::AF_INET { continue; }
        let sin = unsafe { &*(a.ifa_addr as *const libc::sockaddr_in) };
        let ip = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
        let name = unsafe { std::ffi::CStr::from_ptr(a.ifa_name) }.to_string_lossy().into_owned();
        out.push((name, ip.to_string()));
    }
    unsafe { libc::freeifaddrs(head) };
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    fn sh(cmd: &str, args: &[&str]) -> String { String::from_utf8(Command::new(cmd).args(args).output().unwrap().stdout).unwrap() }

    #[test]
    fn memory_matches_vm_stat() {
        // the formula the Node version used, from vm_stat and sysctl's text
        let st = sh("vm_stat", &[]);
        let page: f64 = sh("sysctl", &["-n", "hw.pagesize"]).trim().parse().unwrap();
        let get = |k: &str| -> f64 { st.lines().find(|l| l.starts_with(k)).unwrap().split(':').nth(1).unwrap().trim().trim_end_matches('.').parse().unwrap() };
        let n = |k: &str| -> f64 { sh("sysctl", &["-n", k]).trim().parse().unwrap() };
        let theirs = (n("vm.page_pageable_internal_count") - n("vm.page_purgeable_count") + get("Pages wired down") + get("Pages occupied by compressor")) * page / 1048576.0;
        let ours = memory_used_mb().unwrap();
        // memory moves between the two reads; within 2% is the same reading
        assert!((ours - theirs).abs() / theirs < 0.02, "ours {ours:.0} MB, vm_stat {theirs:.0} MB");
    }

    #[test]
    fn cpu_moves_and_stays_in_range() {
        let a = cpu_ticks().unwrap();
        let t = std::time::Instant::now();
        let mut x = 0u64;
        while t.elapsed().as_millis() < 300 { x = x.wrapping_add(1); }
        assert!(x > 0);
        let b = cpu_ticks().unwrap();
        let p = cpu_percent(a, b).unwrap();
        assert!(p > 0.0 && p <= 100.0, "{p}");
        // one core of N spinning is at least 1/N of the machine, minus scheduling noise
        assert!(p >= 100.0 / cores() as f64 * 0.5, "{p}% with {} cores", cores());
    }

    #[test]
    fn disk_matches_df() {
        let (total, free) = disk("/").unwrap();
        let row: Vec<f64> = sh("df", &["-k", "/"]).lines().nth(1).unwrap().split_whitespace().skip(1).take(3).map(|v| v.parse().unwrap()).collect();
        assert!((total - row[0] / 1024.0).abs() < 1.0, "total {total} vs df {}", row[0] / 1024.0);
        assert!((free - row[2] / 1024.0).abs() < 64.0, "free {free} vs df {}", row[2] / 1024.0);
    }

    #[test]
    fn interface_bytes_match_netstat() {
        let iface = sh("route", &["-n", "get", "default"]).lines().find_map(|l| l.trim().strip_prefix("interface:").map(|s| s.trim().to_string()));
        let Some(iface) = iface else { return }; // offline
        let (rx, tx) = iface_bytes(&iface).unwrap();
        let row: Vec<String> = sh("netstat", &["-ibn", "-I", &iface]).lines().find(|l| l.contains("<Link#")).unwrap().split_whitespace().map(String::from).collect();
        let (nrx, ntx): (u64, u64) = (row[row.len() - 5].parse().unwrap(), row[row.len() - 2].parse().unwrap());
        // traffic between the two reads: a few MB at most
        // read first, so netstat may be a little ahead; 64-bit, so never off by 4 GB wraps
        assert!(nrx >= rx && nrx - rx < 50 << 20, "rx {rx} vs netstat {nrx}");
        assert!(ntx >= tx && ntx - tx < 50 << 20, "tx {tx} vs netstat {ntx}");
    }

    #[test]
    fn addresses_include_the_default_interface() {
        let addrs = ipv4_addrs();
        assert!(!addrs.iter().any(|(n, _)| n == "lo0"));
        let iface = sh("route", &["-n", "get", "default"]).lines().find_map(|l| l.trim().strip_prefix("interface:").map(|s| s.trim().to_string()));
        if let Some(i) = iface { if !i.starts_with("utun") { assert!(addrs.iter().any(|(n, _)| *n == i), "{addrs:?} has no {i}"); } }
    }
}

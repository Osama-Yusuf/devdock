package main

// Linux: everything from /proc and /sys, no commands run.

import (
	"bufio"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const clkTck = 100 // USER_HZ, 100 on every Linux distro we target

func readFile(p string) string {
	b, _ := os.ReadFile(p)
	return strings.TrimSpace(string(b))
}

func kv(path, sep string) map[string]string {
	m := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), sep); ok {
			m[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return m
}

func hostInfo() *Host {
	h := baseHost()
	rel := kv("/etc/os-release", "=")
	h.Distro, h.DistroID = rel["PRETTY_NAME"], rel["ID"]
	h.Kernel = readFile("/proc/sys/kernel/osrelease")
	cpu := kv("/proc/cpuinfo", ":")
	h.CPUModel = cpu["model name"]
	if h.CPUModel == "" {
		h.CPUModel = cpu["Model"] // Raspberry Pi and other ARM boards
	}
	if m, err := memory(); err == nil {
		h.MemTotal = m.Total
	}
	for _, l := range strings.Split(readFile("/proc/stat"), "\n") {
		if v, ok := strings.CutPrefix(l, "btime "); ok {
			h.BootTime, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	h.Model = strings.TrimSpace(readFile("/sys/class/dmi/id/sys_vendor") + " " + readFile("/sys/class/dmi/id/product_name"))
	if h.Model == "" {
		h.Model = strings.TrimRight(readFile("/proc/device-tree/model"), "\x00")
	}
	h.Virt = virt(cpu["flags"], h.Model)
	h.MachineID = machineID(readFile("/etc/machine-id"))
	return h
}

func virt(flags, model string) string {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "container"
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return "container"
	}
	// systemd writes this for any container; /proc/1/environ is readable only as root
	if readFile("/run/systemd/container") != "" || strings.Contains(readFile("/proc/1/environ"), "container=") {
		return "container"
	}
	if dt := readFile("/sys/firmware/devicetree/base/compatible"); strings.Contains(dt, "dummy-virt") || strings.Contains(dt, ",virt") { // arm64 VMs: QEMU, OrbStack
		return "vm"
	}
	cg := readFile("/proc/1/cgroup")
	for _, k := range []string{"docker", "lxc", "kubepods", "containerd"} {
		if strings.Contains(cg, k) {
			return "container"
		}
	}
	m := strings.ToLower(model)
	for _, k := range []string{"kvm", "qemu", "vmware", "virtualbox", "hyper-v", "parallels", "xen", "bochs", "orbstack"} {
		if strings.Contains(m, k) {
			return "vm"
		}
	}
	if strings.Contains(" "+flags+" ", " hypervisor ") {
		return "vm"
	}
	return "bare"
}

func (c *Collector) cpu(secs float64) (*CPU, error) {
	f := strings.Fields(strings.SplitN(readFile("/proc/stat"), "\n", 2)[0])
	if len(f) < 5 || f[0] != "cpu" {
		return nil, fmt.Errorf("unexpected /proc/stat")
	}
	var total, idle uint64
	for i, v := range f[1:] {
		n, _ := strconv.ParseUint(v, 10, 64)
		if i < 8 { // user nice system idle iowait irq softirq steal; guest is already in user
			total += n
		}
		if i == 3 || i == 4 {
			idle += n
		}
	}
	busy := total - idle
	out := &CPU{}
	if secs > 0 && total > c.prevCPU[1] {
		out.Usage = float64(busy-c.prevCPU[0]) / float64(total-c.prevCPU[1]) * 100
	}
	c.prevCPU = [2]uint64{busy, total}
	l := strings.Fields(readFile("/proc/loadavg"))
	for i := 0; i < 3 && i < len(l); i++ {
		out.Load[i], _ = strconv.ParseFloat(l[i], 64)
	}
	return out, nil
}

func memory() (*Mem, error) {
	m := kv("/proc/meminfo", ":")
	kb := func(k string) uint64 {
		n, _ := strconv.ParseUint(strings.TrimSuffix(m[k], " kB"), 10, 64)
		return n * 1024
	}
	if kb("MemTotal") == 0 {
		return nil, fmt.Errorf("no /proc/meminfo")
	}
	out := &Mem{Total: kb("MemTotal"), Available: kb("MemAvailable"), SwapTotal: kb("SwapTotal")}
	out.Used = out.Total - out.Available
	out.SwapUsed = out.SwapTotal - kb("SwapFree")
	return out, nil
}

var realFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "f2fs": true,
	"vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "fuseblk": true, "bcachefs": true, "nfs": true, "nfs4": true, "cifs": true}

func disks() ([]Disk, error) {
	f, err := os.Open("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Disk
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Fields(sc.Text())
		if len(p) < 3 || !realFS[p[2]] || seen[p[0]] {
			continue
		}
		var st syscall.Statfs_t
		if syscall.Statfs(p[1], &st) != nil || st.Blocks == 0 {
			continue
		}
		seen[p[0]] = true
		bs := uint64(st.Bsize)
		out = append(out, Disk{Mount: p[1], FS: p[2], Total: st.Blocks * bs, Used: (st.Blocks - st.Bfree) * bs})
	}
	return out, nil
}

// virtual links that would double-count traffic
func skipIface(n string) bool {
	if n == "lo" {
		return true
	}
	for _, p := range []string{"veth", "br-", "docker", "virbr", "cni", "flannel", "cali", "vxlan"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

func (c *Collector) network(secs float64) ([]Iface, error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Iface
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		name = strings.TrimSpace(name)
		if !ok || skipIface(name) {
			continue
		}
		v := strings.Fields(rest)
		if len(v) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(v[0], 10, 64)
		tx, _ := strconv.ParseUint(v[8], 10, 64)
		prev := c.prevNet[name]
		c.prevNet[name] = [2]uint64{rx, tx}
		out = append(out, Iface{Name: name, RX: rate(rx, prev[0], secs), TX: rate(tx, prev[1], secs), Addrs: addrsOf(name)})
	}
	return out, nil
}

var userCache = map[string]string{}

func userName(uid string) string {
	if n, ok := userCache[uid]; ok {
		return n
	}
	n := uid
	if u, err := user.LookupId(uid); err == nil {
		n = u.Username
	}
	userCache[uid] = n
	return n
}

func (c *Collector) processes(secs float64) ([]Proc, error) {
	dirs, err := filepath.Glob("/proc/[0-9]*")
	if err != nil {
		return nil, err
	}
	page := uint64(os.Getpagesize())
	seen := map[int]uint64{}
	var list []Proc
	for _, d := range dirs {
		pid, _ := strconv.Atoi(filepath.Base(d))
		stat := readFile(d + "/stat")
		// the name is in parentheses and may contain spaces or parentheses itself
		open, close := strings.IndexByte(stat, '('), strings.LastIndexByte(stat, ')')
		if open < 0 || close < open {
			continue
		}
		f := strings.Fields(stat[close+1:])
		if len(f) < 22 {
			continue
		}
		ut, _ := strconv.ParseUint(f[11], 10, 64)
		st, _ := strconv.ParseUint(f[12], 10, 64)
		rss, _ := strconv.ParseUint(f[21], 10, 64)
		ticks := ut + st
		seen[pid] = ticks
		cpu := 0.0
		if prev, ok := c.prevProc[pid]; ok && secs > 0 && ticks >= prev {
			cpu = float64(ticks-prev) / clkTck / secs * 100
		}
		uid := ""
		if u := kv(d+"/status", ":")["Uid"]; u != "" {
			uid = strings.Fields(u)[0]
		}
		list = append(list, Proc{PID: pid, Name: stat[open+1 : close], User: userName(uid), CPU: cpu, Mem: rss * page})
	}
	c.prevProc = seen
	return topProcs(list, 20), nil
}

// Listening TCP ports from /proc/net/tcp{,6}; the owning process only when its file
// descriptors are readable (the agent's own user, unless it runs with more rights).
func ports() ([]Port, error) {
	inodes := map[string]int{} // socket inode -> port
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		lines := strings.Split(readFile(f), "\n")
		for _, l := range lines[min(1, len(lines)):] {
			p := strings.Fields(l)
			if len(p) < 10 || p[3] != "0A" { // 0A = LISTEN
				continue
			}
			_, hexPort, _ := strings.Cut(p[1], ":")
			n, _ := strconv.ParseUint(hexPort, 16, 32)
			inodes[p[9]] = int(n)
		}
	}
	owner := map[int]Port{}
	fds, _ := filepath.Glob("/proc/[0-9]*/fd/*")
	for _, fd := range fds {
		l, err := os.Readlink(fd)
		if err != nil || !strings.HasPrefix(l, "socket:[") {
			continue
		}
		if port, ok := inodes[l[8:len(l)-1]]; ok {
			pid, _ := strconv.Atoi(strings.Split(fd, "/")[2])
			owner[port] = Port{Port: port, Proto: "tcp", PID: pid, Name: readFile(fmt.Sprintf("/proc/%d/comm", pid))}
		}
	}
	seen := map[int]bool{}
	var out []Port
	for _, port := range inodes {
		if seen[port] {
			continue
		}
		seen[port] = true
		if p, ok := owner[port]; ok {
			out = append(out, p)
		} else {
			out = append(out, Port{Port: port, Proto: "tcp"})
		}
	}
	return out, nil
}

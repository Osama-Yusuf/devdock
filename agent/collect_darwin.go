package main

// macOS: Go can't call host_statistics without cgo, so a few stock commands do the reading.
// Each is cheap (ps, sysctl, vm_stat, netstat, df, lsof) and runs only when the master asks.

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func cmd(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, name, args...).Output()
	return string(out)
}

func hostInfo() *Host {
	h := baseHost()
	h.DistroID = "macos"
	h.Distro = "macOS " + strings.TrimSpace(cmd("/usr/bin/sw_vers", "-productVersion"))
	v := strings.Split(cmd("/usr/sbin/sysctl", "-n", "kern.osrelease", "machdep.cpu.brand_string", "hw.memsize", "kern.boottime", "hw.model", "kern.hv_vmm_present"), "\n")
	get := func(i int) string {
		if i < len(v) {
			return strings.TrimSpace(v[i])
		}
		return ""
	}
	h.Kernel, h.CPUModel, h.Model = get(0), get(1), get(4)
	h.MemTotal, _ = strconv.ParseUint(get(2), 10, 64)
	if _, rest, ok := strings.Cut(get(3), "sec = "); ok { // "{ sec = 1700000000, usec = 0 } ..."
		h.BootTime, _ = strconv.ParseInt(strings.SplitN(rest, ",", 2)[0], 10, 64)
	}
	h.Virt = "bare"
	if get(5) == "1" {
		h.Virt = "vm"
	}
	id := ""
	for _, l := range strings.Split(cmd("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"), "\n") {
		if strings.Contains(l, "IOPlatformUUID") {
			id = strings.Trim(strings.TrimSpace(l[strings.LastIndex(l, "=")+1:]), `"`)
		}
	}
	h.MachineID = machineID(id)
	return h
}

func (c *Collector) cpu(secs float64) (*CPU, error) {
	out := &CPU{}
	var sum float64
	for _, l := range strings.Split(cmd("/bin/ps", "-A", "-o", "%cpu="), "\n") {
		n, _ := strconv.ParseFloat(strings.TrimSpace(l), 64)
		sum += n
	}
	if c.host != nil && c.host.Cores > 0 {
		out.Usage = min(100, sum/float64(c.host.Cores))
	}
	l := strings.Fields(strings.Trim(strings.TrimSpace(cmd("/usr/sbin/sysctl", "-n", "vm.loadavg")), "{}"))
	for i := 0; i < 3 && i < len(l); i++ {
		out.Load[i], _ = strconv.ParseFloat(l[i], 64)
	}
	return out, nil
}

func memory() (*Mem, error) {
	vm := cmd("/usr/bin/vm_stat")
	page := uint64(16384)
	if _, rest, ok := strings.Cut(vm, "page size of "); ok {
		page, _ = strconv.ParseUint(strings.Fields(rest)[0], 10, 64)
	}
	pages := map[string]uint64{}
	for _, l := range strings.Split(vm, "\n") {
		if k, v, ok := strings.Cut(l, ":"); ok {
			pages[k], _ = strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(v), "."), 10, 64)
		}
	}
	total, _ := strconv.ParseUint(strings.TrimSpace(cmd("/usr/sbin/sysctl", "-n", "hw.memsize")), 10, 64)
	// what Activity Monitor calls "Memory Used": app memory, wired, compressed
	used := (pages["Pages active"] + pages["Pages wired down"] + pages["Pages occupied by compressor"]) * page
	out := &Mem{Total: total, Used: min(used, total)}
	out.Available = total - out.Used
	sw := cmd("/usr/sbin/sysctl", "-n", "vm.swapusage") // "total = 2048.00M  used = 1024.50M  free = ..."
	mb := func(k string) uint64 {
		if _, rest, ok := strings.Cut(sw, k+" = "); ok {
			n, _ := strconv.ParseFloat(strings.TrimSuffix(strings.Fields(rest)[0], "M"), 64)
			return uint64(n * 1024 * 1024)
		}
		return 0
	}
	out.SwapTotal, out.SwapUsed = mb("total"), mb("used")
	return out, nil
}

// APFS volumes share their container's space: "/" reports used as total minus free,
// which matches Finder; external drives under /Volumes are listed as they are.
func disks() ([]Disk, error) {
	var out []Disk
	for _, l := range strings.Split(cmd("/bin/df", "-kPl"), "\n") {
		f := strings.Fields(l)
		if len(f) < 6 || !strings.HasPrefix(f[0], "/dev/disk") {
			continue
		}
		mount := strings.Join(f[5:], " ")
		if mount != "/" && !strings.HasPrefix(mount, "/Volumes/") || mount == "/Volumes/Recovery" || strings.HasPrefix(mount, "/Volumes/dmg.") {
			continue
		}
		total, _ := strconv.ParseUint(f[1], 10, 64)
		if mount != "/" && total < 4<<20 { // ponytail: under 4 GB is an installer or disk image, not a drive
			continue
		}
		avail, _ := strconv.ParseUint(f[3], 10, 64)
		out = append(out, Disk{Mount: mount, FS: "apfs", Total: total * 1024, Used: (total - min(avail, total)) * 1024})
	}
	return out, nil
}

func (c *Collector) network(secs float64) ([]Iface, error) {
	var out []Iface
	for _, l := range strings.Split(cmd("/usr/sbin/netstat", "-ibn"), "\n") {
		f := strings.Fields(l)
		if len(f) < 10 || !strings.HasPrefix(f[2], "<Link#") || !strings.HasPrefix(f[0], "en") {
			continue
		}
		name := strings.TrimSuffix(f[0], "*")
		// count from the end: the address column may be empty
		rx, _ := strconv.ParseUint(f[len(f)-5], 10, 64)
		tx, _ := strconv.ParseUint(f[len(f)-2], 10, 64)
		if rx == 0 && tx == 0 {
			continue
		}
		prev := c.prevNet[name]
		c.prevNet[name] = [2]uint64{rx, tx}
		out = append(out, Iface{Name: name, RX: rate(rx, prev[0], secs), TX: rate(tx, prev[1], secs), Addrs: addrsOf(name)})
	}
	return out, nil
}

func (c *Collector) processes(secs float64) ([]Proc, error) {
	var list []Proc
	for _, l := range strings.Split(cmd("/bin/ps", "-Ao", "pid=,user=,%cpu=,rss=,comm="), "\n") {
		f := strings.Fields(l)
		if len(f) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		cpu, _ := strconv.ParseFloat(f[2], 64)
		rss, _ := strconv.ParseUint(f[3], 10, 64)
		list = append(list, Proc{PID: pid, User: f[1], CPU: cpu, Mem: rss * 1024, Name: filepath.Base(strings.Join(f[4:], " "))})
	}
	return topProcs(list, 20), nil
}

func ports() ([]Port, error) {
	var out []Port
	seen := map[int]bool{}
	var pid int
	var name string
	for _, l := range strings.Split(cmd("/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"), "\n") {
		if l == "" {
			continue
		}
		switch l[0] {
		case 'p':
			pid, _ = strconv.Atoi(l[1:])
		case 'c':
			name = l[1:]
		case 'n':
			port, _ := strconv.Atoi(l[strings.LastIndex(l, ":")+1:])
			if port > 0 && !seen[port] {
				seen[port] = true
				out = append(out, Port{Port: port, Proto: "tcp", PID: pid, Name: name})
			}
		}
	}
	return out, nil
}

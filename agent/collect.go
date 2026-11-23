package main

// What a snapshot holds. Nothing runs in the background: rates (CPU %, network speed) come
// from the difference with the previous request, so an agent nobody asks costs nothing.

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"runtime"
	"sort"
	"sync"
	"time"
)

type Host struct {
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`       // linux, darwin
	Distro    string `json:"distro"`   // "Ubuntu 24.04.1 LTS", "macOS 15.2"
	DistroID  string `json:"distroId"` // ubuntu, debian, fedora, alpine, arch, macos
	Kernel    string `json:"kernel"`
	Arch      string `json:"arch"`
	CPUModel  string `json:"cpuModel"`
	Cores     int    `json:"cores"`
	MemTotal  uint64 `json:"memTotal"`
	BootTime  int64  `json:"bootTime"`  // unix seconds
	Virt      string `json:"virt"`      // bare, vm, container
	Model     string `json:"model"`     // hardware model when known
	MachineID string `json:"machineId"` // salted hash: tells machines apart without exposing the id
}

type CPU struct {
	Usage float64    `json:"usage"` // % of all cores
	Load  [3]float64 `json:"load"`
}

type Mem struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	SwapTotal uint64 `json:"swapTotal"`
	SwapUsed  uint64 `json:"swapUsed"`
}

type Disk struct {
	Mount string `json:"mount"`
	FS    string `json:"fs"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

type Iface struct {
	Name  string   `json:"name"`
	RX    float64  `json:"rx"` // bytes/s
	TX    float64  `json:"tx"`
	Addrs []string `json:"addrs"`
}

type Proc struct {
	PID  int     `json:"pid"`
	Name string  `json:"name"`
	User string  `json:"user"`
	CPU  float64 `json:"cpu"` // % of one core
	Mem  uint64  `json:"mem"` // bytes resident
}

type Port struct {
	Port  int    `json:"port"`
	Proto string `json:"proto"`
	PID   int    `json:"pid,omitempty"`
	Name  string `json:"name,omitempty"`
}

type Snapshot struct {
	Version    string      `json:"version"`
	At         int64       `json:"at"`
	Uptime     int64       `json:"uptime"`
	Scope      Scope       `json:"scope"`
	Host       *Host       `json:"host,omitempty"`
	CPU        *CPU        `json:"cpu,omitempty"`
	Mem        *Mem        `json:"mem,omitempty"`
	Disks      []Disk      `json:"disks,omitempty"`
	Net        []Iface     `json:"net,omitempty"`
	Processes  []Proc      `json:"processes,omitempty"`
	Ports      []Port      `json:"ports,omitempty"`
	Containers []Container `json:"containers,omitempty"`
	Errors     []string    `json:"errors,omitempty"` // what couldn't be read, for doctor and the master
}

type Collector struct {
	mu       sync.Mutex
	prevAt   time.Time
	prevCPU  [2]uint64 // busy, total ticks (linux)
	prevNet  map[string][2]uint64
	prevProc map[int]uint64 // pid -> cpu ticks
	host     *Host
	docker   *Docker
}

func NewCollector() *Collector {
	return &Collector{prevNet: map[string][2]uint64{}, prevProc: map[int]uint64{}, docker: NewDocker()}
}

func (c *Collector) Snapshot(s Scope) *Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	secs := now.Sub(c.prevAt).Seconds()
	if c.prevAt.IsZero() || secs <= 0 {
		secs = 0 // first call: no rates yet
	}
	snap := &Snapshot{Version: version, At: now.Unix(), Scope: s}
	fail := func(what string, err error) {
		if err != nil {
			snap.Errors = append(snap.Errors, what+": "+err.Error())
		}
	}
	if s.System {
		if c.host == nil {
			c.host = hostInfo()
		}
		snap.Host = c.host
		snap.Uptime = now.Unix() - c.host.BootTime
		var err error
		snap.CPU, err = c.cpu(secs)
		fail("cpu", err)
		snap.Mem, err = memory()
		fail("memory", err)
		snap.Disks, err = disks()
		fail("disks", err)
		snap.Net, err = c.network(secs)
		fail("network", err)
	}
	if s.Processes {
		var err error
		snap.Processes, err = c.processes(secs)
		fail("processes", err)
	}
	if s.Ports {
		var err error
		snap.Ports, err = ports()
		fail("ports", err)
	}
	if s.Containers {
		var err error
		snap.Containers, err = c.docker.Containers()
		fail("containers", err)
	}
	c.prevAt = now
	return snap
}

// rate turns two counter readings into a per-second value; counters that reset read as 0
func rate(cur, prev uint64, secs float64) float64 {
	if secs <= 0 || cur < prev {
		return 0
	}
	return float64(cur-prev) / secs
}

func topProcs(list []Proc, n int) []Proc {
	sort.Slice(list, func(i, j int) bool {
		if list[i].CPU != list[j].CPU {
			return list[i].CPU > list[j].CPU
		}
		return list[i].Mem > list[j].Mem
	})
	if len(list) > n {
		list = list[:n]
	}
	return list
}

// machineID hashes the OS's stable id with a fixed salt: the master can tell two machines
// apart (or spot a reinstall) without learning the raw id.
func machineID(raw string) string {
	if raw == "" {
		raw, _ = os.Hostname()
	}
	h := sha256.Sum256([]byte("devdock-machine-v1|" + raw))
	return hex.EncodeToString(h[:8])
}

func baseHost() *Host {
	h, _ := os.Hostname()
	return &Host{Hostname: h, OS: runtime.GOOS, Arch: runtime.GOARCH, Cores: runtime.NumCPU()}
}

func addrsOf(name string) []string {
	i, err := net.InterfaceByName(name)
	if err != nil {
		return nil
	}
	a, _ := i.Addrs()
	out := []string{}
	for _, x := range a {
		out = append(out, x.String())
	}
	return out
}

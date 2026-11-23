package main

// Docker containers over the Engine API's unix socket. Reads are GET (listing, stats);
// the only writes are start, stop and restart, and only with a signed action. Socket access is root-equivalent on most hosts, which is why the
// Containers scope is off unless the user ticks it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Container struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Image   string  `json:"image"`
	State   string  `json:"state"`
	Status  string  `json:"status"`
	Created int64   `json:"created"`
	Project string  `json:"project,omitempty"`
	Service string  `json:"service,omitempty"`
	Dir     string  `json:"dir,omitempty"` // where `docker compose up` ran, for updating the stack over SSH
	CPU     float64 `json:"cpu"` // % of one core
	Mem     uint64  `json:"mem"`
	Limit   uint64  `json:"limit"`
	RX      float64 `json:"rx"`
	TX      float64 `json:"tx"`
}

type Docker struct {
	client *http.Client
	sock   string
	prev   map[string][4]uint64 // id -> cpu, system cpu, rx, tx
	prevAt map[string]time.Time
}

func NewDocker() *Docker {
	return &Docker{prev: map[string][4]uint64{}, prevAt: map[string]time.Time{}}
}

func dockerSockets() []string {
	list := []string{}
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		list = append(list, strings.TrimPrefix(h, "unix://"))
	}
	list = append(list, "/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock")
	if home, err := os.UserHomeDir(); err == nil {
		list = append(list, filepath.Join(home, ".orbstack/run/docker.sock"), filepath.Join(home, ".docker/run/docker.sock"), filepath.Join(home, ".colima/default/docker.sock"))
	}
	return list
}

func (d *Docker) connect() error {
	if d.client != nil {
		return nil
	}
	for _, s := range dockerSockets() {
		if _, err := os.Stat(s); err == nil {
			sock := s
			d.sock = s
			d.client = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", sock)
				},
			}}
			return nil
		}
	}
	return errors.New("no Docker socket found")
}

func (d *Docker) get(path string, v any) error {
	r, err := d.client.Get("http://docker" + path)
	if err != nil {
		d.client = nil // socket moved or daemon restarted: look again next time
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("docker answered %d", r.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v)
}

// post: the only writes, used by signed actions (start, stop, restart)
func (d *Docker) post(path string) error {
	if err := d.connect(); err != nil {
		return err
	}
	c := *d.client
	c.Timeout = 30 * time.Second // stop waits up to 10 s for the container to exit
	r, err := c.Post("http://docker"+path, "application/json", nil)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode >= 300 && r.StatusCode != 304 { // 304: already in that state
		return fmt.Errorf("docker answered %d", r.StatusCode)
	}
	return nil
}

func (d *Docker) Containers() ([]Container, error) {
	if err := d.connect(); err != nil {
		return nil, err
	}
	var list []struct {
		Id, Image, State, Status string
		Names                    []string
		Created                  int64
		Labels                   map[string]string
	}
	if err := d.get("/containers/json?all=1", &list); err != nil {
		return nil, err
	}
	out := make([]Container, len(list))
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i, c := range list {
		name := c.Id[:12]
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out[i] = Container{ID: c.Id, Name: name, Image: c.Image, State: c.State, Status: c.Status, Created: c.Created,
			Project: c.Labels["com.docker.compose.project"], Service: c.Labels["com.docker.compose.service"], Dir: c.Labels["com.docker.compose.project.working_dir"]}
		if c.State != "running" || c.Labels["io.kubernetes.docker.type"] == "podsandbox" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			var s struct {
				CPUStats struct {
					CPUUsage struct {
						TotalUsage uint64 `json:"total_usage"`
					} `json:"cpu_usage"`
					SystemUsage uint64 `json:"system_cpu_usage"`
					OnlineCPUs  uint64 `json:"online_cpus"`
				} `json:"cpu_stats"`
				MemoryStats struct {
					Usage uint64            `json:"usage"`
					Limit uint64            `json:"limit"`
					Stats map[string]uint64 `json:"stats"`
				} `json:"memory_stats"`
				Networks map[string]struct {
					RX uint64 `json:"rx_bytes"`
					TX uint64 `json:"tx_bytes"`
				} `json:"networks"`
			}
			if d.get("/containers/"+id+"/stats?stream=false&one-shot=true", &s) != nil {
				return
			}
			var rx, tx uint64
			for _, n := range s.Networks {
				rx += n.RX
				tx += n.TX
			}
			cache := s.MemoryStats.Stats["inactive_file"]
			if cache == 0 {
				cache = s.MemoryStats.Stats["total_inactive_file"]
			}
			now := time.Now()
			mu.Lock()
			defer mu.Unlock()
			cur := [4]uint64{s.CPUStats.CPUUsage.TotalUsage, s.CPUStats.SystemUsage, rx, tx}
			prev, ok := d.prev[id]
			secs := now.Sub(d.prevAt[id]).Seconds()
			d.prev[id], d.prevAt[id] = cur, now
			c := &out[i]
			c.Mem, c.Limit = s.MemoryStats.Usage-min(cache, s.MemoryStats.Usage), s.MemoryStats.Limit
			if ok && cur[1] > prev[1] && cur[0] >= prev[0] {
				c.CPU = float64(cur[0]-prev[0]) / float64(cur[1]-prev[1]) * float64(max(1, s.CPUStats.OnlineCPUs)) * 100
				c.RX, c.TX = rate(rx, prev[2], secs), rate(tx, prev[3], secs)
			}
		}(i, c.Id)
	}
	wg.Wait()
	live := map[string]bool{}
	for _, c := range list {
		live[c.Id] = true
	}
	for id := range d.prev { // forget containers that are gone
		if !live[id] {
			delete(d.prev, id)
			delete(d.prevAt, id)
		}
	}
	return out, nil
}

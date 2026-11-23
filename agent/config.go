package main

// Two files, two owners:
//   config.json  root-owned, read-only to the agent: which master, what it may collect or do.
//                Only a local admin widens the scope; a compromised master or agent can't.
//   state dir    the agent's own: its TLS key and the one-time pairing token.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type Scope struct {
	System     bool `json:"system"`     // CPU, memory, disks, network, host details
	Processes  bool `json:"processes"`  // top processes by CPU and memory
	Ports      bool `json:"ports"`      // listening ports
	Containers bool `json:"containers"` // Docker containers and their usage (needs Docker socket access)
	Actions    bool `json:"actions"`    // stop processes and containers (milestone 2)
	Terminal   bool `json:"terminal"`   // open a shell or tmux session (milestone 2)
}

type Config struct {
	Listen   string `json:"listen"`    // ":7337"
	MasterFP string `json:"master_fp"` // SHA-256 of the master's certificate, hex
	Networks string `json:"networks"`  // "private" (LAN, Tailscale, link-local) or "any"
	Scope    Scope  `json:"scope"`
	// DevDock's Secure Enclave public key (base64 SPKI): every action must be signed by it
	ActionKey string `json:"action_key,omitempty"`
}

// Pairing state lives with the agent: the token is used once, then dropped.
type Pairing struct {
	Token   string    `json:"token,omitempty"`
	Expires time.Time `json:"expires,omitempty"`
	Paired  bool      `json:"paired"`
	At      time.Time `json:"at,omitempty"`
}

func RecommendedScope() Scope {
	return Scope{System: true, Processes: true, Ports: true, Containers: false}
}

type Paths struct{ Config, State, Bin string }

func defaultPaths() Paths {
	if runtime.GOOS == "darwin" {
		d := "/Library/Application Support/DevDock Agent"
		return Paths{Config: filepath.Join(d, "config.json"), State: filepath.Join(d, "state"), Bin: "/usr/local/bin/devdock-agent"}
	}
	return Paths{Config: "/etc/devdock-agent/config.json", State: "/var/lib/devdock-agent", Bin: "/usr/local/bin/devdock-agent"}
}

// DEVDOCK_AGENT_HOME runs everything from one folder, for tests and unprivileged trials
func paths() Paths {
	if h := os.Getenv("DEVDOCK_AGENT_HOME"); h != "" {
		return Paths{Config: filepath.Join(h, "config.json"), State: filepath.Join(h, "state"), Bin: filepath.Join(h, "devdock-agent")}
	}
	return defaultPaths()
}

func loadConfig(p string) (*Config, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	if len(c.MasterFP) != 64 {
		return nil, errors.New("config has no master fingerprint; reinstall with the command DevDock gives you")
	}
	if c.Listen == "" {
		c.Listen = ":7337"
	}
	if c.Networks == "" {
		c.Networks = "private"
	}
	return c, nil
}

func writeJSON(p string, v any, mode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	// a fresh random name: root never writes through a link the agent user planted
	f, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(b, '\n')); err == nil {
		err = f.Chmod(mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), p) // atomic: a crash never leaves half a file
}

func loadPairing(state string) *Pairing {
	p := &Pairing{}
	if b, err := os.ReadFile(filepath.Join(state, "pairing.json")); err == nil {
		_ = json.Unmarshal(b, p)
	}
	return p
}

func savePairing(state string, p *Pairing) error {
	return writeJSON(filepath.Join(state, "pairing.json"), p, 0o600)
}

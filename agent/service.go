package main

// Running as a service: systemd (most distros), OpenRC (Alpine), launchd (macOS).
// Linux gets its own unprivileged user and a locked-down unit; the service manager restarts
// the agent if it ever dies, which is the first layer of self-healing.

import (
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type svcUser struct {
	name     string
	uid, gid int
	docker   bool
	kill     bool // actions: may signal other users' processes (CAP_KILL, nothing more)
}

func serviceUser(s Scope) svcUser {
	u := svcUser{name: "devdock-agent", docker: s.Containers, kill: s.Actions}
	if isDarwin() {
		// a Mac's Docker socket lives in the user's home: run as the admin who installed it
		u.name = os.Getenv("SUDO_USER")
		if u.name == "" || u.name == "root" {
			u.name = "nobody"
		}
	}
	if x, err := user.Lookup(u.name); err == nil {
		u.uid, _ = strconv.Atoi(x.Uid)
		u.gid, _ = strconv.Atoi(x.Gid)
	}
	return u
}

func sh(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func has(bin string) bool { _, err := exec.LookPath(bin); return err == nil }

func ensureUser(u svcUser, s Scope) error {
	if isDarwin() {
		return nil
	}
	if _, err := user.Lookup(u.name); err != nil {
		var err error
		if has("useradd") {
			err = sh("useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--user-group", u.name)
		} else { // Alpine / BusyBox
			_ = sh("addgroup", "-S", u.name)
			err = sh("adduser", "-S", "-D", "-H", "-h", "/nonexistent", "-s", "/sbin/nologin", "-G", u.name, u.name)
		}
		if err != nil {
			return err
		}
	}
	if s.Containers {
		if _, err := user.LookupGroup("docker"); err == nil {
			if has("usermod") {
				_ = sh("usermod", "-aG", "docker", u.name)
			} else {
				_ = sh("addgroup", u.name, "docker")
			}
		}
	}
	return nil
}

func chown(p string, uid, gid int) { _ = os.Lchown(p, uid, gid) }

func chownR(dir string, uid, gid int) {
	// Lchown: the agent user owns this folder and could plant a link to /etc/sudoers;
	// root following it would hand that file over
	_ = filepath.Walk(dir, func(p string, _ os.FileInfo, err error) error {
		if err == nil {
			_ = os.Lchown(p, uid, gid)
		}
		return nil
	})
}

const systemdUnit = "/etc/systemd/system/devdock-agent.service"
const openrcScript = "/etc/init.d/devdock-agent"
const launchdPlist = "/Library/LaunchDaemons/dev.devdock.agent.plist"

func initSystem() string {
	switch {
	case isDarwin():
		return "launchd"
	case has("systemctl") && dirExists("/run/systemd/system"):
		return "systemd"
	case has("rc-service"):
		return "openrc"
	}
	return "none"
}

func dirExists(p string) bool { st, err := os.Stat(p); return err == nil && st.IsDir() }

// installService starts the agent and only reports success once it has stayed up
func installService(p Paths, u svcUser) error {
	if err := startService(p, u); err != nil {
		return err
	}
	for i := 0; i < 6; i++ {
		time.Sleep(500 * time.Millisecond)
		if !serviceRunning() {
			return fmt.Errorf("it started and then stopped: run `devdock-agent doctor` to see why")
		}
	}
	return nil
}

func startService(p Paths, u svcUser) error {
	switch initSystem() {
	case "systemd":
		groups, caps := "", ""
		if u.kill {
			caps = "CAP_KILL"
		}
		if u.docker {
			groups = "SupplementaryGroups=docker\n"
		}
		unit := fmt.Sprintf(`[Unit]
Description=DevDock agent
Documentation=https://github.com/Osama-Yusuf/devdock
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s run
User=%s
Group=%s
%sRestart=always
RestartSec=2
UMask=0077
# no privileges, no capabilities, almost no filesystem
NoNewPrivileges=yes
CapabilityBoundingSet=%s
AmbientCapabilities=%s
ProtectSystem=strict
ReadWritePaths=%s
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# a monitor must never become the problem
MemoryMax=64M
CPUQuota=25%%
TasksMax=64

[Install]
WantedBy=multi-user.target
`, p.Bin, u.name, u.name, groups, caps, caps, p.State)
		if err := os.WriteFile(systemdUnit, []byte(unit), 0o644); err != nil {
			return err
		}
		if err := sh("systemctl", "daemon-reload"); err != nil {
			return err
		}
		return sh("systemctl", "enable", "--now", "devdock-agent")
	case "openrc":
		log := "/var/log/devdock-agent.log"
		f, err := os.OpenFile(log, os.O_CREATE|os.O_WRONLY, 0o640)
		if err == nil {
			f.Close()
			chown(log, u.uid, u.gid)
		}
		script := fmt.Sprintf(`#!/sbin/openrc-run
name="devdock-agent"
description="DevDock agent"
command="%s"
command_args="run"
command_user="%s:%s"
supervisor="supervise-daemon"
%srespawn_delay=2
output_log="%s"
error_log="%s"

depend() {
	need net
}
`, p.Bin, u.name, u.name, map[bool]string{true: "capabilities=\"^cap_kill\"\n"}[u.kill], log, log)
		if err := os.WriteFile(openrcScript, []byte(script), 0o755); err != nil {
			return err
		}
		_ = sh("rc-update", "add", "devdock-agent", "default")
		return sh("rc-service", "devdock-agent", "restart")
	case "launchd":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.devdock.agent</string>
  <key>ProgramArguments</key><array><string>%s</string><string>run</string></array>
  <key>UserName</key><string>%s</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardErrorPath</key><string>/Library/Logs/devdock-agent.log</string>
</dict></plist>
`, p.Bin, u.name)
		_ = sh("launchctl", "bootout", "system/dev.devdock.agent")
		if err := os.WriteFile(launchdPlist, []byte(plist), 0o644); err != nil {
			return err
		}
		return sh("launchctl", "bootstrap", "system", launchdPlist)
	}
	return fmt.Errorf("no systemd, OpenRC or launchd here: run `devdock-agent run` under your own supervisor")
}

func restartService() error {
	switch initSystem() {
	case "systemd":
		return sh("systemctl", "restart", "devdock-agent")
	case "openrc":
		return sh("rc-service", "devdock-agent", "restart")
	case "launchd":
		return sh("launchctl", "kickstart", "-k", "system/dev.devdock.agent")
	}
	return fmt.Errorf("no service manager")
}

func serviceRunning() bool {
	switch initSystem() {
	case "systemd":
		return exec.Command("systemctl", "is-active", "--quiet", "devdock-agent").Run() == nil
	case "openrc":
		return exec.Command("rc-service", "devdock-agent", "status").Run() == nil
	case "launchd":
		out, _ := exec.Command("launchctl", "print", "system/dev.devdock.agent").Output()
		return strings.Contains(string(out), "state = running")
	}
	return false
}

func uninstall() error {
	if err := needRoot(); err != nil {
		return err
	}
	p := paths()
	switch initSystem() {
	case "systemd":
		_ = sh("systemctl", "disable", "--now", "devdock-agent")
		_ = os.Remove(systemdUnit)
		_ = sh("systemctl", "daemon-reload")
	case "openrc":
		_ = sh("rc-service", "devdock-agent", "stop")
		_ = sh("rc-update", "del", "devdock-agent", "default")
		_ = os.Remove(openrcScript)
	case "launchd":
		_ = sh("launchctl", "bootout", "system/dev.devdock.agent")
		_ = os.Remove(launchdPlist)
	}
	_ = os.RemoveAll(p.State)
	_ = os.RemoveAll(filepath.Dir(p.Config))
	if !isDarwin() {
		if has("userdel") {
			_ = sh("userdel", "devdock-agent")
		} else if has("deluser") {
			_ = sh("deluser", "devdock-agent")
		}
	}
	_ = os.Remove(p.Bin)
	fmt.Println("Removed devdock-agent, its service, config and keys. Remove the machine in DevDock too.")
	return nil
}

func pemDER(b []byte) []byte {
	if blk, _ := pem.Decode(b); blk != nil {
		return blk.Bytes
	}
	return nil
}

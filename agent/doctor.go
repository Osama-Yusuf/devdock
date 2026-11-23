package main

// doctor: is this agent set up the way it should be, and is it healthy right now?
// --fix repairs ownership, permissions and a stopped service; never the keys or the scope.

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func doctor(fix bool) int {
	p := paths()
	bad := 0
	ok := func(msg string) { fmt.Println("  ✓", msg) }
	warn := func(msg string) { fmt.Println("  !", msg) }
	fail := func(msg, hint string) {
		bad++
		fmt.Println("  ✗", msg)
		if hint != "" {
			fmt.Println("     →", hint)
		}
	}
	fmt.Printf("devdock-agent %s doctor\n", version)

	cfg, err := loadConfig(p.Config)
	if err != nil {
		fail("config: "+err.Error(), "reinstall with the command from DevDock")
		return 1
	}
	ok("config readable")
	u := serviceUser(cfg.Scope)
	if !isDarwin() {
		if _, err := user.Lookup(u.name); err == nil {
			ok("service user " + u.name)
		} else if fix && ensureUser(u, cfg.Scope) == nil {
			u = serviceUser(cfg.Scope)
			ok("service user " + u.name + " recreated")
		} else {
			fail("service user "+u.name+" is missing", "run `sudo devdock-agent doctor --fix`")
		}
	}

	// ownership: only root may change what's shared; only the agent may read its key
	checkMode := func(path string, want os.FileMode, uid, gid int, what string) {
		st, err := os.Lstat(path)
		if err != nil {
			fail(what+" missing: "+path, "")
			return
		}
		if !st.Mode().IsRegular() && !st.IsDir() { // never chmod or chown through a link
			fail(what+" isn't a plain file: "+path, "remove it, then run `sudo devdock-agent pair` again")
			return
		}
		sys := st.Sys().(*syscall.Stat_t)
		right := st.Mode().Perm()&^want == 0 && (uid < 0 || int(sys.Uid) == uid)
		if right {
			ok(fmt.Sprintf("%s permissions (%o)", what, st.Mode().Perm()))
			return
		}
		if fix {
			_ = os.Chmod(path, want)
			if uid >= 0 {
				_ = os.Chown(path, uid, gid)
			}
			ok(what + " permissions fixed")
			return
		}
		fail(fmt.Sprintf("%s is %o, owner %d", what, st.Mode().Perm(), sys.Uid), "run `sudo devdock-agent doctor --fix`")
	}
	root := 0
	if os.Getenv("DEVDOCK_AGENT_HOME") != "" {
		root = -1 // trial setup in a folder: ownership isn't ours to judge
	}
	checkMode(p.Config, 0o640, root, u.gid, "config")
	agentUID := u.uid
	if root < 0 {
		agentUID = -1
	}
	if fix && agentUID >= 0 {
		chownR(p.State, agentUID, u.gid) // everything in it belongs to the agent
	}
	checkMode(p.State, 0o700, agentUID, u.gid, "state folder")
	checkMode(filepath.Join(p.State, "key.pem"), 0o600, agentUID, u.gid, "private key")

	pr := loadPairing(p.State)
	switch {
	case pr.Paired:
		ok("paired with DevDock " + pr.At.Format("2006-01-02"))
	case pr.Token != "" && time.Now().Before(pr.Expires):
		warn("not paired yet; the pairing code is valid until " + pr.Expires.Format("15:04"))
	default:
		fail("not paired and the pairing code expired", "run `sudo devdock-agent pair` and paste the code in DevDock")
	}

	if cfg.Networks == "any" {
		warn("accepts connections from any network; `private` is safer unless you need it")
	}

	init := initSystem()
	if init != "none" {
		if serviceRunning() {
			ok("service running (" + init + ")")
		} else if fix {
			if err := restartService(); err != nil {
				fail("service won't start: "+err.Error(), "check its log")
			} else {
				ok("service restarted")
			}
		} else {
			fail("service not running", "run `sudo devdock-agent doctor --fix`")
		}
	}

	port := strings.TrimPrefix(cfg.Listen, ":")
	listening := false
	for i := 0; i < 8 && !listening; i++ { // a just-restarted service needs a moment to bind
		if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), time.Second); err == nil {
			c.Close()
			listening = true
		} else {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if listening {
		ok("listening on port " + port)
	} else {
		fail("nothing listening on port "+port, "is the service running? is the port taken?")
	}

	if cfg.Scope.Containers {
		found := false
		for _, s := range dockerSockets() {
			if _, err := os.Stat(s); err == nil {
				found = true
				if c, err := net.DialTimeout("unix", s, time.Second); err == nil {
					c.Close()
					ok("Docker socket " + s)
				} else {
					fail("can't open Docker socket "+s, "the service user needs the docker group")
				}
				break
			}
		}
		if !found {
			warn("Containers is shared but no Docker socket was found")
		}
	}

	if rss := agentRSS(); rss > 0 {
		msg := fmt.Sprintf("memory in use: %.1f MB", float64(rss)/1048576)
		if rss > 48<<20 {
			warn(msg + " (more than expected)")
		} else {
			ok(msg)
		}
	}

	if bad == 0 {
		fmt.Println("\nAll good.")
		return 0
	}
	fmt.Printf("\n%d problem(s).\n", bad)
	return 1
}

// agentRSS is the running service's resident memory, when we can find it
func agentRSS() int64 {
	switch initSystem() {
	case "systemd":
		out, _ := exec.Command("systemctl", "show", "-p", "MainPID", "--value", "devdock-agent").Output()
		pid := strings.TrimSpace(string(out))
		for _, l := range strings.Split(readText("/proc/"+pid+"/status"), "\n") {
			if v, ok := strings.CutPrefix(l, "VmRSS:"); ok {
				kb, _ := strconv.ParseInt(strings.Fields(v)[0], 10, 64)
				return kb * 1024
			}
		}
	case "launchd":
		out, _ := exec.Command("pgrep", "-f", "devdock-agent run").Output()
		if pid := strings.Fields(string(out)); len(pid) > 0 {
			rss, _ := exec.Command("ps", "-o", "rss=", "-p", pid[0]).Output()
			kb, _ := strconv.ParseInt(strings.TrimSpace(string(rss)), 10, 64)
			return kb * 1024
		}
	}
	return 0
}

func readText(p string) string { b, _ := os.ReadFile(p); return string(b) }

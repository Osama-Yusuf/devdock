// devdock-agent: a small, read-mostly exporter for DevDock. See README.md in this folder.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var version = "dev" // set at build: -ldflags "-X main.version=1.0.0"

const usage = `devdock-agent %s — DevDock's agent for your servers

  install    set up this machine (DevDock gives you the full command)
  status     what this agent shares, whether it's paired, and how to reach it
  doctor     check the setup; --fix repairs what it safely can
  pair       a new pairing code, to pair with DevDock again
  update     install a newer signed release
  uninstall  remove the agent, its service and its data
  run        start the agent (the service does this)
  version
`

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		fmt.Printf(usage, version)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "run":
		err = run()
	case "install":
		err = install(args)
	case "uninstall":
		err = uninstall()
	case "pair":
		err = repair()
	case "status":
		err = status()
	case "doctor":
		fix := len(args) > 0 && args[0] == "--fix"
		os.Exit(doctor(fix))
	case "update":
		err = update(args)
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		fmt.Printf(usage, version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "devdock-agent:", err)
		os.Exit(1)
	}
}

func run() error {
	p := paths()
	cfg, err := loadConfig(p.Config)
	if err != nil {
		return err
	}
	cert, err := loadOrCreateIdentity(p.State)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	a := &Agent{cfg: cfg, p: p, cert: cert, agentFP: fingerprint(cert.Certificate[0]), collect: NewCollector(), started: time.Now()}
	return a.Serve()
}

func needRoot() error {
	if os.Getenv("DEVDOCK_AGENT_HOME") == "" && os.Geteuid() != 0 {
		return fmt.Errorf("run this with sudo")
	}
	return nil
}

func parseScope(s string) (Scope, error) {
	if s == "" || s == "recommended" {
		return RecommendedScope(), nil
	}
	var sc Scope
	for _, k := range strings.Split(s, ",") {
		switch strings.TrimSpace(k) {
		case "system":
			sc.System = true
		case "processes":
			sc.Processes = true
		case "ports":
			sc.Ports = true
		case "containers":
			sc.Containers = true
		case "actions":
			sc.Actions = true
		case "terminal":
			sc.Terminal = true
		case "":
		default:
			return sc, fmt.Errorf("unknown scope %q (system, processes, ports, containers, actions, terminal)", k)
		}
	}
	return sc, nil
}

func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	masterFP := fs.String("master", "", "SHA-256 fingerprint of DevDock's key (from the install command)")
	token := fs.String("token", "", "one-time pairing token; prefer $DEVDOCK_TOKEN, which other users can't read")
	actionKey := fs.String("action-key", "", "DevDock's Touch ID key, needed for actions")
	scopeArg := fs.String("scope", "recommended", "what to share: system,processes,ports,containers")
	port := fs.Int("port", 7337, "port to listen on")
	networks := fs.String("networks", "private", "who may connect: private (LAN, Tailscale) or any")
	noService := fs.Bool("no-service", false, "write config only, don't install a service (containers, tests)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := needRoot(); err != nil {
		return err
	}
	if *token == "" {
		*token = os.Getenv("DEVDOCK_TOKEN")
	}
	if len(*masterFP) != 64 || len(*token) != 64 {
		return fmt.Errorf("--master and --token come from DevDock: Machines → Add machine")
	}
	if _, err := hex.DecodeString(*masterFP + *token); err != nil {
		return fmt.Errorf("--master and --token must be hex")
	}
	if *networks != "private" && *networks != "any" {
		return fmt.Errorf("--networks is private or any")
	}
	scope, err := parseScope(*scopeArg)
	if err != nil {
		return err
	}
	if scope.Terminal {
		return fmt.Errorf("the terminal arrives in a later version")
	}
	if scope.Actions {
		if _, err := parseActionKey(*actionKey); err != nil {
			return fmt.Errorf("actions need --action-key from DevDock: %v", err)
		}
	}
	p := paths()
	svcUser := serviceUser(scope)
	fmt.Println("Setting up devdock-agent", version)
	step := func(what string, err error) error {
		if err != nil {
			fmt.Printf("  ✗ %s: %v\n", what, err)
			return err
		}
		fmt.Printf("  ✓ %s\n", what)
		return nil
	}
	if !*noService {
		err := ensureUser(svcUser, scope)
		svcUser = serviceUser(scope) // the uid exists only now
		if err := step("service user "+svcUser.name, err); err != nil {
			return err
		}
	}
	if err := step("binary at "+p.Bin, copySelf(p.Bin)); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.Config), 0o755); err != nil {
		return err
	}
	cfg := &Config{Listen: ":" + strconv.Itoa(*port), MasterFP: strings.ToLower(*masterFP), Networks: *networks, Scope: scope, ActionKey: *actionKey}
	if err := step("config (only root can change what's shared)", writeJSON(p.Config, cfg, 0o640)); err != nil {
		return err
	}
	if err := os.MkdirAll(p.State, 0o700); err != nil {
		return err
	}
	cert, err := loadOrCreateIdentity(p.State)
	if err := step("this machine's key", err); err != nil {
		return err
	}
	if err := step("pairing code (valid 1 hour)", savePairing(p.State, &Pairing{Token: strings.ToLower(*token), Expires: time.Now().Add(time.Hour)})); err != nil {
		return err
	}
	if !*noService {
		chown(p.Config, 0, svcUser.gid)
		chownR(p.State, svcUser.uid, svcUser.gid)
		if err := step("service started", installService(p, svcUser)); err != nil {
			return err
		}
	}
	fmt.Printf("\nDone. DevDock will find this machine on port %d.\n\n  Agent key: %s\n\nDevDock will show a key too: pair only if the two match.\n", *port, keyCode(fingerprint(cert.Certificate[0])))
	return nil
}

func repair() error {
	if err := needRoot(); err != nil {
		return err
	}
	p := paths()
	cfg, err := loadConfig(p.Config)
	if err != nil {
		return err
	}
	t := newToken()
	if err := savePairing(p.State, &Pairing{Token: t, Expires: time.Now().Add(time.Hour)}); err != nil {
		return err
	}
	if u, err := user.Lookup(serviceUser(cfg.Scope).name); err == nil {
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		chown(filepath.Join(p.State, "pairing.json"), uid, gid)
	}
	fmt.Printf("Pairing code (1 hour): %s\nIn DevDock: Machines → this machine → Pair again, and paste it.\n", t)
	return nil
}

func status() error {
	p := paths()
	cfg, err := loadConfig(p.Config)
	if err != nil {
		return err
	}
	pr := loadPairing(p.State)
	fp := "(not created yet)"
	if c, err := os.ReadFile(filepath.Join(p.State, "cert.pem")); err == nil {
		if der := pemDER(c); der != nil {
			fp = keyCode(fingerprint(der))
		}
	}
	on := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}
	fmt.Printf("devdock-agent %s\n  paired:      %s\n  listening:   %s, from %s networks\n  agent key:   %s\n  master key:  %s…\n",
		version, on(pr.Paired), cfg.Listen, cfg.Networks, fp, cfg.MasterFP[:16])
	s := cfg.Scope
	fmt.Printf("  shares:      system %s, processes %s, ports %s, containers %s\n  can act:     actions %s, terminal %s\n",
		on(s.System), on(s.Processes), on(s.Ports), on(s.Containers), on(s.Actions), on(s.Terminal))
	return nil
}

func copySelf(dst string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, _ = filepath.EvalSymlinks(self); self == dst {
		return nil
	}
	src, err := os.Open(self)
	if err != nil {
		return err
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func fileSHA(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	_, _ = io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func isDarwin() bool { return runtime.GOOS == "darwin" }

package main

// Actions: anything that changes the machine. Being DevDock (mutual TLS) is not enough:
// each request also carries a signature from DevDock's Secure Enclave key, which needs
// Touch ID for every single use. So a stolen master key file, or malware on the Mac
// calling DevDock's API, still can't act without a finger on the sensor.
//
// Signed text: devdock-action-v1\n<agent fingerprint>\n<action>\n<target>\n<nonce>\n<expires unix>
// Bound to this agent, one action, one target, used once, valid at most 60 seconds.

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type ActionReq struct {
	Action  string `json:"action"`
	Target  string `json:"target"`
	Nonce   string `json:"nonce"`
	Expires int64  `json:"expires"`
	Sig     string `json:"sig"`
}

func actionMessage(agentFP string, r *ActionReq) []byte {
	return []byte(fmt.Sprintf("devdock-action-v1\n%s\n%s\n%s\n%s\n%d", agentFP, r.Action, r.Target, r.Nonce, r.Expires))
}

var used = struct {
	sync.Mutex
	m map[string]int64
}{m: map[string]int64{}}

var (
	nonceRe     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	containerRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
)

// verifyAction checks everything except whether the action itself is allowed
func verifyAction(key, agentFP string, r *ActionReq, now time.Time) error {
	pub, err := parseActionKey(key)
	if err != nil {
		return err
	}
	if !nonceRe.MatchString(r.Nonce) {
		return fmt.Errorf("bad nonce")
	}
	if r.Expires < now.Unix() || r.Expires > now.Add(60*time.Second).Unix() {
		return fmt.Errorf("expired, or valid for too long: check both clocks")
	}
	sig, err := base64.StdEncoding.DecodeString(r.Sig)
	if err != nil {
		return fmt.Errorf("bad signature")
	}
	h := sha256.Sum256(actionMessage(agentFP, r))
	if !ecdsa.VerifyASN1(pub, h[:], sig) {
		return fmt.Errorf("bad signature")
	}
	used.Lock()
	defer used.Unlock()
	for n, exp := range used.m {
		if exp < now.Unix() {
			delete(used.m, n)
		}
	}
	if _, seen := used.m[r.Nonce]; seen {
		return fmt.Errorf("already used")
	}
	used.m[r.Nonce] = r.Expires
	return nil
}

func parseActionKey(key string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil || key == "" {
		return nil, fmt.Errorf("no action key: actions are off")
	}
	k, err := x509.ParsePKIXPublicKey(der)
	pub, ok := k.(*ecdsa.PublicKey)
	if err != nil || !ok {
		return nil, fmt.Errorf("the action key isn't a P-256 key")
	}
	return pub, nil
}

func (a *Agent) action(w http.ResponseWriter, r *http.Request) {
	var req ActionReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		reply(w, 400, map[string]string{"error": "bad request"})
		return
	}
	if !a.cfg.Scope.Actions {
		reply(w, 403, map[string]string{"error": "actions aren't allowed on this machine"})
		return
	}
	if err := verifyAction(a.cfg.ActionKey, a.agentFP, &req, time.Now()); err != nil {
		log.Printf("refused %s %s: %v", req.Action, req.Target, err)
		reply(w, 403, map[string]string{"error": "refused: " + err.Error()})
		return
	}
	err := a.do(req.Action, req.Target)
	log.Printf("action %s %s: %v", req.Action, req.Target, errOr(err, "done")) // the journal is the audit trail
	if err != nil {
		reply(w, 400, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 200, map[string]string{"ok": "true"})
}

func errOr(err error, s string) any {
	if err != nil {
		return err
	}
	return s
}

func (a *Agent) do(action, target string) error {
	switch action {
	case "process-stop", "process-kill":
		pid, err := strconv.Atoi(target)
		if err != nil || pid <= 1 {
			return fmt.Errorf("bad process id")
		}
		sig := syscall.SIGTERM
		if action == "process-kill" {
			sig = syscall.SIGKILL
		}
		return syscall.Kill(pid, sig)
	case "container-stop", "container-start", "container-restart":
		if !a.cfg.Scope.Containers {
			return fmt.Errorf("containers aren't shared on this machine")
		}
		if !containerRe.MatchString(target) {
			return fmt.Errorf("bad container id")
		}
		return a.collect.docker.post("/containers/" + target + "/" + action[len("container-"):])
	}
	return fmt.Errorf("unknown action %q", action)
}

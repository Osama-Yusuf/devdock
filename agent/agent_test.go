package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// an agent on a free port with a fresh identity, and a master key it trusts
func startAgent(t *testing.T, scope Scope) (addr string, master tls.Certificate, a *Agent, token string) {
	t.Helper()
	dir := t.TempDir()
	master, err := loadOrCreateIdentity(filepath.Join(dir, "master"))
	if err != nil {
		t.Fatal(err)
	}
	p := Paths{Config: filepath.Join(dir, "config.json"), State: filepath.Join(dir, "state")}
	cert, err := loadOrCreateIdentity(p.State)
	if err != nil {
		t.Fatal(err)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr = ln.Addr().String()
	ln.Close()
	token = newToken()
	_ = savePairing(p.State, &Pairing{Token: token, Expires: time.Now().Add(time.Hour)})
	cfg := &Config{Listen: addr, MasterFP: fingerprint(master.Certificate[0]), Networks: "private", Scope: scope}
	a = &Agent{cfg: cfg, p: p, cert: cert, agentFP: fingerprint(cert.Certificate[0]), collect: NewCollector(), started: time.Now()}
	go a.Serve()
	for i := 0; i < 50; i++ {
		if c, err := net.Dial("tcp", addr); err == nil {
			c.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return
}

func client(cert *tls.Certificate) *http.Client {
	cfg := &tls.Config{InsecureSkipVerify: true} // the test checks the agent's key by hand below
	if cert != nil {
		cfg.Certificates = []tls.Certificate{*cert}
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: cfg}}
}

func TestOnlyThePinnedMasterGetsIn(t *testing.T) {
	addr, master, _, _ := startAgent(t, RecommendedScope())
	if _, err := client(nil).Get("https://" + addr + "/v1/info"); err == nil {
		t.Fatal("a client without a certificate got in")
	}
	stranger, _ := loadOrCreateIdentity(t.TempDir())
	if _, err := client(&stranger).Get("https://" + addr + "/v1/info"); err == nil {
		t.Fatal("a client with an unknown certificate got in")
	}
	r, err := client(&master).Get("https://" + addr + "/v1/info")
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("the master was refused: %v", err)
	}
}

func TestPairingProvesTheTokenOnce(t *testing.T) {
	addr, master, a, token := startAgent(t, RecommendedScope())
	c := client(&master)
	pair := func(hint string) (*http.Response, map[string]string) {
		r, err := c.Post("https://"+addr+"/v1/pair", "application/json", strings.NewReader(`{"tokenHint":"`+hint+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]string
		_ = json.NewDecoder(r.Body).Decode(&m)
		return r, m
	}
	if r, _ := pair("00000000"); r.StatusCode != 403 {
		t.Fatalf("a wrong token hint got %d", r.StatusCode)
	}
	r, m := pair(token[:8])
	if r.StatusCode != 200 {
		t.Fatalf("pairing failed: %v", m)
	}
	// the master checks the proof against the key it actually saw in the handshake
	seen := fingerprint(r.TLS.PeerCertificates[0].Raw)
	if seen != a.agentFP || m["proof"] != pairProof(token, seen, fingerprint(master.Certificate[0])) {
		t.Fatal("the proof doesn't bind the agent's key")
	}
	if r, _ := pair(token[:8]); r.StatusCode != 409 {
		t.Fatalf("a second pairing got %d", r.StatusCode)
	}
	if loadPairing(a.p.State).Token != "" {
		t.Fatal("the token was kept after pairing")
	}
}

func TestScopeLimitsTheSnapshot(t *testing.T) {
	addr, master, _, _ := startAgent(t, Scope{System: true})
	r, err := client(&master).Get("https://" + addr + "/v1/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	var s map[string]any
	_ = json.Unmarshal(b, &s)
	for _, k := range []string{"processes", "ports", "containers"} {
		if _, ok := s[k]; ok {
			t.Errorf("%s was shared outside the scope", k)
		}
	}
	if s["host"] == nil || s["mem"] == nil {
		t.Errorf("system wasn't shared: %s", b)
	}
}

func TestPrivateNetworksOnly(t *testing.T) {
	for ip, want := range map[string]bool{"192.168.1.5": true, "10.2.3.4": true, "100.101.7.23": true, "172.20.0.1": true, "fe80::1": true,
		"8.8.8.8": false, "100.128.0.1": false, "172.32.0.1": false, "2001:4860::1": false} {
		if got := allowedIP(net.ParseIP(ip), "private"); got != want {
			t.Errorf("%s: got %v", ip, got)
		}
	}
}

func TestUpdatesNeedAValidSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	key := base64.StdEncoding.EncodeToString(pub)
	body := []byte(`{"version":"9.9.9","expires":"` + time.Now().Add(time.Hour).Format(time.RFC3339) + `","assets":{}}`)
	sig := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body)))
	if _, err := verifyManifest(body, sig, key); err != nil {
		t.Fatalf("a good manifest failed: %v", err)
	}
	tampered := []byte(strings.Replace(string(body), "9.9.9", "9.9.8", 1))
	if _, err := verifyManifest(tampered, sig, key); err == nil {
		t.Fatal("a tampered manifest passed")
	}
	if _, err := verifyManifest(body, sig, ""); err == nil {
		t.Fatal("a build without a release key accepted an update")
	}
	old := []byte(`{"version":"9.9.9","expires":"2020-01-01T00:00:00Z","assets":{}}`)
	if _, err := verifyManifest(old, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, old))), key); err == nil {
		t.Fatal("an expired manifest passed")
	}
	if !newer("1.10.0", "1.9.3") || newer("1.2.0", "1.2.0") || newer("0.9", "1.0") {
		t.Fatal("version order is wrong")
	}
}

func TestMain(m *testing.M) {
	os.Setenv("DEVDOCK_AGENT_HOME", os.TempDir())
	os.Exit(m.Run())
}

func TestActionsNeedAFreshSignatureForThisAgent(t *testing.T) {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	key := base64.StdEncoding.EncodeToString(der)
	now := time.Now()
	signed := func(fp, target string, exp time.Time) *ActionReq {
		n := make([]byte, 16)
		rand.Read(n)
		r := &ActionReq{Action: "process-stop", Target: target, Nonce: hex.EncodeToString(n), Expires: exp.Unix()}
		h := sha256.Sum256(actionMessage(fp, r))
		sig, _ := ecdsa.SignASN1(rand.Reader, priv, h[:])
		r.Sig = base64.StdEncoding.EncodeToString(sig)
		return r
	}
	good := signed("agentA", "123", now.Add(30*time.Second))
	if err := verifyAction(key, "agentA", good, now); err != nil {
		t.Fatalf("a good action was refused: %v", err)
	}
	if verifyAction(key, "agentA", good, now) == nil {
		t.Fatal("a replayed action passed")
	}
	if verifyAction(key, "agentB", signed("agentA", "123", now.Add(30*time.Second)), now) == nil {
		t.Fatal("an action signed for another machine passed")
	}
	moved := signed("agentA", "123", now.Add(30*time.Second))
	moved.Target = "1"
	if verifyAction(key, "agentA", moved, now) == nil {
		t.Fatal("an action with a swapped target passed")
	}
	if verifyAction(key, "agentA", signed("agentA", "123", now.Add(-time.Second)), now) == nil {
		t.Fatal("an expired action passed")
	}
	if verifyAction(key, "agentA", signed("agentA", "123", now.Add(10*time.Minute)), now) == nil {
		t.Fatal("an action valid for 10 minutes passed")
	}
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	oder, _ := x509.MarshalPKIXPublicKey(&other.PublicKey)
	if verifyAction(base64.StdEncoding.EncodeToString(oder), "agentA", signed("agentA", "123", now.Add(30*time.Second)), now) == nil {
		t.Fatal("an action signed by another key passed")
	}
	if verifyAction("", "agentA", signed("agentA", "123", now.Add(30*time.Second)), now) == nil {
		t.Fatal("an agent without an action key accepted an action")
	}
}

func TestRootNeverWritesThroughAPlantedLink(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "sudoers")
	os.WriteFile(victim, []byte("keep"), 0o644)
	state := filepath.Join(dir, "state")
	os.MkdirAll(state, 0o700)
	os.Symlink(victim, filepath.Join(state, "key.pem"))
	os.Symlink(victim, filepath.Join(state, "pairing.json"))
	if _, err := loadOrCreateIdentity(state); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(state, "pairing.json"), map[string]int{"x": 1}, 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep" {
		t.Fatalf("written through the link: %q", b)
	}
}

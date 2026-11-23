package main

// update: install a newer release only if its manifest is signed by the release key built
// into this binary, hasn't expired, is newer than what runs now, and the download matches
// the manifest's SHA-256. Ed25519 from the standard library; no third-party crypto.
//
// manifest.json:     {"version":"1.1.0","expires":"2027-01-01T00:00:00Z","assets":{"linux-amd64":{"url":"…","sha256":"…"}}}
// manifest.json.sig: base64 Ed25519 signature over the exact manifest bytes

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var updateKey = "" // base64 Ed25519 public key, set at build: -X main.updateKey=…

const defaultManifest = "https://github.com/Osama-Yusuf/devdock/releases/latest/download/agent-manifest.json"

type manifest struct {
	Version string    `json:"version"`
	Expires time.Time `json:"expires"`
	Assets  map[string]struct {
		URL    string `json:"url"`
		SHA256 string `json:"sha256"`
	} `json:"assets"`
}

func fetch(src string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(src, "https://") {
		if strings.HasPrefix(src, "http://") {
			return nil, fmt.Errorf("refusing plain http: %s", src)
		}
		return os.ReadFile(src) // a local file, for offline installs and tests
	}
	c := &http.Client{Timeout: 2 * time.Minute}
	r, err := c.Get(src)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", src, r.Status)
	}
	return io.ReadAll(io.LimitReader(r.Body, limit))
}

// newer compares dotted versions numerically: 1.10.0 > 1.9.3
func newer(a, b string) bool {
	pa, pb := strings.Split(strings.TrimPrefix(a, "v"), "."), strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func verifyManifest(body, sig []byte, key string) (*manifest, error) {
	pub, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("this build has no release key, so it can't verify updates")
	}
	s, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || !ed25519.Verify(pub, body, s) {
		return nil, fmt.Errorf("the update's signature is wrong: not installing it")
	}
	m := &manifest{}
	if err := json.Unmarshal(body, m); err != nil {
		return nil, err
	}
	if time.Now().After(m.Expires) {
		return nil, fmt.Errorf("the update manifest expired on %s: not installing it", m.Expires.Format("2006-01-02"))
	}
	return m, nil
}

func update(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	src := fs.String("manifest", defaultManifest, "manifest URL (https) or file")
	check := fs.Bool("check", false, "only say whether an update exists")
	if err := fs.Parse(args); err != nil {
		return err
	}
	body, err := fetch(*src, 1<<20)
	if err != nil {
		return err
	}
	sig, err := fetch(*src+".sig", 4096)
	if err != nil {
		return err
	}
	m, err := verifyManifest(body, sig, updateKey)
	if err != nil {
		return err
	}
	if !newer(m.Version, version) {
		fmt.Printf("Up to date (%s).\n", version)
		return nil
	}
	if *check {
		fmt.Printf("Update available: %s → %s\n", version, m.Version)
		return nil
	}
	if err := needRoot(); err != nil {
		return err
	}
	a, ok := m.Assets[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		return fmt.Errorf("release %s has no build for %s-%s", m.Version, runtime.GOOS, runtime.GOARCH)
	}
	bin, err := fetch(a.URL, 64<<20)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bin)
	if hex.EncodeToString(sum[:]) != strings.ToLower(a.SHA256) {
		return fmt.Errorf("the download doesn't match the signed checksum: not installing it")
	}
	p := paths()
	tmp := p.Bin + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, p.Bin); err != nil {
		return err
	}
	fmt.Printf("Updated %s → %s\n", version, m.Version)
	if initSystem() != "none" {
		return restartService()
	}
	return nil
}

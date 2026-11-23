package main

// The agent's only door. In order, a connection must:
//   1. come from an allowed network (private ranges by default), checked before TLS
//   2. stay under the per-address and total connection limits
//   3. complete TLS 1.3 presenting the pinned master certificate
// Only then does an HTTP handler run, and handlers only expose what the scope allows.

import (
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

var privateNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, c := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8",
		"fc00::/7", "fe80::/10", "::1/128"} {
		_, n, _ := net.ParseCIDR(c)
		out = append(out, n)
	}
	return out
}()

func allowedIP(ip net.IP, networks string) bool {
	if networks == "any" {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range privateNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// guardedListener drops connections from outside the allowed networks and caps them:
// 32 open at once, 30 new ones per address per minute.
type guardedListener struct {
	net.Listener
	networks string
	slots    chan struct{}
	mu       sync.Mutex
	recent   map[string][]time.Time // failed handshakes per IP, last minute
	trusted  map[string]time.Time   // IPs the master connected from
	open     map[string]int         // connections each IP holds right now
}

// One IPv6 host gets a whole /64 for free, so that's the unit a stranger is counted by
func ipKey(ip net.IP) string {
	if ip.To4() == nil {
		return ip.Mask(net.CIDRMask(64, 128)).String()
	}
	return ip.String()
}

func (l *guardedListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
		ip := net.ParseIP(host)
		if ip == nil || !allowedIP(ip, l.networks) || !l.allow(ipKey(ip)) {
			c.Close()
			continue
		}
		select {
		case l.slots <- struct{}{}:
			k := ipKey(ip)
			return &slotConn{Conn: c, l: l, ip: k, release: func() { <-l.slots; l.closed(k) }}, nil
		default:
			l.closed(ipKey(ip))
			c.Close()
		}
	}
}

// Only connections that fail to prove they're the master count against an IP, so a
// stranger's flood can't lock the master out by burning a shared budget. The master's own
// IP is never banned (ponytail: an attacker behind the same NAT still only gets the 32 slots).
func (l *guardedListener) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.trusted[ip]) < 10*time.Minute {
		l.open[ip]++
		return true
	}
	// a stranger gets 4 connections at once out of 32, so it takes 8 addresses to fill them
	if l.open[ip] >= 4 {
		return false
	}
	keep := l.recent[ip][:0]
	for _, t := range l.recent[ip] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	l.recent[ip] = keep
	if len(keep) >= 30 {
		return false
	}
	l.open[ip]++
	return true
}

func (l *guardedListener) closed(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open[ip]--; l.open[ip] <= 0 {
		delete(l.open, ip)
	}
}

func (l *guardedListener) failed(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.recent) > 1024 { // bounded under a scan: forget quiet IPs, never the noisy ones
		for k, ts := range l.recent {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > time.Minute {
				delete(l.recent, k)
			}
		}
	}
	if len(l.recent) > 4096 {
		return // ponytail: past this, new strangers' failures go uncounted; the per-IP cap still holds
	}
	l.recent[ip] = append(l.recent[ip], now)
}

func (l *guardedListener) authed(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.trusted) > 64 {
		l.trusted = map[string]time.Time{}
	}
	l.trusted[ip] = time.Now()
}

type slotConn struct {
	net.Conn
	l       *guardedListener
	ip      string
	ok      bool // passed mutual TLS and sent a request
	once    sync.Once
	release func()
}

func (c *slotConn) Close() error {
	c.once.Do(func() {
		c.release()
		if !c.ok {
			c.l.failed(c.ip)
		}
	})
	return c.Conn.Close()
}

type Agent struct {
	cfg     *Config
	p       Paths
	cert    tls.Certificate
	agentFP string
	collect *Collector
	pairMu  sync.Mutex
	started time.Time
}

func (a *Agent) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", func(w http.ResponseWriter, r *http.Request) {
		p := loadPairing(a.p.State)
		reply(w, 200, map[string]any{"version": version, "agentFp": a.agentFP, "scope": a.cfg.Scope, "paired": p.Paired, "networks": a.cfg.Networks,
			"started": a.started.Unix()})
	})
	mux.HandleFunc("GET /v1/snapshot", func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, a.collect.Snapshot(a.cfg.Scope))
	})
	mux.HandleFunc("POST /v1/pair", a.pair)
	mux.HandleFunc("POST /v1/action", a.action)
	return mux
}

// pair answers the master's first contact with proof that this agent holds the token from
// the install command. The token works once and expires.
func (a *Agent) pair(w http.ResponseWriter, r *http.Request) {
	a.pairMu.Lock()
	defer a.pairMu.Unlock()
	p := loadPairing(a.p.State)
	if p.Paired {
		reply(w, 409, map[string]any{"error": "already paired; run `sudo devdock-agent pair` on this machine to pair again"})
		return
	}
	if p.Token == "" || time.Now().After(p.Expires) {
		reply(w, 410, map[string]any{"error": "pairing code expired; run `sudo devdock-agent pair` on this machine for a new one"})
		return
	}
	var body struct {
		TokenHint string `json:"tokenHint"` // first 8 chars, so a stale command fails clearly
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	if subtle.ConstantTimeCompare([]byte(body.TokenHint), []byte(p.Token[:8])) != 1 {
		reply(w, 403, map[string]any{"error": "this machine was set up with a different pairing code"})
		return
	}
	proof := pairProof(p.Token, a.agentFP, a.cfg.MasterFP)
	if err := savePairing(a.p.State, &Pairing{Paired: true, At: time.Now()}); err != nil {
		reply(w, 500, map[string]any{"error": "could not save pairing: " + err.Error()})
		return
	}
	log.Printf("paired with master %s…", a.cfg.MasterFP[:12])
	reply(w, 200, map[string]any{"agentFp": a.agentFP, "proof": proof, "version": version})
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *Agent) Serve() error {
	ln, err := net.Listen("tcp", a.cfg.Listen)
	if err != nil {
		return err
	}
	g := &guardedListener{Listener: ln, networks: a.cfg.Networks, slots: make(chan struct{}, 32), recent: map[string][]time.Time{}, trusted: map[string]time.Time{}, open: map[string]int{}}
	srv := &http.Server{
		Handler:           a.routes(),
		TLSConfig:         serverTLS(a.cert, a.cfg.MasterFP),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    8 << 10,
		ErrorLog:          log.New(quietTLS{}, "", 0),
		// a request arrived, so the handshake proved the master's key
		ConnState: func(c net.Conn, st http.ConnState) {
			if tc, ok := c.(*tls.Conn); ok && st == http.StateActive {
				if sc, ok := tc.NetConn().(*slotConn); ok && !sc.ok {
					sc.ok = true
					sc.l.authed(sc.ip)
				}
			}
		},
	}
	log.Printf("devdock-agent %s listening on %s (networks: %s)", version, a.cfg.Listen, a.cfg.Networks)
	err = srv.ServeTLS(g, "", "")
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Failed handshakes from strangers are expected noise: count them, don't flood the journal
type quietTLS struct{}

var tlsRejects struct {
	sync.Mutex
	n    int
	last time.Time
}

func (quietTLS) Write(b []byte) (int, error) {
	tlsRejects.Lock()
	defer tlsRejects.Unlock()
	tlsRejects.n++
	if time.Since(tlsRejects.last) > time.Minute {
		log.Printf("rejected %d connection(s) without the master's key in the last minute", tlsRejects.n)
		tlsRejects.n, tlsRejects.last = 0, time.Now()
	}
	return len(b), nil
}

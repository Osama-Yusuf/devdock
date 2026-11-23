package main

// Identity and pairing.
//
// Each side has a self-signed P-256 certificate and pins the other's SHA-256 fingerprint:
// no certificate authority to trust, nothing to expire mid-flight. The agent learns the
// master's fingerprint from the install command. The master learns the agent's at pairing:
// the agent proves it holds the one-time token from that same command with
//   HMAC-SHA256(token, "devdock-pair-v1|" + agentFP + "|" + masterFP)
// so a machine in the middle can't pose as the agent (no token) or as the master (no key).

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func fingerprint(der []byte) string {
	s := sha256.Sum256(der)
	return hex.EncodeToString(s[:])
}

// loadOrCreateIdentity returns the agent's certificate, creating it on first run
func loadOrCreateIdentity(state string) (tls.Certificate, error) {
	certPath, keyPath := filepath.Join(state, "cert.pem"), filepath.Join(state, "key.pem")
	if c, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return c, nil
	}
	if err := os.MkdirAll(state, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	host, _ := os.Hostname()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "devdock-agent " + host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(20, 0, 0), // pinned, not CA-validated: expiry would only break pairing
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := writeNew(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := writeNew(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.LoadX509KeyPair(certPath, keyPath)
}

// serverTLS accepts only the pinned master: anyone else fails the handshake and never
// reaches an HTTP handler.
func serverTLS(cert tls.Certificate, masterFP string) *tls.Config {
	want, _ := hex.DecodeString(masterFP)
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAnyClientCert,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("no client certificate")
			}
			got := sha256.Sum256(raw[0])
			if !hmac.Equal(got[:], want) {
				return errors.New("unknown master")
			}
			return nil
		},
	}
}

func pairProof(token, agentFP, masterFP string) string {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte("devdock-pair-v1|" + agentFP + "|" + masterFP))
	return hex.EncodeToString(m.Sum(nil))
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// writeNew refuses an existing path, links included: install runs as root in a folder the
// agent user owns, and a planted key.pem -> /etc/shadow must not get written through
func writeNew(p string, b []byte, mode os.FileMode) error {
	_ = os.Remove(p) // removes a link itself, never its target
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// keyCode is the part of the fingerprint people compare by eye: 64 bits, in groups of four.
// DevDock shows the same groups (sources/machines.js keyCode).
func keyCode(fp string) string {
	return strings.ToUpper(fp[0:4] + " " + fp[4:8] + " " + fp[8:12] + " " + fp[12:16])
}

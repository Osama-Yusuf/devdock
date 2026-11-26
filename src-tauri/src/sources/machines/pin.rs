//! TLS to an agent. Its certificate is self-signed, so trust is the exact pin: the handshake
//! fails unless the certificate's SHA-256 is the one paired, before a single byte of HTTP is
//! sent. The handshake signature is still checked, so the agent must hold that key. DevDock's
//! own certificate goes along: the agent only talks to the master it was installed for.
use super::{sha256_hex, Master};
use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};
use std::sync::Arc;
use std::time::Duration;

pub const KEY_CHANGED: &str = "This machine's key changed";
pub const REFUSED: &str = "Connection refused";

#[derive(Debug)]
struct Pin { fp: Option<String>, algs: WebPkiSupportedAlgorithms }

impl ServerCertVerifier for Pin {
    fn verify_server_cert(&self, cert: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, Error> {
        match &self.fp {
            None => Ok(ServerCertVerified::assertion()), // pairing: the proof checks the certificate we saw
            Some(fp) if sha256_hex(cert) == *fp => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(Error::General(KEY_CHANGED.into())),
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> { verify_tls12_signature(m, c, d, &self.algs) }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> { verify_tls13_signature(m, c, d, &self.algs) }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> { self.algs.supported_schemes() }
}

/// A client pinned to `fp`, or, for pairing, one that takes any certificate and reports it
pub fn client(master: &Master, fp: Option<&str>) -> Result<reqwest::Client, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let algs = provider.signature_verification_algorithms;
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(master.cert.as_bytes()).collect::<Result<_, _>>().map_err(|e| format!("DevDock's certificate: {e}"))?;
    let key = PrivateKeyDer::from_pem_slice(master.key.as_bytes()).map_err(|e| format!("DevDock's key: {e}"))?;
    // DevDock's certificate is X.509 v1 (LibreSSL's `req -x509` makes those), which rustls's
    // key-matches-certificate check won't parse; the agent only hashes it, so skip that check
    let signer = provider.key_provider.load_private_key(key).map_err(|e| format!("DevDock's key: {e}"))?;
    let me = rustls::sign::SingleCertAndKey::from(rustls::sign::CertifiedKey::new(certs, signer));
    let tls = rustls::ClientConfig::builder_with_provider(provider as Arc<CryptoProvider>)
        .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
        .dangerous().with_custom_certificate_verifier(Arc::new(Pin { fp: fp.map(String::from), algs }))
        .with_client_cert_resolver(Arc::new(me));
    let b = reqwest::Client::builder().use_preconfigured_tls(tls).no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(4));
    let b = if fp.is_some() { b.pool_max_idle_per_host(2) } else { b.tls_info(true).pool_max_idle_per_host(0) };
    b.build().map_err(|e| e.to_string())
}

/// What went wrong, in words: the pin, a refused connection, a timeout, or the innermost cause
pub fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() { return "No answer".into(); }
    let mut chain: Vec<String> = vec![];
    let mut cur: Option<&dyn std::error::Error> = Some(e);
    while let Some(x) = cur {
        if let Some(io) = x.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::ConnectionRefused { return REFUSED.into(); }
            if io.kind() == std::io::ErrorKind::TimedOut { return "No answer".into(); }
        }
        chain.push(x.to_string());
        cur = x.source();
    }
    if chain.iter().any(|m| m.contains(KEY_CHANGED)) { return KEY_CHANGED.into(); }
    if chain.iter().any(|m| m.contains("dns error") || m.contains("failed to lookup")) { return "Can't find that host".into(); }
    chain.pop().unwrap_or_else(|| e.to_string())
}

/// sha256 of the first certificate in a PEM, hex, as the JS pins it (fingerprint256 without colons)
pub fn pem_fingerprint(pem: &str) -> Option<String> { CertificateDer::from_pem_slice(pem.as_bytes()).ok().map(|c| sha256_hex(&c)) }

/// DER to PEM with 64-character lines, as the Node app saved agentCert
pub fn pem_of(der: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
    format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// v1 like DevDock's own (plain `req -x509`), or v3 like the Go agent's (an extension makes it v3)
    fn keypair(dir: &std::path::Path, name: &str, v3: bool) -> (String, String) {
        let (k, c) = (dir.join(format!("{name}k.pem")), dir.join(format!("{name}c.pem")));
        let ext: &[&str] = if v3 { &["-addext", "basicConstraints=critical,CA:FALSE"] } else { &[] };
        let ok = Command::new("/usr/bin/openssl").args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve",
            "-nodes", "-days", "1", "-subj", &format!("/CN={name}")]).args(ext).arg("-keyout").arg(&k).arg("-out").arg(&c).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success();
        assert!(ok);
        (std::fs::read_to_string(k).unwrap(), std::fs::read_to_string(c).unwrap())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn agent_connections_trust_only_the_pinned_key() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("pin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (_, agent_cert) = keypair(&dir, "agent", true);
        let (key, cert) = keypair(&dir, "master", false);
        let master = Master { fp: pem_fingerprint(&cert).unwrap(), key, cert, action_key: None };
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        // openssl's test server answers any GET with a status page
        let mut srv = Command::new("/usr/bin/openssl").args(["s_server", "-quiet", "-www", "-accept", &port.to_string(), "-key"]).arg(dir.join("agentk.pem"))
            .arg("-cert").arg(dir.join("agentc.pem")).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let url = format!("https://127.0.0.1:{port}/");
        let mut up = false;
        for _ in 0..50 { if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() { up = true; break; } std::thread::sleep(Duration::from_millis(100)); }
        assert!(up);
        let wrong = client(&master, Some(&"00".repeat(32))).unwrap().get(&url).send().await.unwrap_err();
        assert_eq!(describe(&wrong), KEY_CHANGED);
        let fp = pem_fingerprint(&agent_cert).unwrap();
        let ok = client(&master, Some(&fp)).unwrap().get(&url).send().await.unwrap();
        assert_eq!(ok.status(), 200);
        // pairing takes any key and reports the one it saw
        let p = client(&master, None).unwrap().get(&url).send().await.unwrap();
        let der = p.extensions().get::<reqwest::tls::TlsInfo>().and_then(|i| i.peer_certificate()).unwrap().to_vec();
        assert_eq!(sha256_hex(&der), fp);
        assert_eq!(pem_fingerprint(&pem_of(&der)), Some(fp));
        let refused = client(&master, Some("00")).unwrap().get("https://127.0.0.1:1/").send().await.unwrap_err();
        assert_eq!(describe(&refused), REFUSED);
        let _ = srv.kill();
        let _ = srv.wait();
        let _ = std::fs::remove_dir_all(dir);
    }
}

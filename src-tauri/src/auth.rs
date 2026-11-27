//! Who may use the API. Any process on this Mac can reach 127.0.0.1 and send whatever Host it
//! likes, so headers prove nothing: a request needs the key, a per-launch secret that only the
//! window gets, and only after Touch ID. Locking takes it back and closes every open WebSocket.
use axum::http::{header, HeaderMap};
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;

static KEY: Mutex<Option<String>> = Mutex::new(None);

fn gone() -> &'static watch::Sender<u64> {
    static G: OnceLock<watch::Sender<u64>> = OnceLock::new();
    G.get_or_init(|| watch::channel(0).0)
}

/// A fresh key, replacing any old one
pub fn issue() -> String {
    let mut b = [0u8; 32];
    unsafe { libc::arc4random_buf(b.as_mut_ptr().cast(), b.len()) };
    let k: String = b.iter().map(|x| format!("{x:02x}")).collect();
    *KEY.lock().unwrap() = Some(k.clone());
    k
}

/// The key in force; none while locked
pub fn current() -> Option<String> { KEY.lock().unwrap().clone() }

/// Lock: no key works any more, and open sockets close
pub fn revoke() {
    *KEY.lock().unwrap() = None;
    gone().send_modify(|g| *g += 1);
}

/// Changes when the key is revoked
pub fn revoked() -> watch::Receiver<u64> { gone().subscribe() }

/// Per port, so a second copy on another port (tests) doesn't overwrite this one's cookie
fn name() -> String { format!("devdock-{}", crate::server::port()) }

/// What a page that showed the key gets: JavaScript can't read it, other sites can't send it
pub fn cookie(k: &str) -> String { format!("{}={k}; Path=/; HttpOnly; SameSite=Strict", name()) }

/// The key in force, compared in constant time
pub fn valid(k: &str) -> bool {
    let same = |a: &[u8], b: &[u8]| a.len() == b.len() && a.iter().zip(b).fold(0, |d, (x, y)| d | (x ^ y)) == 0;
    KEY.lock().unwrap().as_deref().is_some_and(|cur| same(cur.as_bytes(), k.as_bytes()))
}

/// Open to anyone: the lock page and its icon, the door that takes the key, a liveness ping
fn open(path: &str) -> bool { path == "/lock" || path.starts_with("/lock/") || path.starts_with("/__auth/") || path == "/api/ping" }

pub fn allows(path: &str, headers: &HeaderMap) -> bool {
    open(path)
        || headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';')).filter_map(|c| c.trim().split_once('='))
            .any(|(n, v)| n == name() && valid(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(cookie: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(c) = cookie { h.insert(header::COOKIE, c.parse().unwrap()); }
        h
    }

    // one test: the key is process-wide
    #[test]
    fn only_with_the_key() {
        revoke();
        assert!(!allows("/api/settings", &with(None)), "locked: nothing");
        assert!(allows("/lock", &with(None)) && allows("/lock/icon.png", &with(None)) && allows("/api/ping", &with(None)));
        assert!(!allows("/lockdown", &with(None)));

        let k = issue();
        assert_eq!(k.len(), 64);
        assert!(!allows("/", &with(None)), "no cookie");
        assert!(!allows("/", &with(Some("devdock-4003=nope"))), "wrong key");
        assert!(!allows("/", &with(Some(&format!("devdock-4010={k}")))), "another port's cookie");
        assert!(!allows("/", &with(Some(&format!("devdock-4003={}", &k[..63])))), "a prefix");
        assert!(allows("/", &with(Some(&format!("a=b; devdock-4003={k}; c=d")))), "among others");

        let rx = revoked();
        revoke();
        assert!(rx.has_changed().unwrap(), "sockets hear about it");
        assert!(!allows("/", &with(Some(&format!("devdock-4003={k}")))), "revoked");

        let k2 = issue();
        assert_ne!(k, k2);
        assert!(!valid(&k) && valid(&k2), "a new key per unlock");
        assert!(cookie(&k2).contains("HttpOnly") && cookie(&k2).contains("SameSite=Strict"));
    }
}

//! Terminals inside DevDock: the source's command (tmux attach, ssh, docker exec...) runs in a
//! real pty, rendered by xterm.js in the page, so prefix keys, copy mode and mouse behave like Terminal.
use crate::state::Ctx;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

/// Set by multiplexers: DevDock started inside one would make the attach refuse to nest
const NESTING_VARS: &[&str] = &["TMUX", "TMUX_PANE", "ZELLIJ", "ZELLIJ_SESSION_NAME", "STY", "HERDR_SESSION", "HERDR_SOCKET_PATH"];

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Writer,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// false once the page closed it, so its exit isn't reported
    open: Arc<AtomicBool>,
}

impl Term {
    pub fn write(&self, data: &str) { let _ = self.writer.lock().unwrap().write_all(data.as_bytes()); }
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize { cols: cols.max(20), rows: rows.max(5), pixel_width: 0, pixel_height: 0 });
    }
}

impl Drop for Term {
    fn drop(&mut self) {
        self.open.store(false, Ordering::SeqCst);
        let _ = self.child.lock().unwrap().kill();
    }
}

/// Bytes to text across reads: a character split between two reads waits for its other half
#[derive(Default)]
pub struct Utf8Stream { rest: Vec<u8> }
impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.rest.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.rest) {
                Ok(s) => { out.push_str(s); self.rest.clear(); return out; }
                Err(e) => {
                    let good = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.rest[..good]).unwrap());
                    match e.error_len() {
                        None => { self.rest.drain(..good); return out; } // cut at the end: keep it for the next read
                        Some(n) => { out.push('\u{FFFD}'); self.rest.drain(..good + n); }
                    }
                }
            }
        }
    }
}

const BLOCKED: &str = "\r\n\x1b[33mmacOS kept DevDock off your local network. Turn on DevDock in System Settings > Privacy & Security > Local Network, then try again.\x1b[0m\r\n";

/// Open the source's terminal for this page; messages go out through `out`
pub async fn open(c: &Ctx, m: &Value, out: UnboundedSender<String>) -> Option<Term> {
    let send = |v: Value| { let _ = out.send(v.to_string()); };
    let params = m.get("params").cloned().unwrap_or(json!({}));
    let spec = if c.demo { Ok(None) } else { c.sources.terminal(c, m["source"].as_str().unwrap_or(""), &params).await };
    let spec = match spec {
        Ok(Some(s)) => s,
        Ok(None) => { send(json!({ "type": "term-exit", "reason": "This session is gone" })); return None; }
        Err(e) => { send(json!({ "type": "term-exit", "reason": e.msg })); return None; }
    };
    let size = PtySize { cols: m["cols"].as_u64().unwrap_or(80).max(20) as u16, rows: m["rows"].as_u64().unwrap_or(24).max(5) as u16, pixel_width: 0, pixel_height: 0 };
    let started = native_pty_system().openpty(size).map_err(|e| e.to_string()).and_then(|pair| {
        let mut cmd = CommandBuilder::new(&spec.file);
        cmd.args(&spec.args);
        cmd.cwd(spec.cwd.clone().map(std::path::PathBuf::from).unwrap_or_else(crate::util::home));
        for k in NESTING_VARS { cmd.env_remove(k); }
        cmd.env("TERM", "xterm-256color");
        cmd.env("PATH", crate::util::search_path());
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        Ok((pair.master, child, reader, writer))
    });
    let (master, child, mut reader, writer) = match started {
        Ok(x) => x,
        Err(e) => { send(json!({ "type": "term-exit", "reason": format!("Could not start: {e}") })); return None; }
    };
    let term = Term { master, writer: Arc::new(Mutex::new(writer)), child: Arc::new(Mutex::new(child)), open: Arc::new(AtomicBool::new(true)) };

    // typed in, so it never shows in a command line; input_when waits until the far side is ready
    let mut input = spec.input.clone();
    if spec.input_when.is_none() { if let Some(i) = input.take() { term.write(&i); } }
    send(json!({ "type": "term-start" }));

    let (writer, child, open) = (term.writer.clone(), term.child.clone(), term.open.clone());
    let (when, keep) = (spec.input_when.clone(), spec.keep);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut utf8 = Utf8Stream::default();
        let mut blocked = false;
        loop {
            let n = match reader.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            let mut data = utf8.push(&buf[..n]);
            // macOS's Local Network privacy shows up in ssh as this odd error
            if !blocked && data.contains("connect to host") && data.contains("Undefined error: 0") { blocked = true; data.push_str(BLOCKED); }
            if when.as_deref().is_some_and(|w| data.contains(w)) {
                if let Some(i) = input.take() { let _ = writer.lock().unwrap().write_all(i.as_bytes()); }
            }
            if !open.load(Ordering::SeqCst) { return; }
            let _ = out.send(json!({ "type": "term-out", "data": data }).to_string());
        }
        // a one-shot command (an install) or a failure keeps its output on screen; a detach just closes
        // never block holding the child: closing the page kills it through the same lock
        let mut code = 1;
        for _ in 0..100 {
            match child.lock().unwrap().try_wait() { Ok(Some(s)) => { code = s.exit_code(); break; } Ok(None) => {}, Err(_) => break }
            if !open.load(Ordering::SeqCst) { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if open.load(Ordering::SeqCst) {
            let reason = if keep || code != 0 { "Ended" } else { "Detached" };
            let _ = out.send(json!({ "type": "term-exit", "reason": reason, "code": code }).to_string());
        }
    });
    Some(term)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_characters_wait_for_their_other_half() {
        let mut s = Utf8Stream::default();
        let bytes = "→ok".as_bytes(); // → is 3 bytes
        assert_eq!(s.push(&bytes[..2]), "");
        assert_eq!(s.push(&bytes[2..]), "→ok");
        assert_eq!(s.push(&[0xff, b'a']), "\u{FFFD}a");
    }
}

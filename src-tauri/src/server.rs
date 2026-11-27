//! The page's API on 127.0.0.1:4003: the same routes and messages the Node server had, so the
//! page is unchanged. Only this Mac and only DevDock's own page: the Host check stops DNS
//! rebinding, the Origin check stops other websites (a form POST or a WebSocket needs no CORS),
//! and the key (auth.rs) stops other processes on this Mac.
use crate::state::ctx;
use crate::util::{find_bin, pid_of, run, secs, shq, ApiErr, Get};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Request};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

/// 4003, or DEVDOCK_PORT (a second copy side by side, for tests)
pub fn port() -> u16 {
    static P: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *P.get_or_init(|| std::env::var("DEVDOCK_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4003))
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        (StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(json!({ "error": self.msg }))).into_response()
    }
}

type R = Result<Json<Value>, ApiErr>;

fn own(headers: &HeaderMap) -> bool {
    let p = port();
    let ok = |v: &str| v == format!("localhost:{p}") || v == format!("127.0.0.1:{p}");
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    ok(host) && origin.is_none_or(|o| ok(o.trim_start_matches("http://")))
}

async fn guard(req: Request, next: Next) -> Response {
    if !own(req.headers()) { return StatusCode::FORBIDDEN.into_response(); }
    if !crate::auth::allows(req.uri().path(), req.headers()) { return (StatusCode::UNAUTHORIZED, "DevDock is locked").into_response(); }
    // demo pids are made up and may match real processes: never act on them
    let p = req.uri().path();
    if ctx().demo && (["/api/kill", "/api/restart", "/api/logs", "/api/start-server"].iter().any(|x| p.starts_with(x))
        || (p.starts_with("/api/sources/") && !p.starts_with("/api/sources/home/"))) {
        return ApiErr::new(403, "Disabled in demo mode").into_response();
    }
    next.run(req).await
}

/// express.json(): a JSON object body, or {} when there's none or it isn't JSON
fn body(b: &Bytes) -> Value {
    serde_json::from_slice::<Value>(b).ok().filter(|v| v.is_object()).unwrap_or_else(|| json!({}))
}

pub fn router() -> Router {
    Router::new()
        .route("/", get(root))
        .route("/history", get(|| file(ctx().res.join("views/history.html"))))
        .route("/lock", get(|| file(ctx().res.join("views/lock.html"))))
        .route("/lock/icon.png", get(|| file(ctx().res.join("assets/icon.png"))))
        .route("/__auth/{key}", get(enter))
        .route("/api/ping", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/ports", get(ports))
        .route("/api/version", get(|| async { let c = ctx(); Json(json!({ "version": c.version, "build": c.build })) }))
        .route("/api/update", get(|| async { crate::update::check().await.map(Json) }))
        .route("/api/update/install", post(|| async { crate::update::install().await.map(Json) }))
        .route("/api/health", get(|| async { Json(json!(ctx().scanner.health())) }))
        .route("/api/health/{port}", get(health_one))
        .route("/api/kill/{pid}", post(kill))
        .route("/api/restart/{pid}", post(restart))
        .route("/api/start-server", post(start_server))
        .route("/api/open-terminal", post(open_terminal))
        .route("/api/app-icon/{pid}", get(app_icon))
        .route("/api/machines/{id}/picture", get(picture))
        .route("/api/sources/{id}/open-in-terminal", post(open_in_terminal))
        .route("/api/sources/{id}/{action}", post(source_action))
        .route("/api/logs/{pid}", get(logs))
        .route("/api/editors", get(|| async { Json(json!(if ctx().demo { vec!["Visual Studio Code".to_string(), "Cursor".into()] } else { installed_editors() })) }))
        .route("/api/open-editor", post(open_editor))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/favorites/{port}", post(add_favorite).delete(remove_favorite))
        .route("/api/history", delete(clear_history))
        .route("/api/history/{port}", delete(forget_history))
        .route("/api/runtimes", get(runtimes))
        .fallback(get(static_file))
        .layer(axum::extract::DefaultBodyLimit::max(1 << 20)) // machine pictures arrive as small data URLs
        .layer(middleware::from_fn(guard))
}

pub async fn serve() {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port())).await {
        Ok(l) => l,
        Err(e) => { eprintln!("DevDock: port {} is taken ({e})", port()); return; }
    };
    let _ = axum::serve(listener, router()).await;
}

/// The window, just unlocked, shows the key once and gets it back as a cookie
async fn enter(Path(k): Path<String>) -> Response {
    if !crate::auth::valid(&k) { return Redirect::to("/lock").into_response(); }
    ([(header::SET_COOKIE, crate::auth::cookie(&k))], Redirect::to("/")).into_response()
}

// ── static files ─────────────────────────────────────────────────────
fn mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8", "js" => "text/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "json" => "application/json", "svg" => "image/svg+xml", "png" => "image/png", "ico" => "image/x-icon",
        "woff2" => "font/woff2", "woff" => "font/woff", "map" => "application/json", _ => "application/octet-stream",
    }
}

/// A file; a big one may ship only gzipped (file.gz) and is sent as such
async fn file(path: std::path::PathBuf) -> Response {
    let (bytes, gz) = match tokio::fs::read(&path).await {
        Ok(b) => (b, false),
        Err(_) => match tokio::fs::read(format!("{}.gz", path.display())).await { Ok(b) => (b, true), Err(_) => return StatusCode::NOT_FOUND.into_response() },
    };
    let mut r = Response::new(Body::from(bytes));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&path)));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if gz { r.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip")); }
    r
}

async fn static_file(req: Request) -> Response {
    let p = req.uri().path().trim_start_matches('/');
    let p = percent_decode(p);
    if p.split('/').any(|s| s == ".." || s.starts_with('.')) { return StatusCode::NOT_FOUND.into_response(); }
    let mut path = ctx().res.join("public").join(&p);
    if p.is_empty() || p.ends_with('/') { path = path.join("index.html"); }
    file(path).await
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "/" is the page, or the WebSocket the page opens on the same address
async fn root(req: Request) -> Response {
    let (mut parts, _) = req.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws.on_upgrade(socket),
        Err(_) => file(ctx().res.join("public/index.html")).await,
    }
}

// ── ports ────────────────────────────────────────────────────────────
async fn ports() -> Json<Value> {
    let c = ctx();
    if c.ports().is_empty() && c.table().is_empty() { c.scan().await; }
    Json(c.payload())
}

async fn health_one(Path(port): Path<String>) -> R {
    let port: u16 = port.parse().ok().filter(|p| *p > 0).ok_or_else(|| ApiErr::bad("Invalid port"))?;
    Ok(Json(json!({ "port": port, "status": crate::ports::check_health(port).await })))
}

fn pid_param(pid: &str) -> Result<i32, ApiErr> {
    pid_of(&json!(pid)).ok_or_else(|| ApiErr::bad("Invalid PID"))
}

async fn kill(Path(pid): Path<String>) -> R {
    let n = pid_param(&pid)?;
    if n == std::process::id() as i32 { return Err(ApiErr::bad("Refusing to kill DevDock itself")); }
    if unsafe { libc::kill(n, libc::SIGTERM) } != 0 {
        let e = std::io::Error::last_os_error();
        return Err(ApiErr::new(500, format!("Failed to kill PID {pid}: {e}")));
    }
    tokio::spawn(async { tokio::time::sleep(std::time::Duration::from_millis(150)).await; ctx().poke_ports(); });
    Ok(Json(json!({ "success": true, "pid": pid, "message": format!("Process {pid} killed") })))
}

async fn restart(Path(pid): Path<String>) -> R {
    let n = pid_param(&pid)?;
    if unsafe { libc::kill(n, libc::SIGHUP) } != 0 {
        return Err(ApiErr::new(500, format!("Failed to restart PID {pid}: {}", std::io::Error::last_os_error())));
    }
    Ok(Json(json!({ "success": true, "pid": pid, "message": format!("SIGHUP sent to {pid}") })))
}

fn dir_param(b: &Value) -> Result<String, ApiErr> {
    let dir = b.str_of("path");
    if !dir.starts_with('/') { return Err(ApiErr::bad("Invalid path")); }
    if !std::path::Path::new(dir).exists() { return Err(ApiErr::gone("Directory not found")); }
    Ok(dir.to_string())
}

/// Terminal.app runs this command in a new window; it rides as an argument, never as script text
pub async fn in_terminal_app(cmd: &str) -> bool {
    run("/usr/bin/osascript", &["-e", "on run argv", "-e", "tell application \"Terminal\"", "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", cmd], secs(15)).await.code == 0
}

async fn start_server(b: Bytes) -> R {
    let dir = dir_param(&body(&b))?;
    let pkg: Value = std::fs::read_to_string(std::path::Path::new(&dir).join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let cmd = if pkg["scripts"]["dev"].is_string() { "npm run dev" } else { "npm start" };
    if !in_terminal_app(&format!("cd {} && {cmd}", shq(&dir))).await { return Err(ApiErr::new(500, "Failed to start server")); }
    Ok(Json(json!({ "success": true, "command": cmd })))
}

async fn open_terminal(b: Bytes) -> R {
    let dir = dir_param(&body(&b))?;
    if run("/usr/bin/open", &["-a", "Terminal", &dir], secs(10)).await.code != 0 { return Err(ApiErr::new(500, "Failed to open terminal")); }
    Ok(Json(json!({ "success": true })))
}

// ── sources ──────────────────────────────────────────────────────────
async fn source_action(Path((id, action)): Path<(String, String)>, b: Bytes) -> Response {
    let c = ctx();
    match c.sources.action(c, &id, &action, &body(&b)).await {
        Ok(mut v) => {
            if !v.is_object() { v = json!({}); }
            let mut out = json!({ "ok": true });
            for (k, x) in v.as_object().unwrap() { out[k] = x.clone(); }
            Json(out).into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// The command a source would run inside DevDock, in a new Terminal window instead
async fn open_in_terminal(Path(id): Path<String>, b: Bytes) -> R {
    let c = ctx();
    let spec = c.sources.terminal(c, &id, &body(&b)).await?.ok_or_else(|| ApiErr::gone("Nothing to open"))?;
    let cmd = std::iter::once(&spec.file).chain(&spec.args).map(|s| shq(s)).collect::<Vec<_>>().join(" ");
    if !in_terminal_app(&cmd).await { return Err(ApiErr::new(500, "Failed to open Terminal")); }
    Ok(Json(json!({ "ok": true })))
}

async fn app_icon(Path(pid): Path<String>) -> Response {
    let c = ctx();
    match c.sources.apps.icon(c, &pid).await {
        Some(f) => { let mut r = file(f).await; r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=86400")); r }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn picture(Path(id): Path<String>) -> Response {
    match ctx().sources.machines.picture_path(&id) { Some(f) => file(f).await, None => StatusCode::NOT_FOUND.into_response() }
}

// ── logs ─────────────────────────────────────────────────────────────
/// stdout/stderr of a process when they go to files (agents' background tasks do).
/// Terminal-attached processes only report their tty: their output isn't readable from outside.
async fn logs(Path(pid): Path<String>) -> R {
    let n = pid_param(&pid)?;
    // in tmux the output is the pane itself
    let pane = ctx().ports().into_iter().find(|p| p["pid"] == json!(pid) && p["tmux"].is_object()).map(|p| p["tmux"]["target"].as_str().unwrap_or("").to_string());
    if let Some(target) = pane {
        let tmux = find_bin("tmux").unwrap_or_else(|| "tmux".into());
        let o = run(&tmux, &["capture-pane", "-p", "-J", "-S", "-500", "-t", &format!("={target}")], secs(5)).await;
        if o.code != 0 { return Ok(Json(json!({ "pid": pid, "logs": [], "tty": null }))); }
        return Ok(Json(json!({ "pid": pid, "logs": [{ "file": format!("tmux pane {target}"), "text": format!("{}\n", o.stdout.trim_end_matches('\n')) }] })));
    }
    let fds = crate::fds::describe(n, &[1, 2]);
    let mut files: Vec<String> = vec![];
    for f in &fds { if f.kind == "REG" { if let Some(p) = &f.path { if p.starts_with('/') && !files.contains(p) { files.push(p.clone()); } } } }
    let tty = fds.iter().find(|f| f.kind == "CHR" && f.path.as_deref().is_some_and(|p| p.starts_with("/dev/tty"))).and_then(|f| f.path.clone());
    const MAX: u64 = 64 * 1024;
    let logs: Vec<Value> = files.iter().map(|f| match tail(f, MAX) {
        Ok((size, text)) => json!({ "file": f, "size": size, "text": text }),
        Err(e) => json!({ "file": f, "error": e.to_string() }),
    }).collect();
    let piped = files.is_empty() && tty.is_none() && fds.iter().any(|f| f.kind == "PIPE");
    Ok(Json(json!({ "pid": pid, "logs": logs, "tty": tty, "piped": piped })))
}

/// The last `max` bytes of a file
pub fn tail(path: &str, max: u64) -> std::io::Result<(u64, String)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let len = size.min(max);
    f.seek(SeekFrom::Start(size - len))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf)?;
    Ok((size, String::from_utf8_lossy(&buf).into_owned()))
}

// ── editors ──────────────────────────────────────────────────────────
const EDITORS: &[&str] = &["Cursor", "Visual Studio Code", "Zed", "Windsurf", "Sublime Text", "WebStorm", "OpenCode"];

fn installed_editors() -> Vec<String> {
    let dirs = [std::path::PathBuf::from("/Applications"), crate::util::home().join("Applications")];
    EDITORS.iter().filter(|e| dirs.iter().any(|d| d.join(format!("{e}.app")).exists())).map(|e| e.to_string()).collect()
}

async fn open_editor(b: Bytes) -> R {
    let dir = body(&b).str_of("path").to_string();
    if !dir.starts_with('/') || !std::path::Path::new(&dir).exists() { return Err(ApiErr::bad("Invalid path")); }
    let installed = installed_editors();
    let wanted = ctx().settings.get()["editor"].as_str().unwrap_or("").to_string();
    let editor = if installed.contains(&wanted) { wanted } else { installed.first().cloned().ok_or_else(|| ApiErr::gone("No supported editor installed"))? };
    if run("/usr/bin/open", &["-a", &editor, &dir], secs(10)).await.code != 0 { return Err(ApiErr::new(500, format!("Failed to open {editor}"))); }
    Ok(Json(json!({ "success": true, "editor": editor })))
}

// ── settings, favorites, history ─────────────────────────────────────
async fn get_settings() -> Json<Value> {
    let mut s = ctx().settings.get();
    s["home"] = json!(crate::util::home()); // for ~ paths, never persisted
    Json(s)
}

async fn put_settings(b: Bytes) -> Json<Value> {
    let c = ctx();
    let updated = c.settings.patch(&body(&b));
    c.poke_ports();
    c.sources.poke("agents"); // turning agents on or off shows right away
    Json(updated)
}

fn port_param(p: &str) -> Result<u64, ApiErr> { p.parse::<u64>().ok().filter(|x| *x > 0).ok_or_else(|| ApiErr::bad("Invalid port")) }

async fn add_favorite(Path(port): Path<String>) -> R {
    let port = port_param(&port)?;
    let s = ctx().settings.update(|s| {
        let mut f = s["favorites"].as_array().cloned().unwrap_or_default();
        if !f.contains(&json!(port)) { f.push(json!(port)); }
        s["favorites"] = json!(f);
    });
    ctx().poke_ports();
    Ok(Json(json!({ "favorites": s["favorites"] })))
}

async fn remove_favorite(Path(port): Path<String>) -> R {
    let port = port_param(&port)?;
    let s = ctx().settings.update(|s| {
        let f: Vec<Value> = s["favorites"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| *x != json!(port)).collect();
        s["favorites"] = json!(f);
    });
    ctx().poke_ports();
    Ok(Json(json!({ "favorites": s["favorites"] })))
}

async fn clear_history() -> Json<Value> {
    ctx().settings.update(|s| s["history"] = json!([]));
    ctx().broadcast_ports(true);
    Json(json!({ "success": true }))
}

async fn forget_history(Path(port): Path<String>) -> R {
    let port = port_param(&port)?;
    ctx().settings.update(|s| {
        let h: Vec<Value> = s["history"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| x["port"] != json!(port)).collect();
        s["history"] = json!(h);
    });
    ctx().broadcast_ports(true);
    Ok(Json(json!({ "success": true })))
}

async fn runtimes() -> Json<Value> {
    let m: serde_json::Map<String, Value> = crate::settings::RUNTIMES.iter()
        .map(|r| (r.key.to_string(), json!({ "name": r.name, "color": r.color, "icon": r.icon, "commands": r.commands }))).collect();
    Json(Value::Object(m))
}

// ── the page's WebSocket: pushes, and terminals inside DevDock ───────
async fn socket(ws: WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let c = ctx();
    let (mut tx, mut rx) = ws.split();
    let (out, mut outq) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut sub = c.hub.subscribe();
    let mut revoked = crate::auth::revoked();
    if crate::auth::current().is_none() { return; } // locked between the check and here
    c.hub.connect();
    // what's known right now, so the page doesn't wait for a change
    if !c.ports().is_empty() || !c.table().is_empty() { let mut p = c.payload(); p["type"] = json!("ports"); let _ = out.send(p.to_string()); }
    for m in c.sources.latest() { let _ = out.send(m.to_string()); }
    let mut u = crate::update::payload();
    u["type"] = json!("update");
    let _ = out.send(u.to_string());
    let writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                m = outq.recv() => match m { Some(m) => m, None => break },
                m = sub.recv() => match m {
                    Ok(m) => m.to_string(),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                },
            };
            if tx.send(Message::Text(msg.into())).await.is_err() { break; }
        }
    });
    let mut term: Option<crate::term::Term> = None;
    loop {
        let m = tokio::select! {
            m = rx.next() => match m { Some(Ok(m)) => m, _ => break },
            _ = revoked.changed() => break, // locked: the page goes, and so does this
        };
        let Message::Text(t) = m else { continue };
        let Ok(m) = serde_json::from_str::<Value>(&t) else { continue };
        match m.str_of("type") {
            "term-open" if m["source"].is_string() => { term.take(); term = crate::term::open(c, &m, out.clone()).await; }
            "term-in" => if let (Some(t), Some(d)) = (&term, m["data"].as_str()) { t.write(d); },
            "term-resize" => if let Some(t) = &term { t.resize(m["cols"].as_u64().unwrap_or(80) as u16, m["rows"].as_u64().unwrap_or(24) as u16); },
            "term-close" => { term.take(); }
            _ => {}
        }
    }
    drop(term);
    writer.abort();
    c.hub.disconnect();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_this_page() {
        let h = |host: &str, origin: Option<&str>| {
            let mut m = HeaderMap::new();
            m.insert(header::HOST, host.parse().unwrap());
            if let Some(o) = origin { m.insert(header::ORIGIN, o.parse().unwrap()); }
            own(&m)
        };
        assert!(h("localhost:4003", None));
        assert!(h("127.0.0.1:4003", Some("http://localhost:4003")));
        assert!(!h("evil.com:4003", None)); // DNS rebinding
        assert!(!h("localhost:4003", Some("https://evil.com")));
        assert!(!h("localhost:4003", Some("http://localhost:4003.evil.com")));
    }
    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("vendor/xterm/x%20y.js"), "vendor/xterm/x y.js");
        assert_eq!(percent_decode("a%2"), "a%2");
    }
}

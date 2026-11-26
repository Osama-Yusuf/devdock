//! Updates the way Chrome and Sparkle apps do them: DevDock checks the latest GitHub release's
//! latest.json in the background, downloads the new app, verifies its signature against the
//! public key built into this one, and swaps the bundle in place. The page then offers
//! "Restart to update"; quitting normally also lands in the new version. No server needed.
use crate::state::ctx;
use crate::util::{now_ms, ApiErr, ApiResult};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const RELEASES: &str = "https://github.com/Osama-Yusuf/devdock/releases";
const EVERY: Duration = Duration::from_secs(6 * 3600);

static APP: OnceLock<AppHandle> = OnceLock::new();

/// idle | checking | downloading | ready | error, and what the page shows with it
#[derive(Default)]
struct Status { state: &'static str, latest: Option<String>, notes: Option<String>, published: Option<String>, progress: Option<f64>, error: Option<String>, checked: Option<i64> }

fn status() -> &'static Mutex<Status> {
    static S: OnceLock<Mutex<Status>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Status { state: "idle", ..Default::default() }))
}

fn app() -> ApiResult<&'static AppHandle> { APP.get().ok_or_else(|| ApiErr::new(503, "Updates work in the app, not here")) }

fn current() -> String { APP.get().map(|a| a.package_info().version.to_string()).unwrap_or_else(|| ctx().version.clone()) }

/// What /api/update answers and what's pushed to the page as { type: 'update' }
pub fn payload() -> Value {
    let s = status().lock().unwrap();
    let cur = current();
    let latest = s.latest.clone().unwrap_or_else(|| cur.clone());
    json!({
        "current": cur, "latest": latest, "available": s.latest.is_some(), "state": s.state,
        "progress": s.progress, "notes": s.notes, "published": s.published, "error": s.error, "checkedAt": s.checked,
        "canInstall": APP.get().is_some(),
        "url": if s.latest.is_some() { format!("{RELEASES}/tag/v{latest}") } else { format!("{RELEASES}/latest") },
    })
}

fn set(f: impl FnOnce(&mut Status)) {
    f(&mut status().lock().unwrap());
    let mut p = payload();
    p["type"] = json!("update");
    ctx().hub.send(p.to_string());
}

fn auto() -> bool { ctx().settings.get()["autoUpdate"] != json!(false) }

/// The GitHub endpoint from tauri.conf.json; DEVDOCK_UPDATE_URL points a test build at a local
/// latest.json. Either way the download must carry a signature from the built-in key.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    match std::env::var("DEVDOCK_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
        Some(url) => app.updater_builder().endpoints(vec![url])?.build(),
        None => app.updater(),
    }
}

fn busy() -> bool { matches!(status().lock().unwrap().state, "checking" | "downloading" | "ready") }

/// Ask GitHub for a newer release
async fn find() -> ApiResult<Option<tauri_plugin_updater::Update>> {
    let app = app()?;
    set(|s| { s.state = "checking"; s.error = None; });
    let found = match updater(app) {
        // the latest release answered without a latest.json (one from before the updater): nothing to update to
        Ok(u) => match u.check().await { Err(tauri_plugin_updater::Error::ReleaseNotFound) => Ok(None), r => r.map_err(|e| e.to_string()) },
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(u) => {
            set(|s| {
                s.state = "idle"; s.checked = Some(now_ms());
                s.latest = u.as_ref().map(|u| u.version.clone());
                s.notes = u.as_ref().and_then(|u| u.body.clone());
                s.published = u.as_ref().and_then(|u| u.date).map(|d| d.to_string());
            });
            Ok(u)
        }
        Err(e) => {
            let msg = format!("Couldn't check for updates: {e}");
            set(|s| { s.state = "error"; s.error = Some(msg.clone()); s.checked = Some(now_ms()); });
            Err(ApiErr::new(502, msg))
        }
    }
}

/// Check now (Settings, the menu); with automatic updates on, a newer one downloads right away
pub async fn check() -> ApiResult<Value> {
    if !busy() {
        if let Some(u) = find().await? { if auto() { tauri::async_runtime::spawn(async { let _ = download(u).await; }); } }
    }
    Ok(payload())
}

async fn download(update: tauri_plugin_updater::Update) -> ApiResult<()> {
    set(|s| { s.state = "downloading"; s.progress = Some(0.0); });
    let mut got = 0usize;
    let mut last = 0.0;
    let r = update.download_and_install(|chunk, total| {
        got += chunk;
        let p = total.map(|t| (got as f64 / t as f64 * 100.0).floor()).unwrap_or(0.0);
        if p >= last + 5.0 { last = p; set(|s| s.progress = Some(p)); } // every 5%, not every chunk
    }, || {}).await;
    match r {
        Ok(()) => { set(|s| { s.state = "ready"; s.progress = None; }); Ok(()) }
        Err(e) => {
            let msg = format!("The update didn't install: {e}");
            set(|s| { s.state = "error"; s.progress = None; s.error = Some(msg.clone()); });
            Err(ApiErr::new(500, msg))
        }
    }
}

/// Restart into the installed update, downloading it first when automatic updates are off
pub async fn install() -> ApiResult<Value> {
    let app = app()?;
    let state = status().lock().unwrap().state;
    match state {
        "ready" => {}
        "downloading" | "checking" => return Err(ApiErr::new(409, "Still downloading the update")),
        _ => match find().await? {
            Some(u) => download(u).await?,
            None => return Err(ApiErr::new(409, "You're on the latest version")),
        },
    }
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await; // the page gets its answer first
        a.restart();
    });
    Ok(json!({ "restarting": true }))
}

/// A minute after launch, then every 6 hours
pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if !busy() { if let Ok(Some(u)) = find().await { if auto() { let _ = download(u).await; } } }
            tokio::time::sleep(EVERY).await;
        }
    });
}

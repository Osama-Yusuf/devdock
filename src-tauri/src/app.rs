//! The app around the page: one window, the menu bar icon, the menus, and the lock.
//! The window is destroyed when closed, so a hidden DevDock holds no web view at all; the
//! server and the menu bar keep running and a new window opens in a blink.
//!
//! DevDock holds the keys to your machines, so it opens with Touch ID (or the login password)
//! and locks again when the Mac does. Fails closed: the window shows the lock page and the
//! dashboard only loads after Touch ID says yes. ponytail: gates this window only; a browser on
//! localhost:4003 isn't asked, and remote actions still need their own Touch ID.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

static LOCKED: AtomicBool = AtomicBool::new(true);
static ASKING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

fn url(path: &str) -> tauri::Url { format!("http://localhost:{}{path}", crate::server::port()).parse().unwrap() }

/// Show the window, making it if it's gone
fn show(app: &AppHandle) {
    let _ = app.set_dock_visibility(true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        unlock(app);
        return;
    }
    let locked = LOCKED.load(Ordering::SeqCst);
    let handle = app.clone();
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url(if locked { "/lock?asking=1" } else { "/" })))
        .title("DevDock")
        .inner_size(1400.0, 850.0)
        .min_inner_size(800.0, 500.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // y is the height of the area the buttons sit in, not their top (as Electron had it):
        // 21 centres the 16pt buttons in the page's 38px title bar
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 21.0))
        .background_color(tauri::window::Color(11, 14, 19, 255))
        .initialization_script("window.__DEVDOCK_APP__ = true;")
        // nothing but the lock page while locked; the lock page's button asks again
        .on_navigation(move |u| {
            // links away from DevDock open in the browser, not in this window
            let ours = matches!(u.host_str(), Some("localhost" | "127.0.0.1")) && u.port() == Some(crate::server::port());
            if !ours { open_in_browser(u); return false; }
            if u.path() == "/__unlock" { unlock(&handle); return false; }
            !LOCKED.load(Ordering::SeqCst) || u.path() == "/lock" || u.path().starts_with("/lock/")
        })
        // links that open a new window go to the browser
        .on_new_window(|u, _| { open_in_browser(&u); tauri::webview::NewWindowResponse::Deny })
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
        unlock(app);
    }
}

/// http(s) only: a page can't make DevDock open file: or app URL schemes
fn open_in_browser(u: &tauri::Url) {
    if matches!(u.scheme(), "http" | "https") { let _ = std::process::Command::new("/usr/bin/open").arg(u.as_str()).spawn(); }
}

fn unlock(app: &AppHandle) {
    if !LOCKED.load(Ordering::SeqCst) || ASKING.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        let ok = crate::mac::authenticate("unlock");
        ASKING.store(false, Ordering::SeqCst);
        let Some(w) = app.get_webview_window("main") else { return };
        if ok {
            LOCKED.store(false, Ordering::SeqCst);
            let _ = w.navigate(url("/"));
        } else {
            let _ = w.eval("document.querySelectorAll('button').forEach(b => b.disabled = false)");
        }
    });
}

fn lock(app: &AppHandle) {
    if LOCKED.swap(true, Ordering::SeqCst) { return; }
    // the dashboard is gone from the window, not just hidden
    if let Some(w) = app.get_webview_window("main") { let _ = w.navigate(url("/lock")); }
}

/// A menu command for the page (window.devdockCommand), opening the window first if needed
fn command(app: &AppHandle, cmd: &str) {
    let fresh = app.get_webview_window("main").is_none();
    show(app);
    if fresh || LOCKED.load(Ordering::SeqCst) { return; }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.devdockCommand?.({})", serde_json::json!(cmd)));
    }
}

fn quit(app: &AppHandle) { QUITTING.store(true, Ordering::SeqCst); app.exit(0); }

fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let about = PredefinedMenuItem::about(app, Some("About DevDock"), None)?;
    Menu::with_items(app, &[
        &Submenu::with_items(app, "DevDock", true, &[
            &about, &item("update", "Check for Updates…", None)?, &sep()?, &item("settings", "Settings…", Some("Cmd+,"))?, &sep()?,
            &PredefinedMenuItem::services(app, None)?, &sep()?,
            &PredefinedMenuItem::hide(app, None)?, &PredefinedMenuItem::hide_others(app, None)?, &PredefinedMenuItem::show_all(app, None)?, &sep()?,
            &item("quit", "Quit DevDock", Some("Cmd+Q"))?,
        ])?,
        &Submenu::with_items(app, "File", true, &[&item("export", "Export…", Some("Shift+Cmd+E"))?, &sep()?, &PredefinedMenuItem::close_window(app, None)?])?,
        &Submenu::with_items(app, "Edit", true, &[
            &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?, &sep()?,
            &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "View", true, &[
            &item("find", "Find", Some("Cmd+F"))?, &sep()?,
            &item("tab-home", "Home", Some("Cmd+1"))?, &item("tab-servers", "Ports", Some("Cmd+2"))?,
            &item("tab-sessions", "Sessions", Some("Cmd+3"))?, &item("tab-containers", "Containers", Some("Cmd+4"))?,
            &item("tab-apps", "Apps", Some("Cmd+5"))?, &item("tab-coding", "Agents", Some("Cmd+6"))?,
            &item("tab-machines", "Machines", Some("Cmd+7"))?, &sep()?,
            &item("group-menu", "Next Grouping", Some("Shift+Cmd+G"))?, &sep()?,
            &item("theme", "Toggle Appearance", Some("Shift+Cmd+L"))?, &sep()?,
            &item("reload", "Reload", Some("Cmd+R"))?, &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ])?,
        &Submenu::with_items(app, "Go", true, &[&item("back", "Dashboard", Some("Cmd+["))?, &item("history", "History", Some("Cmd+Y"))?])?,
        &Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?,
        &Submenu::with_items(app, "Help", true, &[&item("help", "Keyboard Shortcuts   ?", None)?])?,
    ])
}

fn listeners(n: usize) -> String { format!("DevDock: {n} listener{}", if n == 1 { "" } else { "s" }) }

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let count = MenuItem::with_id(app, "count", listeners(0), false, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Launch at Startup", true, crate::mac::launch_at_login(), None::<&str>)?;
    let menu = Menu::with_items(app, &[
        &count, &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-history", "Open History", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?, &login, &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "Quit DevDock", true, None::<&str>)?,
    ])?;
    let res = crate::state::ctx().res.join("assets/trayTemplate@2x.png");
    let icon = tauri::image::Image::from_path(&res).unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
    let t = TrayIconBuilder::with_id("tray").icon(icon).icon_as_template(true).menu(&menu).show_menu_on_left_click(true).tooltip("DevDock").build(app)?;
    // the count, refreshed from the scan DevDock already runs
    let login2 = login.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = usize::MAX;
        loop {
            let n = crate::state::ctx().ports().len();
            if n != last { last = n; let _ = count.set_text(listeners(n)); let _ = t.set_tooltip(Some(listeners(n))); }
            let _ = login2.set_checked(crate::mac::launch_at_login());
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => quit(app),
        "show" => show(app),
        "open-history" => { show(app); if !LOCKED.load(Ordering::SeqCst) { if let Some(w) = app.get_webview_window("main") { let _ = w.navigate(url("/history")); } } }
        "login" => { let _ = crate::mac::set_launch_at_login(!crate::mac::launch_at_login()); }
        "reload" => if let Some(w) = app.get_webview_window("main") { let _ = w.eval("location.reload()"); },
        "count" => {}
        cmd => command(app, cmd),
    }
}

/// Where public/, views/ and the helpers live: the bundle's Resources, or the repo in development
fn resources(app: &AppHandle) -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("DEVDOCK_RES") { return p.into(); }
    match app.path().resource_dir() {
        Ok(r) if r.join("public/index.html").exists() => r,
        _ => std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf(),
    }
}

/// Data dir, settings file and demo flag, with the same env overrides the Node app had
fn start(res: std::path::PathBuf) -> &'static crate::state::Ctx {
    let data: std::path::PathBuf = std::env::var_os("DEVDOCK_DATA").map(Into::into).unwrap_or_else(|| crate::util::home().join("Library/Application Support/DevDock"));
    let settings = std::env::var_os("DEVDOCK_SETTINGS").map(Into::into).unwrap_or_else(|| data.join("devdock-settings.json"));
    let c = crate::state::init(res, data, settings, std::env::var("DEVDOCK_DEMO").as_deref() == Ok("1"));
    tauri::async_runtime::spawn(c.ports_loop());
    tauri::async_runtime::spawn(c.housekeeping());
    for id in crate::sources::IDS { tauri::async_runtime::spawn(c.sources.run(c, id)); }
    c
}

/// `DevDock serve`: the backend alone, no window (tests, and a browser on localhost)
pub fn serve() {
    let res = std::env::var_os("DEVDOCK_RES").map(Into::into).unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    tauri::async_runtime::block_on(async move { start(res); crate::server::serve().await });
}

pub fn run() {
    match std::env::args().nth(1).as_deref() {
        Some("serve") => return serve(),
        // an agent run, inside its tmux session (sources/agents.rs starts these)
        Some("run-agent") => return crate::runner::main(&std::env::args().nth(2).unwrap_or_default()),
        _ => {}
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let h = app.handle().clone();
            start(resources(&h));
            crate::update::start(h.clone());
            crate::state::set_notifier(crate::mac::notify);
            tauri::async_runtime::spawn(crate::server::serve());
            app.set_menu(app_menu(&h)?)?;
            app.on_menu_event(|app, e| on_menu(app, e.id().as_ref()));
            tray(&h)?;
            let lh = h.clone();
            crate::mac::on_lock(move || lock(&lh));
            show(&h);
            Ok(())
        })
        .on_window_event(|w, e| {
            // closing the window frees its web view; DevDock keeps running in the menu bar
            if let WindowEvent::Destroyed = e { let _ = w.app_handle().set_dock_visibility(false); }
        })
        .build(tauri::generate_context!())
        .expect("DevDock failed to start")
        .run(|app, e| match e {
            RunEvent::ExitRequested { api, code: None, .. } if !QUITTING.load(Ordering::SeqCst) => api.prevent_exit(),
            RunEvent::Reopen { .. } => show(app),
            _ => {}
        });
}

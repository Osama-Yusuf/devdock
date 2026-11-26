//! macOS bits the shell needs: Touch ID, Launch at Login, and knowing when the Mac locks.
use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSDistributedNotificationCenter, NSError, NSNotification, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use std::ptr::NonNull;

/// Touch ID, or the login password when there's no sensor or the lid is closed. The prompt reads
/// "DevDock is trying to <reason>". Blocks until answered; true only when it's you.
pub fn authenticate(reason: &str) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let ctx = unsafe { LAContext::new() };
    let reply = RcBlock::new(move |ok: Bool, _err: *mut NSError| { let _ = tx.send(ok.as_bool()); });
    unsafe { ctx.evaluatePolicy_localizedReason_reply(LAPolicy::DeviceOwnerAuthentication, &NSString::from_str(reason), &reply) };
    rx.recv().unwrap_or(false)
}

pub fn launch_at_login() -> bool {
    unsafe { SMAppService::mainAppService().status() == SMAppServiceStatus::Enabled }
}

pub fn set_launch_at_login(on: bool) -> Result<(), String> {
    let s = unsafe { SMAppService::mainAppService() };
    let r = unsafe { if on { s.registerAndReturnError() } else { s.unregisterAndReturnError() } };
    r.map_err(|e| e.localizedDescription().to_string())
}

/// Calls `f` when the screen locks or the Mac goes to sleep. Lives as long as the app.
pub fn on_lock(f: impl Fn() + 'static) {
    let f = std::rc::Rc::new(f);
    let block = { let f = f.clone(); RcBlock::new(move |_: NonNull<NSNotification>| f()) };
    unsafe {
        let center = NSDistributedNotificationCenter::defaultCenter();
        let _ = center.addObserverForName_object_queue_usingBlock(Some(&NSString::from_str("com.apple.screenIsLocked")), None, None, &block);
        let ws = objc2_app_kit::NSWorkspace::sharedWorkspace().notificationCenter();
        let sleep = RcBlock::new(move |_: NonNull<NSNotification>| f());
        let _ = ws.addObserverForName_object_queue_usingBlock(Some(objc2_app_kit::NSWorkspaceWillSleepNotification), None, None, &sleep);
    }
}

/// A banner from DevDock in Notification Center. macOS asks once whether DevDock may notify;
/// outside an app bundle (cargo run, `serve`) there's no Notification Center, so nothing shows.
pub fn notify(title: &str, body: &str) {
    use objc2_foundation::{NSBundle, NSUUID};
    use objc2_user_notifications::{UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter};
    static ASKED: std::sync::Once = std::sync::Once::new();
    if NSBundle::mainBundle().bundleIdentifier().is_none() { return; }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    ASKED.call_once(|| {
        let done = RcBlock::new(|_: Bool, _: *mut NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &done);
    });
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSUUID::new().UUIDString(), &content, None);
    center.addNotificationRequest_withCompletionHandler(&req, None);
}

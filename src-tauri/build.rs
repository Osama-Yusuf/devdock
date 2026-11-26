fn main() {
    // tauri.conf.json takes its version from package.json; without this a version bump alone
    // leaves the old version compiled in, and the updater would offer the same release forever
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}

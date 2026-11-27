//! Settings: one JSON file, kept in memory and written through on change.
//! The page owns most keys; unknown keys are kept as they are.
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Runtime {
    pub key: &'static str,
    pub name: &'static str,
    pub commands: &'static [&'static str],
    pub color: &'static str,
    pub icon: &'static str,
    pub default_enabled: bool,
}

macro_rules! rt {
    ($k:expr, $n:expr, [$($c:expr),*], $col:expr, $i:expr, $on:expr) => {
        Runtime { key: $k, name: $n, commands: &[$($c),*], color: $col, icon: $i, default_enabled: $on }
    };
}

pub const RUNTIMES: &[Runtime] = &[
    rt!("node", "Node.js", ["node"], "#22c55e", "N", true),
    rt!("python", "Python", ["python", "python3", "python3.", "uvicorn", "gunicorn", "flask", "django"], "#3b82f6", "Py", true),
    rt!("ruby", "Ruby", ["ruby", "puma", "rails", "unicorn", "thin"], "#ef4444", "Rb", true),
    rt!("java", "Java", ["java"], "#f97316", "J", true),
    rt!("go", "Go", ["go", "Google"], "#06b6d4", "Go", true),
    rt!("php", "PHP", ["php", "php-fpm"], "#8b5cf6", "PHP", true),
    rt!("rust", "Rust", ["cargo"], "#f97316", "Rs", true),
    rt!("dotnet", ".NET", ["dotnet"], "#7c3aed", ".N", true),
    rt!("docker", "Docker", ["com.docke", "docker-pr", "docker"], "#0ea5e9", "D", true),
    rt!("nginx", "Nginx", ["nginx"], "#10b981", "Nx", false),
    rt!("apache", "Apache", ["httpd", "apache2", "apache"], "#dc2626", "Ap", false),
    rt!("postgres", "PostgreSQL", ["postgres", "postmaste"], "#3b82f6", "PG", true),
    rt!("mysql", "MySQL", ["mysqld", "mysql", "mariadbd", "mariadb"], "#f59e0b", "My", true),
    rt!("redis", "Redis", ["redis-ser", "redis"], "#ef4444", "Rd", true),
    rt!("mongo", "MongoDB", ["mongod", "mongos"], "#22c55e", "Mo", true),
    rt!("other", "Other", [], "#6b7280", "?", false),
];

pub fn runtime(key: &str) -> &'static Runtime {
    RUNTIMES.iter().find(|r| r.key == key).unwrap_or(&RUNTIMES[RUNTIMES.len() - 1])
}

/// Which runtime a process name belongs to: an exact or prefix match of one of its commands
pub fn identify_runtime(command: &str) -> &'static str {
    let cmd = command.to_lowercase();
    RUNTIMES.iter().filter(|r| r.key != "other")
        .find(|r| r.commands.iter().any(|p| { let p = p.to_lowercase(); cmd == p || cmd.starts_with(&p) }))
        .map(|r| r.key).unwrap_or("other")
}

pub fn defaults() -> Value {
    let runtimes: Map<String, Value> = RUNTIMES.iter().map(|r| (r.key.to_string(), json!({ "enabled": r.default_enabled }))).collect();
    json!({
        "runtimes": runtimes,
        "showOtherProcesses": false,
        "showExport": false,
        "tabLabels": "both",
        "favorites": [],
        "theme": "dark",
        "notifications": true,
        "groupByProject": false,
        "groupingDepth": 1,
        "showHistory": true,
        "history": [],
        "idleAfterHours": 24,
        "autoKillIdle": false,
        "autoUpdate": true,
        "tmuxOpen": "devdock",
        "editor": "",
        "agentsEnabled": false,
        "agent": "",
        "agentReadOnly": false,
        "usageHistory": true,
        "usageDays": 1,
    })
}

/// Defaults under what was saved; runtimes missing from the file get their default
fn merged(saved: Value) -> Value {
    let mut out = defaults();
    let Value::Object(saved) = saved else { return out };
    let default_rts = out["runtimes"].clone();
    for (k, v) in saved { out[k] = v; }
    if !out["runtimes"].is_object() { out["runtimes"] = json!({}); }
    for (k, v) in default_rts.as_object().unwrap() {
        if !out["runtimes"].get(k).is_some_and(|x| x.is_object()) { out["runtimes"][k] = v.clone(); }
    }
    out
}

pub struct Settings { file: PathBuf, cur: Mutex<Value> }

impl Settings {
    pub fn load(file: PathBuf) -> Self {
        let saved = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        Settings { file, cur: Mutex::new(merged(saved)) }
    }

    pub fn get(&self) -> Value { self.cur.lock().unwrap().clone() }

    /// Change the settings and write them; returns the new settings
    pub fn update(&self, f: impl FnOnce(&mut Value)) -> Value {
        let mut cur = self.cur.lock().unwrap();
        f(&mut cur);
        let tmp = self.file.with_extension("json.tmp");
        if let Some(dir) = self.file.parent() { let _ = std::fs::create_dir_all(dir); }
        if std::fs::write(&tmp, serde_json::to_string_pretty(&*cur).unwrap_or_default()).is_ok() { let _ = std::fs::rename(&tmp, &self.file); }
        cur.clone()
    }

    /// PUT /api/settings: shallow merge, runtimes merged per runtime
    pub fn patch(&self, body: &Value) -> Value {
        self.update(|cur| {
            let Value::Object(b) = body else { return };
            for (k, v) in b {
                if k == "runtimes" {
                    let Value::Object(rts) = v else { continue };
                    for (rk, rv) in rts {
                        let mut merged = cur["runtimes"].get(rk).cloned().filter(|x| x.is_object()).unwrap_or(json!({}));
                        if let Value::Object(o) = rv { for (a, b) in o { merged[a] = b.clone(); } }
                        cur["runtimes"][rk] = merged;
                    }
                } else if k != "home" {
                    cur[k] = v.clone();
                }
            }
        })
    }

    pub fn runtime_enabled(&self, key: &str) -> bool {
        self.cur.lock().unwrap()["runtimes"][key]["enabled"].as_bool().unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtimes_match_like_lsof_names_did() {
        for (name, rt) in [("node", "node"), ("python3.12", "python"), ("com.docker.backend", "docker"), ("com.docke", "docker"),
            ("postmaster", "postgres"), ("redis-server", "redis"), ("Google Chrome", "go"), ("ControlCenter", "other"), ("mysqld", "mysql")] {
            assert_eq!(identify_runtime(name), rt, "{name}");
        }
    }

    #[test]
    fn load_merge_patch_and_persist() {
        let f = std::env::temp_dir().join(format!("dd-settings-{}.json", std::process::id()));
        std::fs::write(&f, r#"{"tabLabels":"icons","runtimes":{"node":{"enabled":false}},"custom":1}"#).unwrap();
        let s = Settings::load(f.clone());
        let v = s.get();
        assert_eq!(v["tabLabels"], "icons");
        assert_eq!(v["custom"], 1);
        assert_eq!(v["runtimes"]["node"]["enabled"], false);
        assert_eq!(v["runtimes"]["nginx"]["enabled"], false); // default filled in
        assert_eq!(v["idleAfterHours"], 24);
        assert!(!s.runtime_enabled("node"));
        s.patch(&json!({ "theme": "light", "runtimes": { "node": { "enabled": true } }, "home": "/x" }));
        let again = Settings::load(f.clone()).get();
        assert_eq!(again["theme"], "light");
        assert_eq!(again["runtimes"]["node"]["enabled"], true);
        assert!(again.get("home").is_none());
        std::fs::remove_file(f).unwrap();
        // a missing or broken file is the defaults
        assert_eq!(Settings::load("/nonexistent/x.json".into()).get(), defaults());
    }
}

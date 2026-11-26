//! Seeded data for README screenshots (DEVDOCK_DEMO=1). demo.json is the seeded data frozen with the
//! clock at T0 and home at /HOME; each read shifts the times to now and the paths to your home.
//! Every row still goes through the real UI; only the scans are replaced.
use crate::ports::Snapshot;
use crate::table::Table;
use crate::util::{home, now_ms};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

const T0: f64 = 4e12;
const SPAN: f64 = 1e11; // ~3 years either side of T0 is a time; nothing else in the data comes close

fn data() -> &'static Value {
    static D: OnceLock<Value> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(include_str!("demo.json")).expect("demo.json"))
}

fn shift(v: &Value, now: f64, home: &str) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(x) if (x - T0).abs() < SPAN => json!((now + (x - T0)) as i64),
            _ => v.clone(),
        },
        Value::String(s) if s.starts_with("/HOME") => json!(format!("{home}{}", &s[5..])),
        Value::String(s) if s.contains("/HOME/") => json!(s.replace("/HOME/", &format!("{home}/"))),
        Value::Array(a) => Value::Array(a.iter().map(|x| shift(x, now, home)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), shift(x, now, home))).collect()),
        _ => v.clone(),
    }
}

pub fn get(key: &str) -> Value { shift(&data()[key], now_ms() as f64, &home().to_string_lossy()) }

pub fn table() -> Arc<Table> { Arc::new(Table::new()) }

/// The demo servers, with their runtime's name and colour, and their health
pub fn ports() -> (Snapshot, HashMap<u16, String>) {
    let mut health = HashMap::new();
    let ports = get("ports").as_array().cloned().unwrap_or_default().into_iter().map(|mut p| {
        if let Some(rt) = p["runtime"].as_str().map(crate::settings::runtime) {
            p["runtimeName"] = json!(rt.name);
            p["runtimeColor"] = json!(rt.color);
            p["runtimeIcon"] = json!(rt.icon);
        }
        if let (Some(port), Some(h)) = (p["port"].as_u64(), p["_health"].as_str()) { health.insert(port as u16, h.to_string()); p["health"] = json!(h); }
        p.as_object_mut().unwrap().remove("_health");
        p
    }).collect();
    (Snapshot { timestamp: crate::ports::iso(now_ms()), ports }, health)
}

pub fn sessions() -> Value { get("sessions") }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn times_follow_the_clock_and_paths_follow_home() {
        let v = shift(&json!({ "at": T0 - 60_000.0, "size": 2.4e9, "cwd": "/HOME/code/x", "cmd": "cd /HOME/a && ls" }), 1_000_000.0, "/Users/me");
        assert_eq!(v, json!({ "at": 940_000, "size": 2.4e9, "cwd": "/Users/me/code/x", "cmd": "cd /Users/me/a && ls" }));
        let (snap, health) = ports();
        assert_eq!(snap.ports.len(), 8);
        assert!(snap.ports.iter().all(|p| p["runtimeName"].is_string() && p.get("_health").is_none()));
        assert_eq!(health[&5432], "unreachable");
        let s = sessions();
        assert!(s["sessions"][0]["lastActive"].as_i64().unwrap() > now_ms() - 60_000);
    }
}

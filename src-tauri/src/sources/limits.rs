//! Plan limits for Claude Code and Codex: how much of each window is used, and when it resets.
//!   Claude: Claude Code's login (Keychain, else ~/.claude/.credentials.json) -> the usage call /usage makes
//!   Codex:  ~/.codex/auth.json -> ChatGPT's usage call; else the last snapshot in Codex's session logs
//! Tokens are only read and only sent to their own provider. Never refreshed: that would rotate the CLI's login.
use crate::state::Ctx;
use crate::util::{home, now_ms, run, secs, ApiResult};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CLAUDE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Default)]
pub struct Limits { last: Mutex<Option<Value>> }

/// A number as JS writes it: whole numbers without ".0"
fn num(x: f64) -> Value { if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) } }

/// Number(x) || 0
fn number(v: &Value) -> f64 {
    let x = match v { Value::Number(n) => n.as_f64().unwrap_or(0.0), Value::String(s) => s.trim().parse().unwrap_or(0.0), Value::Bool(b) => *b as u8 as f64, _ => 0.0 };
    if x.is_nan() { 0.0 } else { x }
}

/// Seconds or ms or an ISO date, as ms
fn ms(t: &Value) -> Value {
    match t {
        Value::Number(n) => n.as_f64().map(|x| num(if x < 1e12 { x * 1000.0 } else { x })).unwrap_or(Value::Null),
        Value::String(s) if !s.is_empty() => crate::detect::parse_time(s).filter(|x| *x != 0).map(|x| json!(x)).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn window_label(sec: f64) -> String {
    if sec == 18000.0 { "5-hour".into() } else if sec == 604800.0 { "Weekly".into() }
    else if sec != 0.0 && !sec.is_nan() { format!("{}-hour", (sec / 3600.0).round()) } else { "Limit".into() }
}

fn limit(label: impl Into<String>, used: &Value, resets: &Value) -> Value { json!({ "label": label.into(), "used": num(number(used)), "resetsAt": ms(resets) }) }

/// A window whose reset time has passed starts again from zero
fn fresh(mut l: Value, now: i64) -> Value {
    if l["resetsAt"].as_f64().is_some_and(|r| r != 0.0 && r < now as f64) { l["used"] = json!(0); l["resetsAt"] = Value::Null; }
    l
}

/// The usage response: per-model `limits`, or the older five_hour / seven_day fields
pub fn claude_limits(d: &Value) -> Vec<Value> {
    if let Some(list) = d["limits"].as_array().filter(|l| !l.is_empty()) {
        return list.iter().map(|l| {
            let name = [&l["scope"]["model"]["display_name"], &l["scope"]["surface"]["display_name"]].into_iter()
                .filter_map(|v| v.as_str()).find(|s| !s.is_empty());
            let kind = match &l["kind"] { Value::Null | Value::Bool(false) => String::new(), Value::String(s) => s.clone(), v => v.to_string() };
            let label = match kind.as_str() {
                "session" => "5-hour".to_string(),
                "weekly_all" => "Weekly".to_string(),
                k if k.starts_with("weekly") => format!("Weekly {}", name.unwrap_or("")).trim().to_string(),
                k => name.map(String::from).unwrap_or_else(|| if k.is_empty() { "Limit".into() } else { k.into() }),
            };
            limit(label, &l["percent"], &l["resets_at"])
        }).collect();
    }
    [("five_hour", "5-hour"), ("seven_day", "Weekly"), ("seven_day_opus", "Weekly Opus"), ("seven_day_sonnet", "Weekly Sonnet")].iter()
        .filter(|(k, _)| d[*k].is_object()).map(|(k, label)| limit(*label, &d[*k]["utilization"], &d[*k]["resets_at"])).collect()
}

fn wins(w: [Option<Value>; 2]) -> Vec<Value> { w.into_iter().flatten().collect() }

/// Codex's usage response
pub fn codex_limits(d: &Value) -> Value {
    let win = |w: &Value| w.is_object().then(|| limit(window_label(number(&w["limit_window_seconds"])), &w["used_percent"], &w["reset_at"]));
    let rl = &d["rate_limit"];
    json!({ "tool": "Codex", "plan": d["plan_type"].as_str(), "limits": wins([win(&rl["primary_window"]), win(&rl["secondary_window"])]) })
}

/// Codex logs a rate-limit snapshot with every response: the newest one is where its limits stood
pub fn codex_from_logs(home: &Path) -> Option<Value> {
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v.reverse();
        v
    }
    // sessions/YYYY/MM/DD/rollout-*.jsonl, newest first
    fn walk(dir: &Path, depth: u8, files: &mut Vec<PathBuf>) {
        for n in names(dir) {
            if files.len() >= 3 { return; }
            let f = dir.join(&n);
            if depth < 3 { walk(&f, depth + 1, files); } else if n.starts_with("rollout-") && n.ends_with(".jsonl") { files.push(f); }
        }
    }
    let mut files = vec![];
    walk(&home.join("sessions"), 0, &mut files);
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.trim_end().split('\n').rev() {
            if !line.contains("\"rate_limits\"") { continue; }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let rl = &v["payload"]["rate_limits"];
            if !rl["primary"].is_object() { continue; }
            let win = |w: &Value| w.is_object().then(|| limit(window_label(number(&w["window_minutes"]) * 60.0), &w["used_percent"], &w["resets_at"]));
            return Some(json!({ "plan": rl["plan_type"].as_str(), "limits": wins([win(&rl["primary"]), win(&rl["secondary"])]) }));
        }
    }
    None
}

/// "exp" from a JWT's payload, in ms; 0 when it isn't readable
fn jwt_exp(tok: &str) -> i64 {
    let Some(p) = tok.split('.').nth(1) else { return 0 };
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('='))
        .ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["exp"].as_f64()).map(|e| (e * 1000.0) as i64).unwrap_or(0)
}

async fn get_json(c: &Ctx, url: &str, headers: &[(&str, String)]) -> Result<Value, String> {
    let mut req = c.http.get(url);
    for (k, v) in headers { req = req.header(*k, v); }
    let r = req.send().await.map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if !r.status().is_success() { return Err(if st == 401 { "Signed out: run it once to sign in again".into() } else { format!("Usage service returned {st}") }); }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

/// The plan from Claude Code's login: "max" -> "Max"
fn plan_of(sub: &Value) -> Value {
    sub.as_str().filter(|s| !s.is_empty()).map(|s| { let mut c = s.chars(); json!(c.next().unwrap().to_uppercase().chain(c).collect::<String>()) }).unwrap_or(Value::Null)
}

async fn claude(c: &Ctx) -> Option<Value> {
    let k = run("/usr/bin/security", &["find-generic-password", "-s", "Claude Code-credentials", "-w"], secs(30)).await;
    let raw = if k.code == 0 { Some(k.stdout) } else { std::fs::read_to_string(home().join(".claude/.credentials.json")).ok() };
    let creds = raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()).map(|v| v["claudeAiOauth"].clone())?;
    let token = creds["accessToken"].as_str().filter(|t| !t.is_empty())?; // not signed in with a plan: nothing to show
    let mut tool = json!({ "tool": "Claude Code", "plan": plan_of(&creds["subscriptionType"]), "limits": [] });
    if creds["expiresAt"].as_f64().is_some_and(|e| e != 0.0 && e < now_ms() as f64) {
        tool["error"] = json!("Login expired: open Claude Code to refresh it");
        return Some(tool);
    }
    match get_json(c, CLAUDE_URL, &[("Authorization", format!("Bearer {token}")), ("anthropic-beta", "oauth-2025-04-20".into())]).await {
        Ok(d) => tool["limits"] = json!(claude_limits(&d)),
        Err(e) => tool["error"] = json!(e),
    }
    Some(tool)
}

async fn codex(c: &Ctx) -> Option<Value> {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(home.join("auth.json")).ok()?).ok()?;
    if let Some(tok) = auth["tokens"]["access_token"].as_str().filter(|t| !t.is_empty()) {
        let exp = jwt_exp(tok);
        if exp == 0 || exp > now_ms() {
            let mut h = vec![("Authorization", format!("Bearer {tok}"))];
            if let Some(a) = auth["tokens"]["account_id"].as_str().filter(|a| !a.is_empty()) { h.push(("ChatGPT-Account-Id", a.to_string())); }
            if let Ok(d) = get_json(c, CODEX_URL, &h).await { return Some(codex_limits(&d)); } // else fall back to the logs
        }
    }
    Some(match codex_from_logs(&home) {
        Some(mut l) => { l["tool"] = json!("Codex"); l["stale"] = json!(true); l }
        None => json!({ "tool": "Codex", "plan": null, "limits": [], "error": "Signed out: run Codex once to sign in again" }),
    })
}

impl Limits {
    /// the latest scan, { tools, at } (home.rs reads it)
    pub fn last(&self) -> Option<Value> { self.last.lock().unwrap().clone() }

    pub async fn scan(&self, c: &Ctx) -> ApiResult<Value> {
        let now = now_ms();
        if c.demo {
            let l = |label: &str, used: i64, in_ms: i64| json!({ "label": label, "used": used, "resetsAt": now + in_ms });
            return Ok(json!({ "tools": [
                { "tool": "Claude Code", "plan": "Max", "limits": [l("5-hour", 86, 5_400_000), l("Weekly", 41, 3 * 86_400_000)] },
                { "tool": "Codex", "plan": "plus", "limits": [l("5-hour", 12, 9_000_000), l("Weekly", 63, 5 * 86_400_000)] },
            ] }));
        }
        let (a, b) = tokio::join!(claude(c), codex(c));
        let tools: Vec<Value> = [a, b].into_iter().flatten().map(|mut t| {
            t["limits"] = json!(t["limits"].as_array().cloned().unwrap_or_default().into_iter().map(|l| fresh(l, now)).collect::<Vec<_>>());
            t
        }).collect();
        let out = json!({ "tools": tools, "at": now });
        *self.last.lock().unwrap() = Some(out.clone());
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_limits_come_from_the_newest_snapshot_in_its_logs() {
        let home = std::env::temp_dir().join(format!("codex-{}", std::process::id()));
        let day = home.join("sessions/2026/11/24");
        std::fs::create_dir_all(&day).unwrap();
        let snap = |used: u32| json!({ "type": "event_msg", "payload": { "type": "token_count", "rate_limits": { "plan_type": "plus",
            "primary": { "used_percent": used, "window_minutes": 300, "resets_at": 1900000000u64 }, "secondary": { "used_percent": 10, "window_minutes": 10080, "resets_at": 1900500000u64 } } } }).to_string();
        std::fs::write(day.join("rollout-a.jsonl"), [snap(40), "{\"type\":\"other\"}".into(), snap(85)].join("\n")).unwrap();
        let r = codex_from_logs(&home).unwrap();
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(r["limits"], json!([{ "label": "5-hour", "used": 85, "resetsAt": 1900000000000u64 }, { "label": "Weekly", "used": 10, "resetsAt": 1900500000000u64 }]));
        assert_eq!(r["plan"], "plus");
    }
    #[test]
    fn claude_usage_both_shapes() {
        let d = json!({ "limits": [
            { "kind": "session", "percent": 42.5, "resets_at": "2026-11-26T18:00:00.000Z" },
            { "kind": "weekly_all", "percent": "7", "resets_at": 1900000000 },
            { "kind": "weekly_model", "percent": 3, "scope": { "model": { "display_name": "Opus" } } },
            { "kind": "weekly_x", "percent": null },
            { "kind": "burst", "scope": { "surface": { "display_name": "Claude Code" } } },
            { "percent": 1 },
        ] });
        let l = claude_limits(&d);
        assert_eq!(l.iter().map(|x| x["label"].as_str().unwrap()).collect::<Vec<_>>(), ["5-hour", "Weekly", "Weekly Opus", "Weekly", "Claude Code", "Limit"]);
        assert_eq!((l[0]["used"].clone(), l[1]["used"].clone(), l[3]["used"].clone()), (json!(42.5), json!(7), json!(0)));
        assert_eq!(l[0]["resetsAt"], json!(crate::detect::parse_time("2026-11-26T18:00:00.000Z").unwrap()));
        assert_eq!(l[1]["resetsAt"], json!(1900000000000u64));
        let old = claude_limits(&json!({ "five_hour": { "utilization": 12, "resets_at": "" }, "seven_day_opus": { "utilization": 5 } }));
        assert_eq!(old, vec![json!({ "label": "5-hour", "used": 12, "resetsAt": null }), json!({ "label": "Weekly Opus", "used": 5, "resetsAt": null })]);
    }
    #[test]
    fn codex_usage_and_windows() {
        let d = json!({ "plan_type": "plus", "rate_limit": { "primary_window": { "limit_window_seconds": 18000, "used_percent": 20, "reset_at": 1900000000 }, "secondary_window": null } });
        assert_eq!(codex_limits(&d), json!({ "tool": "Codex", "plan": "plus", "limits": [{ "label": "5-hour", "used": 20, "resetsAt": 1900000000000u64 }] }));
        assert_eq!((window_label(604800.0), window_label(7200.0), window_label(0.0)), ("Weekly".into(), "2-hour".into(), "Limit".into()));
    }
    #[test]
    fn expiry_plan_and_reset() {
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1900000000}"#);
        assert_eq!(jwt_exp(&format!("h.{b64}.s")), 1_900_000_000_000);
        assert_eq!(jwt_exp("nope"), 0);
        assert_eq!(plan_of(&json!("max")), json!("Max"));
        assert_eq!(plan_of(&json!(null)), Value::Null);
        assert_eq!(fresh(json!({ "used": 80, "resetsAt": 5 }), 10), json!({ "used": 0, "resetsAt": null }));
        assert_eq!(fresh(json!({ "used": 80, "resetsAt": 50 }), 10)["used"], 80);
    }
}

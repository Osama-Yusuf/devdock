//! Coding agents DevDock can run headless, and how to read what they do.
//!
//! Every agent prints JSON events; each adapter turns them into the same small set of
//! milestones the run window shows. Shapes checked against real runs (Nov 2026):
//!   claude -p --output-format stream-json --verbose   (Claude Code 2.1)
//!   codex exec --json                                  (codex-cli 0.167)
//!   opencode run --format json                         (opencode 1.18)
//!
//! Milestones (one JSON object per line in the run's events file):
//!   { t:'session', id }                               resumable session id
//!   { t:'step', id, kind, label, detail, change, status:'run'|'ok'|'fail'|'blocked', exit?, out? }
//!   { t:'note', text }                                something the agent said mid-run
//!   { t:'answer', text, prose?, data? }               its final message
//!   { t:'done', ok, error?, ms, cost?, tokens? }
//!
//! Strings are measured and cut in UTF-16 units, as the JS did, so labels and limits match.
use regex_lite::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub struct Agent { pub id: &'static str, pub label: &'static str, pub bin: &'static str }

pub const AGENTS: [Agent; 3] = [
    Agent { id: "claude", label: "Claude Code", bin: "claude" },
    Agent { id: "codex", label: "Codex", bin: "codex" },
    Agent { id: "opencode", label: "OpenCode", bin: "opencode" },
];

pub fn agent(id: &str) -> Option<&'static Agent> { AGENTS.iter().find(|a| a.id == id) }

#[derive(Default, Clone, Copy)]
pub struct Opts<'a> { pub prompt: &'a str, pub read_only: bool, pub k8s: Option<&'a str>, pub session: Option<&'a str> }

/// Read-only runs may only start these. Prefix match, per command in a pipeline.
/// ponytail: codex has no per-command allowlist; its read-only sandbox also blocks Docker.
pub fn read_only_commands(k8s: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = ["docker ps", "docker inspect", "docker logs", "docker stats --no-stream", "docker top", "docker port",
        "docker diff", "docker history", "docker images", "docker image ls", "docker image inspect",
        "docker volume ls", "docker volume inspect", "docker system df", "docker compose ps", "docker compose logs"].map(String::from).to_vec();
    if let Some(k) = k8s { v.extend(["get", "describe", "logs", "top", "events"].map(|x| format!("kubectl --context {k} {x}"))); }
    v.extend(["tmux ls", "tmux list-sessions", "tmux list-windows", "tmux list-panes", "tmux capture-pane", "tmux display-message",
        "ps", "pgrep", "lsof", "top -l 1", "netstat", "git status", "git log", "git diff", "git show", "git branch",
        "cat", "head", "tail", "grep", "rg", "ls", "wc", "sort", "uniq", "jq", "du", "df", "which", "uname", "date",
        "echo", "printf", "stat", "pwd", "whoami", "uptime", "sw_vers", "vm_stat", "sysctl -n", "launchctl list", "brew services list"].map(String::from));
    v
}

impl Agent {
    pub fn args(&self, o: Opts) -> Vec<String> {
        let s = |x: &[&str]| x.iter().map(|y| y.to_string()).collect::<Vec<_>>();
        match self.id {
            "claude" => {
                let mut a = s(&["-p", o.prompt]);
                if let Some(id) = o.session { a.extend(s(&["--resume", id])); }
                a.extend(s(&["--output-format", "stream-json", "--verbose"]));
                if o.read_only {
                    a.extend(s(&["--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Glob"]));
                    a.extend(read_only_commands(o.k8s).iter().map(|c| format!("Bash({c}:*)")));
                } else { a.extend(s(&["--permission-mode", "bypassPermissions"])); }
                a
            }
            // `exec resume` has no -s flag; the same sandbox goes in as config
            "codex" => match o.session {
                Some(id) => {
                    let mut a = s(&["exec", "resume", "--json", "--skip-git-repo-check"]);
                    a.extend(if o.read_only { s(&["-c", "sandbox_mode=\"read-only\""]) } else { s(&["--dangerously-bypass-approvals-and-sandbox"]) });
                    a.extend(s(&[id, o.prompt]));
                    a
                }
                None => {
                    let mut a = s(&["exec", "--json", "--skip-git-repo-check"]);
                    a.extend(if o.read_only { s(&["-s", "read-only"]) } else { s(&["--dangerously-bypass-approvals-and-sandbox"]) });
                    a.push(o.prompt.into());
                    a
                }
            },
            _ => {
                let mut a = s(&["run", "--format", "json"]);
                if let Some(id) = o.session { a.extend(s(&["--session", id])); }
                if !o.read_only { a.push("--auto".into()); }
                a.push(o.prompt.into());
                a
            }
        }
    }

    /// opencode reads extra config from this variable, merged over the user's own. Written by
    /// hand so the rules keep their order: the "*" deny first, then each allowed command.
    pub fn env(&self, o: Opts) -> Vec<(String, String)> {
        if self.id != "opencode" || !o.read_only { return vec![]; }
        let q = |s: &str| Value::from(s).to_string();
        let mut bash = vec![format!("{}:{}", q("*"), q("deny"))];
        for c in read_only_commands(o.k8s) { bash.push(format!("{}:{}", q(&c), q("allow"))); bash.push(format!("{}:{}", q(&format!("{c} *")), q("allow"))); }
        vec![("OPENCODE_CONFIG_CONTENT".into(), format!("{{\"permission\":{{\"edit\":\"deny\",\"webfetch\":\"allow\",\"bash\":{{{}}}}}}}", bash.join(",")))]
    }

    pub fn resume(&self, id: &str) -> Vec<String> {
        match self.id { "claude" => vec!["--resume".into(), id.into()], "codex" => vec!["resume".into(), id.into()], _ => vec!["--session".into(), id.into()] }
    }

    fn parse(&self, e: &Value, st: &mut St) -> Vec<Raw> {
        match self.id { "claude" => parse_claude(e), "codex" => parse_codex(e, st), _ => parse_opencode(e, st) }
    }
}

// ── JS value helpers ─────────────────────────────────────────────────
pub fn len16(s: &str) -> usize { s.encode_utf16().count() }

/// The first n UTF-16 units (never splitting a character)
pub fn take16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > n { return &s[..i]; }
    }
    s
}

/// The last n UTF-16 units
pub fn last16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices().rev() {
        used += c.len_utf16();
        if used > n { return &s[i + c.len_utf8()..]; }
    }
    s
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false, Value::Bool(b) => *b, Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()), _ => true,
    }
}

/// A number as JS writes it: 15, not 15.0
pub fn num(x: f64) -> Value { if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) } }

/// JS String(v)
pub fn jstr(v: &Value) -> String {
    match v {
        Value::Null => "null".into(), Value::Bool(b) => b.to_string(), Value::String(s) => s.clone(),
        Value::Number(n) => n.as_i64().map(|i| i.to_string()).unwrap_or_else(|| { let f = n.as_f64().unwrap_or(0.0); if f.fract() == 0.0 && f.abs() < 1e21 { (f as i64).to_string() } else { f.to_string() } }),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { jstr(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS String(v ?? '')
fn s_of(v: &Value) -> String { if v.is_null() { String::new() } else { jstr(v) } }

fn n_of(v: &Value) -> f64 { if truthy(v) { v.as_f64().unwrap_or(0.0) } else { 0.0 } }

pub fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if len16(&s) > n { format!("{}…", take16(&s, n - 1)) } else { s }
}

fn base_str(p: &str) -> String {
    if p.is_empty() { return String::new(); }
    let b = p.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if b.is_empty() { p.into() } else { b.into() }
}
fn base(p: &Value) -> String { if truthy(p) { base_str(&jstr(p)) } else { String::new() } }

fn host(u: &Value) -> String {
    match tauri::Url::parse(&s_of(u)) {
        Ok(url) => format!("{}{}", url.host_str().unwrap_or(""), url.port().map(|p| format!(":{p}")).unwrap_or_default()),
        Err(_) => clip(&s_of(u), 30),
    }
}
fn cap(s: &str) -> String { let mut c = s.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() }
fn list(xs: &[String]) -> String {
    let xs: Vec<&String> = xs.iter().filter(|x| !x.is_empty()).collect();
    let j = |v: &[&String]| v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
    if xs.len() > 2 { format!("{} +{}", j(&xs[..2]), xs.len() - 2) } else { j(&xs) }
}
fn text_of(c: &Value) -> String {
    match c { Value::String(s) => s.clone(), Value::Array(a) => a.iter().map(|x| x["text"].as_str().filter(|t| !t.is_empty()).unwrap_or("").to_string()).collect::<Vec<_>>().join("\n"), _ => String::new() }
}
pub fn tail_lines(s: &str, n: usize) -> Option<String> {
    if s.is_empty() { return None; }
    let lines: Vec<&str> = s.trim_end().split('\n').collect();
    let t = lines[lines.len().saturating_sub(n)..].join("\n");
    Some(last16(&t, 800).to_string())
}

// ── per-agent event parsing ──────────────────────────────────────────
/// What an adapter reads out of one event, before the reducer turns it into milestones
#[derive(Debug, Clone)]
enum Raw {
    Session(Value),
    Text(String),
    Step { id: Value, kind: &'static str, label: String, detail: String, change: bool },
    Result { id: Value, ok: bool, exit: Value, out: Value },
    Final(String),
    Done { ok: bool, error: Option<String>, cost: Option<Value>, tokens: Option<Value> },
}

/// Per-run adapter state
#[derive(Default)]
struct St { seen: HashSet<String>, error: Option<String>, tokens: f64, cost: f64, session: bool }

fn step(id: &Value, (kind, label, detail, change): (&'static str, String, String, bool)) -> Raw { Raw::Step { id: id.clone(), kind, label, detail, change } }

fn parse_claude(e: &Value) -> Vec<Raw> {
    let mut out = vec![];
    let ty = e["type"].as_str().unwrap_or("");
    if ty == "system" && e["subtype"] == "init" && truthy(&e["session_id"]) { out.push(Raw::Session(e["session_id"].clone())); }
    let content = e["message"]["content"].as_array().cloned().unwrap_or_default();
    if ty == "assistant" { for c in &content {
        if c["type"] == "text" { if let Some(t) = c["text"].as_str().filter(|t| !t.trim().is_empty()) { out.push(Raw::Text(t.into())); } }
        if c["type"] == "tool_use" { if let Some(s) = claude_tool(c) { out.push(s); } }
    } }
    if ty == "user" { for c in &content {
        if c["type"] == "tool_result" { out.push(Raw::Result { id: c["tool_use_id"].clone(), ok: !truthy(&c["is_error"]), exit: Value::Null, out: json!(text_of(&c["content"])) }); }
    } }
    if ty == "result" {
        let err = truthy(&e["is_error"]);
        if truthy(&e["result"]) && !err { out.push(Raw::Final(jstr(&e["result"]))); }
        let error = err.then(|| if truthy(&e["result"]) { jstr(&e["result"]) } else { s_of(&e["subtype"]) });
        out.push(Raw::Done { ok: !err, error, cost: e.get("total_cost_usd").cloned(), tokens: None });
    }
    out
}

fn claude_tool(c: &Value) -> Option<Raw> {
    let i = &c["input"];
    let id = &c["id"];
    let s = |k: &str| s_of(&i[k]);
    let name = c["name"].as_str().unwrap_or("");
    Some(match name {
        "Bash" => {
            let mut d = describe_command(i["command"].as_str().unwrap_or(""));
            if truthy(&i["description"]) { d.1 = jstr(&i["description"]); }
            step(id, d)
        }
        "Read" => step(id, ("read", format!("Read {}", base(&i["file_path"])), s("file_path"), false)),
        "Grep" => step(id, ("search", format!("Searched for “{}”", clip(&s("pattern"), 40)), s("path"), false)),
        "Glob" => step(id, ("search", format!("Looked for {}", clip(&s("pattern"), 40)), s("path"), false)),
        "WebFetch" => step(id, ("web", format!("Read {}", host(&i["url"])), s("url"), false)),
        "WebSearch" => step(id, ("web", format!("Searched the web for “{}”", clip(&s("query"), 40)), String::new(), false)),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let p = if truthy(&i["file_path"]) { &i["file_path"] } else { &i["notebook_path"] };
            step(id, ("edit", format!("Edited {}", base(p)), s("file_path"), true))
        }
        "TodoWrite" | "ToolSearch" => return None,
        "Task" | "Agent" => step(id, ("tool", clip(&if truthy(&i["description"]) { jstr(&i["description"]) } else { "Started a helper agent".into() }, 60), String::new(), false)),
        _ => step(id, ("tool", format!("Used {}", name.strip_prefix("mcp__").unwrap_or(name).replace("__", " ")), String::new(), false)),
    })
}

fn parse_codex(e: &Value, st: &mut St) -> Vec<Raw> {
    let mut out = vec![];
    let ty = e["type"].as_str().unwrap_or("");
    if ty == "thread.started" { out.push(Raw::Session(e["thread_id"].clone())); }
    let it = &e["item"];
    if truthy(it) && (ty == "item.started" || ty == "item.completed") {
        let done = ty == "item.completed";
        let ity = it["type"].as_str().unwrap_or("");
        let id = &it["id"];
        if ity == "agent_message" && done { out.push(Raw::Text(s_of(&it["text"]))); }
        if ity == "command_execution" {
            let d = || describe_command(&unwrap_shell(it["command"].as_str().unwrap_or("")));
            if !done { out.push(step(id, d())); } else {
                if !st.seen.contains(&id.to_string()) { out.push(step(id, d())); }
                out.push(Raw::Result { id: id.clone(), ok: it["status"] == "completed" && !truthy(&it["exit_code"]), exit: it["exit_code"].clone(), out: it["aggregated_output"].clone() });
            }
            st.seen.insert(id.to_string());
        }
        if ity == "file_change" && done {
            let changes = it["changes"].as_array().cloned().unwrap_or_default();
            let files: Vec<String> = changes.iter().map(|c| base(&c["path"])).collect();
            let detail = changes.iter().map(|c| if c["path"].is_null() { String::new() } else { jstr(&c["path"]) }).collect::<Vec<_>>().join("\n");
            out.push(step(id, ("edit", format!("Edited {}", list(&files)), detail, true)));
            out.push(Raw::Result { id: id.clone(), ok: it["status"] != "failed", exit: Value::Null, out: Value::Null });
        }
        if ity == "mcp_tool_call" && done {
            out.push(step(id, ("tool", format!("Used {} {}", jstr_u(&it["server"]), jstr_u(&it["tool"])), String::new(), false)));
            out.push(Raw::Result { id: id.clone(), ok: it["status"] != "failed", exit: Value::Null, out: Value::Null });
        }
        if ity == "web_search" && done {
            out.push(step(id, ("web", format!("Searched the web for “{}”", clip(&s_of(&it["query"]), 40)), String::new(), false)));
            out.push(Raw::Result { id: id.clone(), ok: true, exit: Value::Null, out: Value::Null });
        }
        if ity == "error" && done { st.error = it["message"].as_str().map(String::from); }
    }
    if ty == "turn.completed" {
        let u = &e["usage"];
        st.tokens += n_of(&u["input_tokens"]) + n_of(&u["output_tokens"]);
        out.push(Raw::Done { ok: true, error: None, cost: None, tokens: Some(num(st.tokens)) });
    }
    if ty == "turn.failed" {
        let m = e["error"]["message"].as_str().filter(|m| !m.is_empty()).map(String::from).or_else(|| st.error.clone().filter(|m| !m.is_empty()));
        out.push(Raw::Done { ok: false, error: Some(m.unwrap_or_else(|| "Codex stopped".into())), cost: None, tokens: None });
    }
    if ty == "error" { st.error = e["message"].as_str().map(String::from); }
    out
}

/// Template-literal ${x}: undefined reads as "undefined"
fn jstr_u(v: &Value) -> String { if v.is_null() { "undefined".into() } else { jstr(v) } }

fn parse_opencode(e: &Value, st: &mut St) -> Vec<Raw> {
    let mut out = vec![];
    if truthy(&e["sessionID"]) && !st.session { st.session = true; out.push(Raw::Session(e["sessionID"].clone())); }
    let p = &e["part"];
    let ty = e["type"].as_str().unwrap_or("");
    if ty == "text" { if let Some(t) = p["text"].as_str().filter(|t| !t.trim().is_empty()) { out.push(Raw::Text(t.into())); } }
    if ty == "tool_use" {
        let s = &p["state"];
        let i = &s["input"];
        let id = if truthy(&p["callID"]) { p["callID"].clone() } else { p["id"].clone() };
        let f = |k: &str| s_of(&i[k]);
        let tool = p["tool"].as_str().unwrap_or("");
        let s1 = match tool {
            "bash" => Some(describe_command(i["command"].as_str().unwrap_or(""))),
            "read" => Some(("read", format!("Read {}", base(&i["filePath"])), f("filePath"), false)),
            "list" => Some(("read", format!("Listed {}", Some(base(&i["path"])).filter(|b| !b.is_empty()).unwrap_or("folder".into())), f("path"), false)),
            "grep" => Some(("search", format!("Searched for “{}”", clip(&f("pattern"), 40)), String::new(), false)),
            "glob" => Some(("search", format!("Looked for {}", clip(&f("pattern"), 40)), String::new(), false)),
            "webfetch" => Some(("web", format!("Read {}", host(&i["url"])), f("url"), false)),
            "edit" => Some(("edit", format!("Edited {}", base(&i["filePath"])), f("filePath"), true)),
            "write" => Some(("edit", format!("Wrote {}", base(&i["filePath"])), f("filePath"), true)),
            "todowrite" | "todoread" => None,
            _ => Some(("tool", format!("Used {}", jstr_u(&p["tool"])), String::new(), false)),
        };
        if let Some(s1) = s1 {
            out.push(step(&id, s1));
            let status = s["status"].as_str().unwrap_or("");
            if status == "completed" || status == "error" {
                let exit = s["metadata"]["exit"].clone();
                let o = if status == "error" { s["error"].clone() } else if !s["output"].is_null() { s["output"].clone() } else { s["metadata"]["output"].clone() };
                out.push(Raw::Result { id: id.clone(), ok: status == "completed" && !truthy(&exit), exit, out: o });
            }
        }
    }
    if ty == "step_finish" {
        st.cost += n_of(&p["cost"]);
        st.tokens += n_of(&p["tokens"]["input"]) + n_of(&p["tokens"]["output"]);
        if p["reason"] == "stop" { out.push(Raw::Done { ok: true, error: None, cost: (st.cost != 0.0).then(|| num(st.cost)), tokens: Some(num(st.tokens)) }); }
    }
    if ty == "error" {
        let er = &e["error"];
        let m = [&er["data"]["message"], &er["message"], &er["name"]].into_iter().find(|v| truthy(v)).map(jstr);
        out.push(Raw::Done { ok: false, error: Some(m.unwrap_or_else(|| "OpenCode stopped".into())), cost: None, tokens: None });
    }
    out
}

// ── raw parse output -> milestones ───────────────────────────────────
// Agents narrate ("I'll run...", "Let me check..."). Steps already show that, so those
// lines are dropped; the last message is held back because it's usually the answer.
static FILLER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(i([’']ll| will| am going to| need to|[’']m going to)|let me|let's|now,? (i|let)|first,? (i|let)|next,? (i|let)|ok(ay)?\b|great\b|alright\b|sure\b|perfect\b|good\b)").unwrap());
static DENIED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)permission to use .* (has been|was) denied|rule which prevents you from using|user rejected permission|blocked by (the )?(sandbox|policy)").unwrap());

pub fn is_filler(text: &str) -> bool { let t = text.trim(); len16(t) < 240 && FILLER.is_match(t) }

pub struct Reducer {
    agent: &'static Agent,
    st: St,
    steps: HashMap<String, Map<String, Value>>,
    pending: Option<String>, // latest text, not yet known to be the last one
    final_: Option<String>,
    done: Option<Raw>,
    trailing: Vec<String>, // notes since the last step: one of them may be the real answer
}

fn obj(v: Value) -> Map<String, Value> { match v { Value::Object(m) => m, _ => Map::new() } }

impl Reducer {
    pub fn new(agent: &'static Agent) -> Self {
        Reducer { agent, st: St::default(), steps: HashMap::new(), pending: None, final_: None, done: None, trailing: vec![] }
    }

    fn flush(&mut self, out: &mut Vec<Value>) {
        if let Some(p) = self.pending.take() {
            if !p.is_empty() && !is_filler(&p) { out.push(json!({ "t": "note", "text": p.trim() })); self.trailing.push(p.trim().into()); }
        }
    }

    pub fn push(&mut self, event: &Value) -> Vec<Value> {
        let mut out = vec![];
        for m in self.agent.parse(event, &mut self.st) {
            match m {
                Raw::Text(t) => { self.flush(&mut out); self.pending = Some(t); }
                Raw::Step { id, kind, label, detail, change } => {
                    let key = id.to_string();
                    if self.steps.contains_key(&key) { continue; }
                    self.flush(&mut out);
                    self.trailing.clear();
                    let s = obj(json!({ "t": "step", "id": id, "kind": kind, "label": label, "detail": detail, "change": change, "status": "run" }));
                    out.push(Value::Object(s.clone()));
                    self.steps.insert(key, s);
                }
                Raw::Result { id, ok, exit, out: o } => {
                    let Some(s) = self.steps.get_mut(&id.to_string()) else { continue };
                    let text = if truthy(&o) { jstr(&o) } else { String::new() };
                    // a permission denial isn't a failure of the command: it never ran
                    let blocked = !ok && DENIED.is_match(take16(&text, 300));
                    s.insert("status".into(), json!(if ok { "ok" } else if blocked { "blocked" } else { "fail" }));
                    if exit.is_null() { s.remove("exit"); } else { s.insert("exit".into(), exit); }
                    match (ok || blocked).then_some(()).map_or_else(|| tail_lines(&text, 6), |_| None) {
                        Some(t) => { s.insert("out".into(), json!(t)); }
                        None => { s.remove("out"); }
                    }
                    out.push(Value::Object(s.clone()));
                }
                Raw::Final(t) => self.final_ = Some(t),
                d @ Raw::Done { .. } => self.done = Some(d),
                Raw::Session(id) => out.push(json!({ "t": "session", "id": id })),
            }
        }
        out
    }

    /// After the process exits: the held-back message is the answer. `code` is None when a signal ended it.
    pub fn finish(&mut self, code: Option<i32>, stderr: &str, ms: u64) -> Vec<Value> {
        let pick = |x: &Option<String>| x.clone().filter(|s| !s.is_empty());
        let mut answer = pick(&self.final_).or_else(|| pick(&self.pending)).unwrap_or_default().trim().to_string();
        self.pending = None;
        // A short last word after a long finding (a hook's follow-up, "anything else?") isn't
        // the answer: the finding is. The short one stays visible as a note.
        let mut out = vec![];
        let best = self.trailing.iter().fold("", |a, b| if len16(b) > len16(a) { b } else { a }).to_string();
        if len16(&answer) < 200 && len16(&best) > 400.max(len16(&answer) * 2) {
            if !answer.is_empty() { out.push(json!({ "t": "note", "text": answer })); }
            answer = best;
        }
        let (d_ok, d_err, cost, tokens) = match &self.done { Some(Raw::Done { ok, error, cost, tokens }) => (Some(*ok), error.clone(), cost.clone(), tokens.clone()), _ => (None, None, None, None) };
        let ok = d_ok.unwrap_or(code == Some(0));
        let error = (!ok).then(|| d_err.filter(|e| !e.is_empty()).or_else(|| tail_lines(stderr, 4).filter(|e| !e.is_empty()))
            .unwrap_or_else(|| format!("{} exited with code {}", self.agent.label, code.map_or("null".into(), |c| c.to_string()))));
        if !answer.is_empty() {
            let mut a = obj(json!({ "t": "answer", "text": answer }));
            if let Some((prose, data)) = parse_reply(&answer) { a.insert("prose".into(), json!(prose)); a.insert("data".into(), data); }
            out.push(Value::Object(a));
        }
        let mut d = obj(json!({ "t": "done", "ok": ok, "ms": ms }));
        if let Some(e) = error { d.insert("error".into(), json!(e)); }
        if let Some(c) = cost { d.insert("cost".into(), c); }
        if let Some(t) = tokens { d.insert("tokens".into(), t); }
        out.push(Value::Object(d));
        out
    }
}

// ── the structured reply (sources/agents.rs REPLY_FORMAT) ───────────
// The last ```json block of the answer, checked field by field; None when there's none or
// it's off-shape, and the UI shows the prose as markdown instead.
static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"```(?:json)?\s*\n([\s\S]*?)\n\s*```").unwrap());
const STATUS: [&str; 4] = ["ok", "warning", "problem", "info"];
const RISK: [&str; 3] = ["safe", "changes", "destructive"];

pub fn parse_reply(text: &str) -> Option<(String, Value)> {
    let last = BLOCK.captures_iter(text).last()?;
    let d: Value = serde_json::from_str(last.get(1)?.as_str()).ok()?;
    if !(d.is_object() || d.is_array()) || !d["summary"].as_str().is_some_and(|s| !s.trim().is_empty()) { return None; }
    let str_ = |v: &Value, n: usize| v.as_str().map(|s| take16(s.trim(), n).to_string()).unwrap_or_default();
    let pick = |v: &Value, list: &[&str], dflt: &str| v.as_str().filter(|s| list.contains(s)).unwrap_or(dflt).to_string();
    let arr = |v: &Value| v.as_array().map(|a| a.iter().filter(|x| x.is_object() || x.is_array()).cloned().collect::<Vec<_>>()).unwrap_or_default();
    let findings: Vec<Value> = arr(&d["findings"]).iter().take(8).map(|f| json!({
        "status": pick(&f["status"], &STATUS, "info"), "title": str_(&f["title"], 160), "detail": str_(&f["detail"], 800),
        "items": f["items"].as_array().map(|a| a.iter().filter_map(|i| i.as_str()).take(12).map(|i| take16(i, 80).to_string()).collect::<Vec<_>>()).unwrap_or_default(),
    })).filter(|f| f["title"] != "").collect();
    let replies: Vec<String> = d["replies"].as_array().map(|a| a.iter().filter_map(|r| r.as_str()).filter(|r| !r.trim().is_empty()).take(3).map(|r| take16(r.trim(), 100).to_string()).collect()).unwrap_or_default();
    let actions: Vec<Value> = arr(&d["actions"]).iter().take(6).map(|a| json!({
        "title": str_(&a["title"], 160), "command": str_(&a["command"], 2000), "risk": pick(&a["risk"], &RISK, "changes"), "why": str_(&a["why"], 300),
    })).filter(|a| a["title"] != "").collect();
    Some((text[..last.get(0)?.start()].trim().to_string(), json!({
        "status": pick(&d["status"], &STATUS, "info"), "summary": str_(&d["summary"], 400), "findings": findings, "replies": replies, "actions": actions,
    })))
}

// ── shell commands -> a human label ──────────────────────────────────
static SHELL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\S*/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$").unwrap());
static ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\\(["\\$`])"#).unwrap());

/// codex wraps everything: /bin/zsh -lc 'docker ps'
pub fn unwrap_shell(cmd: &str) -> String {
    let Some(m) = SHELL.captures(cmd) else { return cmd.into() };
    let a = m[1].trim();
    let inner = || if a.len() >= 2 { &a[1..a.len() - 1] } else { "" };
    if a.starts_with('\'') && a.ends_with('\'') { return inner().replace("'\\''", "'"); }
    if a.starts_with('"') && a.ends_with('"') { return ESCAPED.replace_all(inner(), "$1").into_owned(); }
    a.into()
}

/// Split on ; && || | and newlines, outside quotes
fn segments(cmd: &str) -> Vec<String> {
    let c: Vec<char> = cmd.chars().collect();
    let mut parts: Vec<(String, bool)> = vec![];
    let (mut cur, mut q) = (String::new(), None::<char>);
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if let Some(qc) = q {
            cur.push(ch);
            if ch == qc { q = None; } else if ch == '\\' && qc == '"' { i += 1; if let Some(n) = c.get(i) { cur.push(*n); } }
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' { q = Some(ch); cur.push(ch); i += 1; continue; }
        if ch == ';' || ch == '\n' || ch == '|' || (ch == '&' && c.get(i + 1) == Some(&'&')) {
            parts.push((cur.trim().into(), ch == '|' && c.get(i + 1) != Some(&'|')));
            if c.get(i + 1) == Some(&ch) { i += 1; }
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    parts.push((cur.trim().into(), false));
    // anything after a single | only filters the previous command
    let mut out = vec![];
    let mut skip = false;
    for (t, piped) in parts { if !skip && !t.is_empty() { out.push(t); } skip = piped; }
    out
}

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"'[^']*'|"(?:\\.|[^"])*"|\S+"#).unwrap());
static ASSIGN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\w+=").unwrap());
static REDIRECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d?>").unwrap());

fn words(s: &str) -> Vec<String> {
    WORD.find_iter(s).map(|m| {
        let w = m.as_str();
        let f = w.chars().next().unwrap();
        if w.len() >= 2 && (f == '\'' || f == '"') && w.ends_with(f) { w[1..w.len() - 1].to_string() } else { w.to_string() }
    }).collect()
}

static CHANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(docker (rm|rmi|stop|kill|restart|start|run|exec|prune|system prune|image prune|volume (rm|prune)|container (rm|stop|prune)|compose (up|down|restart|stop|rm))|kubectl( --context \S+)? (delete|apply|scale|rollout|edit|patch|cordon|drain)|kill|pkill|killall|rm|mv|git (commit|push|reset|checkout|stash|merge|rebase)|npm (i|install)|brew (install|uninstall)|tmux kill)").unwrap());

const VALUE_FLAGS: &[&str] = &["--context", "-n", "--namespace", "-c", "--container", "--tail", "-t", "--format", "-f", "--since",
    "-o", "--output", "-l", "--selector", "-S", "-E", "-u", "--user", "-w", "--workdir", "-e", "--env", "-p", "--filter"];

/// One segment -> label. None = not worth a milestone (echo, true, cd...).
fn label_of(seg: &str) -> Option<String> {
    let w: Vec<String> = words(seg).into_iter().filter(|x| !ASSIGN.is_match(x) && !REDIRECT.is_match(x)).collect();
    let (cmd, a) = w.split_first()?;
    let is_vflag = |x: &str| VALUE_FLAGS.contains(&x);
    // flags that take a value: their value is not a positional argument
    let pos: Vec<&str> = a.iter().enumerate().filter(|(i, x)| !x.starts_with('-') && !(*i > 0 && is_vflag(&a[i - 1]) && !a[i - 1].contains('='))).map(|(_, x)| x.as_str()).collect();
    let flag = |n: &str| a.iter().position(|x| x == n).and_then(|i| a.get(i + 1)).map(String::as_str);
    let name = |x: Option<&str>| clip(x.unwrap_or(""), 28);
    let p = |i: usize| pos.get(i).copied();
    let trim = |s: String| s.trim().to_string();
    Some(match cmd.as_str() {
        "echo" | "printf" | "true" | "false" | "cd" | "sleep" | "export" => return None,
        "docker" => {
            let (sub, sub2) = (p(0), p(1));
            let target = pos.last().copied();
            if sub == Some("system") && sub2 == Some("df") { return Some("Checked Docker disk usage".into()); }
            if let Some(s @ ("volume" | "image" | "container" | "network")) = sub {
                let verb = match sub2 { Some("ls") => "Listed".into(), Some("inspect") => "Inspected".into(), x => cap(x.unwrap_or("")) };
                let tail = if sub2 == Some("ls") { "s".into() } else if p(2).is_some() { format!(" {}", name(p(2))) } else { String::new() };
                return Some(format!("{verb} {s}{tail}"));
            }
            if sub == Some("compose") { return Some(trim(format!("docker compose {}", p(1).unwrap_or("")))); }
            match sub {
                Some("ps") => "Listed containers".into(), Some("images") => "Listed images".into(), Some("stats") => "Checked container usage".into(),
                Some("inspect") => format!("Inspected {}", name(target)), Some("logs") => format!("Read logs of {}", name(target)),
                Some("top") => format!("Checked processes in {}", name(target)), Some("port") => format!("Checked ports of {}", name(target)),
                Some("diff") => format!("Checked file changes in {}", name(target)), Some("history") => format!("Read history of {}", name(target)),
                Some("rm") => format!("Removed {}", name(target)), Some("rmi") => format!("Removed image {}", name(target)),
                Some("stop") => format!("Stopped {}", name(target)), Some("kill") => format!("Killed {}", name(target)),
                Some("restart") => format!("Restarted {}", name(target)), Some("start") => format!("Started {}", name(target)),
                Some("run") => format!("Started a container from {}", name(p(1))), Some("exec") => format!("Ran {} in {}", name(p(2)), name(p(1))),
                _ => trim(format!("docker {}", sub.unwrap_or(""))),
            }
        }
        "kubectl" => {
            let ns = flag("-n").filter(|x| !x.is_empty()).or_else(|| flag("--namespace"));
            let what = pos.get(1..).unwrap_or(&[]).join(" ");
            let verb = match p(0) {
                Some("get") => "Listed".into(), Some("describe") => "Described".into(), Some("logs") => "Read logs of".into(), Some("top") => "Checked usage of".into(),
                Some("events") => "Read events".into(), Some("delete") => "Deleted".into(), Some("apply") => "Applied".into(), Some("scale") => "Scaled".into(),
                Some("rollout") => "Rolled out".into(), v => format!("kubectl {}", v.unwrap_or("undefined")),
            };
            trim(format!("{verb} {}{}", name(Some(&what)), ns.map(|n| format!(" in {n}")).unwrap_or_default()))
        }
        "tmux" => {
            let t = flag("-t").unwrap_or("");
            let t = t.strip_prefix('=').unwrap_or(t);
            match p(0) {
                Some("capture-pane") => format!("Read the screen of {}", Some(name(Some(t))).filter(|x| !x.is_empty()).unwrap_or("a pane".into())),
                Some(l) if l.starts_with("list-") => format!("Listed tmux {}", &l[5..]),
                Some("kill-session") => format!("Closed tmux session {}", name(Some(t))),
                x => trim(format!("tmux {}", x.unwrap_or(""))),
            }
        }
        "lsof" => {
            let i = a.iter().find(|x| x.starts_with("-i")).map(|x| x[2..].to_string()).filter(|x| !x.is_empty());
            let port = i.or_else(|| flag("-i").map(String::from)).unwrap_or_default();
            if port.is_empty() { "Checked open files".into() } else {
                let port = if let Some(r) = port.strip_prefix(':') { format!("port {r}") } else { port };
                let port = if port.len() >= 4 && port[..4].eq_ignore_ascii_case("tcp:") { format!("port {}", &port[4..]) } else { port };
                format!("Checked who uses {port}")
            }
        }
        "ps" | "pgrep" | "top" => "Checked running processes".into(),
        "kill" | "pkill" | "killall" => format!("Stopped process {}", name(p(0))),
        "git" => match p(0) {
            Some("status") => "Checked git status".into(), Some("log") => "Read git history".into(), Some("diff") => "Read the diff".into(),
            Some("show") => trim(format!("Read commit {}", name(p(1)))), Some("branch") => "Listed branches".into(),
            x => trim(format!("git {}", x.unwrap_or(""))),
        },
        "cat" | "head" | "tail" | "less" | "bat" | "sed" => {
            if pos.is_empty() { return None; }
            let files: Vec<String> = pos.iter().filter(|x| !(x.bytes().all(|b| b.is_ascii_digit()) && !x.is_empty()) && !x.starts_with("s/")).map(|x| base_str(x)).collect();
            format!("Read {}", list(&files))
        }
        "ls" => format!("Listed {}", Some(base_str(p(0).unwrap_or(""))).filter(|b| !b.is_empty()).unwrap_or("folder".into())),
        "grep" | "rg" => p(0).map_or("Searched".into(), |x| format!("Searched for “{}”", clip(x, 30))),
        "find" | "fd" => "Searched files".into(),
        "curl" | "wget" => match pos.iter().find(|x| x.starts_with("http://") || x.starts_with("https://") || x.starts_with("localhost")) {
            Some(u) => format!("Requested {}", clip(u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(u), 40)),
            None => "Made a request".into(),
        },
        "npm" | "pnpm" | "yarn" | "bun" => trim(format!("Ran {cmd} {}", pos.iter().take(2).copied().collect::<Vec<_>>().join(" "))),
        "du" | "df" => "Checked disk usage".into(),
        "jq" => return None,
        _ => clip(&format!("Ran {}{}", base_str(cmd), p(0).map(|x| format!(" {x}")).unwrap_or_default()), 48),
    })
}

/// (kind, label, detail, change)
pub fn describe_command(command: &str) -> (&'static str, String, String, bool) {
    let segs = segments(command);
    let mut labels: Vec<String> = vec![];
    for l in segs.iter().filter_map(|s| label_of(s)) { if !l.is_empty() && !labels.contains(&l) { labels.push(l); } }
    let label = if labels.is_empty() { clip(command, 48) } else {
        let mut l = labels[..labels.len().min(2)].join(" · ");
        if labels.len() > 2 { l += &format!(" +{}", labels.len() - 2); }
        l
    };
    let change = segs.iter().any(|s| CHANGE.is_match(&words(s).into_iter().filter(|x| !ASSIGN.is_match(x)).collect::<Vec<_>>().join(" ")));
    ("cmd", label, command.into(), change)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn l(c: &str) -> String { describe_command(c).1 }

    #[test]
    fn commands_read_as_people_would_say_them() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'docker ps'"), "docker ps");
        assert_eq!(unwrap_shell("/bin/zsh -lc \"docker inspect --format '{{json .State}}' ce4\""), "docker inspect --format '{{json .State}}' ce4");
        assert_eq!(l("docker ps --format \"{{.Names}}\" | head -3"), "Listed containers");
        assert_eq!(l("docker inspect --format '{{json .State}}' ce47; echo ---; docker logs --tail 5 ce47 2>&1; false"), "Inspected ce47 · Read logs of ce47");
        assert_eq!(l("kubectl --context orbstack -n kube-system logs coredns-abc -c coredns --tail 50"), "Read logs of coredns-abc in kube-system");
        assert_eq!(l("kubectl --context orbstack get pods -n web"), "Listed pods in web");
        assert_eq!(l("tmux capture-pane -p -t =api"), "Read the screen of api");
        assert_eq!(l("lsof -i :3000"), "Checked who uses port 3000");
        assert_eq!(l("docker system df -v"), "Checked Docker disk usage");
        assert_eq!(l("cat /etc/hosts"), "Read hosts");
        assert_eq!(l("docker volume ls"), "Listed volumes");
        assert!(describe_command("docker rm -f web").3);
        assert!(!describe_command("docker ps -a").3);
        assert!(describe_command("FOO=1 kill 123").3);
        assert!(!describe_command("echo \"a; docker rm x\"").3); // quoted, not run
        assert!(is_filler("I'll run those checks in order."));
        assert!(is_filler("Let me check the logs."));
        assert!(!is_filler("The container was OOM killed: exit 137 with 512MB limit."));
        // beyond the JS self-check: what node agents/adapters.js gives for these
        for (c, want, change) in [
            ("lsof -iTCP:3000 -sTCP:LISTEN", "Checked who uses port 3000", false), ("git show abc123", "Read commit abc123", false),
            ("npm run dev", "Ran npm run dev", false), ("curl -s https://example.com/health", "Requested example.com/health", false),
            ("ps aux; ls /tmp; git status; df -h", "Checked running processes · Listed tmp +2", false), ("true", "true", false),
            ("docker volume", " volume", false), ("kubectl get pods", "Listed pods", false), ("docker compose up -d", "docker compose up", true),
            ("tmux list-sessions", "Listed tmux sessions", false), ("cat -n 5 a/b/ c", "Read b, c", false), ("sed -n s/x/y/ f.txt", "Read f.txt", false),
            ("python3 -m http.server 8000", "Ran python3 http.server", false), ("find . -name x | wc -l", "Searched files", false),
        ] { assert_eq!((l(c).as_str(), describe_command(c).3), (want, change), "{c}"); }
    }

    fn run(id: &str, events: &[Value], code: i32) -> Vec<Value> {
        let mut r = Reducer::new(agent(id).unwrap());
        let mut out: Vec<Value> = events.iter().flat_map(|e| r.push(e)).collect();
        out.extend(r.finish(Some(code), "", 1));
        out
    }
    fn ts(v: &[Value]) -> Vec<&str> { v.iter().map(|m| m["t"].as_str().unwrap()).collect() }

    // reducers over event shapes recorded from real runs (the JS self-check's)
    #[test]
    fn claude_stream() {
        let c = run("claude", &[
            json!({ "type": "system", "subtype": "init", "session_id": "s1" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Let me look." }, { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "docker ps", "description": "List running containers" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "x", "is_error": false }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Read", "input": { "file_path": "/etc/hosts" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t2", "content": [{ "type": "text", "text": "no" }], "is_error": true }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "It is healthy." }] } }),
            json!({ "type": "result", "subtype": "success", "is_error": false, "result": "It is healthy.", "session_id": "s1", "total_cost_usd": 0.3 }),
        ], 0);
        assert_eq!(ts(&c), ["session", "step", "step", "step", "step", "answer", "done"]);
        assert_eq!(c[1]["label"], "List running containers");
        assert_eq!(c[4]["status"], "fail");
        assert_eq!(c[4]["out"], "no");
        assert_eq!(c[6]["cost"], 0.3);
        assert_eq!(c[6], json!({ "t": "done", "ok": true, "ms": 1, "cost": 0.3 }));
    }

    #[test]
    fn codex_stream() {
        let x = run("codex", &[
            json!({ "type": "thread.started", "thread_id": "th" }),
            json!({ "type": "item.completed", "item": { "id": "i0", "type": "agent_message", "text": "I’ll run those checks." } }),
            json!({ "type": "item.started", "item": { "id": "i1", "type": "command_execution", "command": "/bin/zsh -lc 'docker ps'", "status": "in_progress" } }),
            json!({ "type": "item.completed", "item": { "id": "i1", "type": "command_execution", "command": "/bin/zsh -lc 'docker ps'", "aggregated_output": "ok", "exit_code": 0, "status": "completed" } }),
            json!({ "type": "item.completed", "item": { "id": "i2", "type": "command_execution", "command": "/bin/zsh -lc false", "aggregated_output": "", "exit_code": 1, "status": "failed" } }),
            json!({ "type": "item.completed", "item": { "id": "i3", "type": "agent_message", "text": "The container exited with 137, which is an OOM kill." } }),
            json!({ "type": "item.completed", "item": { "id": "i4", "type": "agent_message", "text": "Healthy." } }),
            json!({ "type": "turn.completed", "usage": { "input_tokens": 10, "output_tokens": 5 } }),
        ], 0);
        assert_eq!(ts(&x), ["session", "step", "step", "step", "step", "note", "answer", "done"]);
        assert_eq!(x[4]["status"], "fail"); // `false` gets a raw label, still a step
        assert_eq!(x[2]["exit"], 0);
        assert_eq!(x[6]["text"], "Healthy.");
        assert_eq!(x[7]["tokens"], json!(15));
        assert_eq!(x[7]["tokens"].to_string(), "15");
    }

    #[test]
    fn opencode_stream() {
        let o = run("opencode", &[
            json!({ "type": "step_start", "sessionID": "ses", "part": {} }),
            json!({ "type": "tool_use", "sessionID": "ses", "part": { "tool": "bash", "callID": "c1", "state": { "status": "completed", "input": { "command": "false" }, "output": "(no output)", "metadata": { "exit": 1 } } } }),
            json!({ "type": "tool_use", "sessionID": "ses", "part": { "tool": "read", "callID": "c2", "state": { "status": "completed", "input": { "filePath": "/etc/hosts" } } } }),
            json!({ "type": "text", "sessionID": "ses", "part": { "text": "Done, healthy." } }),
            json!({ "type": "step_finish", "sessionID": "ses", "part": { "reason": "stop", "cost": 0, "tokens": { "input": 3, "output": 2 } } }),
        ], 0);
        assert_eq!(ts(&o), ["session", "step", "step", "step", "step", "answer", "done"]);
        assert_eq!(o[2]["status"], "fail");
        assert_eq!(o[2]["exit"], 1);
        assert_eq!(o[6]["ok"], true);
        assert!(o[6].get("cost").is_none()); // a free run has no cost
        assert_eq!(o[6]["tokens"], json!(5));
    }

    #[test]
    fn denials_hooks_and_failures() {
        let denied = run("claude", &[
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "d1", "name": "Bash", "input": { "command": "docker rm x" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "d1", "content": "Permission to use Bash has been denied because Claude Code is running in don't ask mode.", "is_error": true }] } }),
        ], 0);
        assert_eq!(denied[1]["status"], "blocked");
        assert!(denied[1].get("out").is_none());
        let long = "Both containers are healthy. ".repeat(30);
        let hooked = run("codex", &[
            json!({ "type": "item.started", "item": { "id": "i1", "type": "command_execution", "command": "docker ps", "status": "in_progress" } }),
            json!({ "type": "item.completed", "item": { "id": "i1", "type": "command_execution", "command": "docker ps", "exit_code": 0, "status": "completed" } }),
            json!({ "type": "item.completed", "item": { "id": "i2", "type": "agent_message", "text": long } }),
            json!({ "type": "item.completed", "item": { "id": "i3", "type": "agent_message", "text": "What should the hook do?" } }),
            json!({ "type": "turn.completed", "usage": {} }),
        ], 0);
        assert_eq!(ts(&hooked), ["step", "step", "note", "note", "answer", "done"]);
        assert!(hooked[4]["text"].as_str().unwrap().starts_with("Both containers"));
        let failed = run("claude", &[json!({ "type": "system", "subtype": "init", "session_id": "s" })], 1);
        assert_eq!(failed.last().unwrap()["ok"], false);
        assert_eq!(failed.last().unwrap()["error"], "Claude Code exited with code 1");
    }

    #[test]
    fn structured_replies() {
        let (prose, data) = parse_reply("Short take.\n\n```json\n{\"status\":\"warning\",\"summary\":\"17 copies run.\",\"findings\":[{\"status\":\"bogus\",\"title\":\"Old\",\"items\":[\"a\",3]}],\"actions\":[{\"title\":\"Stop\",\"command\":\"docker stop a\",\"risk\":\"destructive\"},{\"command\":\"no title\"}]}\n```").unwrap();
        assert_eq!(prose, "Short take.");
        assert_eq!(data["status"], "warning");
        assert_eq!(data["findings"][0]["status"], "info");
        assert_eq!(data["findings"][0]["items"], json!(["a"]));
        assert_eq!(data["actions"].as_array().unwrap().len(), 1);
        assert_eq!(data["replies"], json!([]));
        assert_eq!(parse_reply("```json\n{\"summary\":\"x\",\"replies\":[\"Do step 1\",5,\"  Show logs  \"]}\n```").unwrap().1["replies"], json!(["Do step 1", "Show logs"]));
        assert!(parse_reply("no block here").is_none());
        assert!(parse_reply("```json\n{not json}\n```").is_none());
        assert!(parse_reply("```json\n{\"status\":\"ok\"}\n```").is_none()); // no summary
    }

    #[test]
    fn agent_command_lines() {
        let o = Opts { prompt: "p", read_only: true, session: Some("s"), k8s: None };
        assert_eq!(agent("codex").unwrap().args(o), ["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "s", "p"]);
        assert!(agent("claude").unwrap().args(Opts { read_only: false, ..o }).join(" ").contains("-p p --resume s"));
        let env = agent("opencode").unwrap().env(Opts { k8s: Some("orb"), ..o });
        let cfg: Value = serde_json::from_str(&env[0].1).unwrap();
        assert_eq!(cfg["permission"]["bash"]["*"], "deny");
        assert_eq!(cfg["permission"]["bash"]["kubectl --context orb get *"], "allow");
        assert!(env[0].1.starts_with("{\"permission\":{\"edit\":\"deny\",\"webfetch\":\"allow\",\"bash\":{\"*\":\"deny\",\"docker ps\":\"allow\""));
    }

    #[test]
    fn utf16_cuts() {
        assert_eq!(take16("a😀b", 2), "a");
        assert_eq!(last16("a😀b", 3), "😀b");
        assert_eq!(clip("  a \n b  ", 10), "a b");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(tail_lines("1\n2\n3\n", 2).as_deref(), Some("2\n3"));
        assert_eq!(tail_lines("", 2), None);
    }
}

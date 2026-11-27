//! Sources: each extra view's data. A source scans on its own interval while a page is open,
//! and pushes { type: 'source', id, data } only when the data changed.
//! Actions (POST /api/sources/:id/:action) validate every id against the source's own last scan.
use crate::state::Ctx;
use crate::util::{ApiErr, ApiResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub mod agents;
pub mod apps;
pub mod coding;
pub mod containers;
pub mod home;
pub mod limits;
pub mod machines;
pub mod sessions;

pub const IDS: [&str; 8] = ["sessions", "containers", "apps", "coding", "agents", "limits", "home", "machines"];

/// A command to run in DevDock's terminal (or Terminal.app)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TermSpec {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// typed in once the far side prints `input_when` (or at once), so it never shows in a command line
    pub input: Option<String>,
    pub input_when: Option<String>,
    /// a one-shot command: its output stays on screen when it ends
    pub keep: bool,
}

#[derive(Default)]
pub struct Sources {
    pub sessions: sessions::Sessions,
    pub containers: containers::Containers,
    pub apps: apps::Apps,
    pub coding: coding::Coding,
    pub agents: agents::Agents,
    pub limits: limits::Limits,
    pub home: home::Home,
    pub machines: machines::Machines,
    latest: Mutex<HashMap<&'static str, (String, Arc<str>)>>,
    pokes: [Notify; 8],
}

fn idx(id: &str) -> Option<usize> { IDS.iter().position(|x| *x == id) }

impl Sources {
    async fn scan(&self, c: &Ctx, id: &str) -> ApiResult<Value> {
        match id {
            "sessions" => self.sessions.scan(c).await,
            "containers" => self.containers.scan(c).await,
            "apps" => self.apps.scan(c).await,
            "coding" => self.coding.scan(c).await,
            "agents" => self.agents.scan(c).await,
            "limits" => self.limits.scan(c).await,
            "home" => self.home.scan(c).await,
            "machines" => self.machines.scan(c).await,
            _ => Err(ApiErr::gone("Unknown source")),
        }
    }

    pub async fn action(&self, c: &Ctx, id: &str, name: &str, p: &Value) -> ApiResult<Value> {
        let r = match id {
            "sessions" => self.sessions.action(c, name, p).await,
            "containers" => self.containers.action(c, name, p).await,
            "apps" => self.apps.action(c, name, p).await,
            "coding" => self.coding.action(c, name, p).await,
            "agents" => self.agents.action(c, name, p).await,
            "home" => self.home.action(c, name, p).await,
            "machines" => self.machines.action(c, name, p).await,
            _ => Err(ApiErr::gone("Unknown action")),
        };
        // show the effect right away; reading what's using the Mac changes nothing
        if !(id == "home" && matches!(name, "top" | "talkers")) { self.poke(id); }
        r
    }

    pub async fn terminal(&self, c: &Ctx, id: &str, p: &Value) -> ApiResult<Option<TermSpec>> {
        match id {
            "sessions" => Ok(self.sessions.terminal(c, p).await),
            "containers" => self.containers.terminal(c, p).await,
            "agents" => Ok(self.agents.terminal(c, p)),
            "machines" => self.machines.terminal(c, p),
            _ => Ok(None),
        }
    }

    fn interval(&self, id: &str) -> Duration {
        Duration::from_millis(match id {
            "sessions" | "coding" => 2000,
            "apps" | "machines" => 3000,
            "containers" | "home" => 5000,
            "agents" => if self.agents.any_running() { 1000 } else { 5000 },
            "limits" => 5 * 60_000,
            _ => 5000,
        })
    }

    pub fn poke(&self, id: &str) { if let Some(i) = idx(id) { self.pokes[i].notify_one(); } }

    /// The latest message of every source, for a page that just connected
    pub fn latest(&self) -> Vec<Arc<str>> { self.latest.lock().unwrap().values().map(|(_, m)| m.clone()).collect() }

    async fn poll(&self, c: &Ctx, id: &'static str) {
        match self.scan(c, id).await {
            Ok(data) => {
                let sig = data.to_string();
                let mut l = self.latest.lock().unwrap();
                if l.get(id).is_some_and(|(s, _)| *s == sig) { return; }
                let msg: Arc<str> = json!({ "type": "source", "id": id, "data": data }).to_string().into();
                l.insert(id, (sig, msg.clone()));
                drop(l);
                c.hub.send(msg);
            }
            Err(e) => eprintln!("Source {id}: {e}"),
        }
    }

    /// One loop per source: scans while someone is looking, sleeps otherwise
    pub async fn run(&'static self, c: &'static Ctx, id: &'static str) {
        let i = idx(id).unwrap();
        loop {
            if c.hub.clients() == 0 {
                tokio::select! { _ = c.hub.joined.notified() => {}, _ = self.pokes[i].notified() => {} }
                continue;
            }
            self.poll(c, id).await;
            tokio::select! {
                _ = tokio::time::sleep(self.interval(id)) => {}
                _ = self.pokes[i].notified() => {}
                _ = c.hub.joined.notified() => {}
            }
        }
    }
}

/// The error sources return for an id that isn't in their last scan
pub fn gone(msg: &str) -> ApiErr { ApiErr::gone(msg) }

pub fn unknown() -> ApiErr { ApiErr::gone("Unknown action") }

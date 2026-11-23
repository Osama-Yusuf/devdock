const express = require('express');
const { exec, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = +process.env.PORT || 4003;
const DEMO = process.env.DEVDOCK_DEMO === '1'; // seeded data for screenshots, see demo.js
const server = http.createServer(app);
// Only this Mac, only DevDock's own page: the Host check stops DNS rebinding, the Origin
// check stops other websites (a form POST or a WebSocket needs no CORS approval)
const OWN = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const isOwn = req => OWN.has(req.headers.host) && (!req.headers.origin || OWN.has(req.headers.origin.replace(/^http:\/\//, '')));
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isOwn(req) });

app.use((req, res, next) => isOwn(req) ? next() : res.status(403).end());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' })); // machine pictures arrive as small data URLs
// demo pids are made up and may match real processes: never act on them
if (DEMO) app.use(/^\/api\/(kill|restart|logs|start-server|sources\/(?!home\/))/, (req, res) => res.status(403).json({ error: 'Disabled in demo mode' }));

// ── Runtime definitions ──────────────────────────────────────────────
const RUNTIMES = {
  node: {
    name: 'Node.js',
    commands: ['node'],
    color: '#22c55e',
    icon: 'N',
    defaultEnabled: true,
  },
  python: {
    name: 'Python',
    commands: ['python', 'python3', 'python3.', 'uvicorn', 'gunicorn', 'flask', 'django'],
    color: '#3b82f6',
    icon: 'Py',
    defaultEnabled: true,
  },
  ruby: {
    name: 'Ruby',
    commands: ['ruby', 'puma', 'rails', 'unicorn', 'thin'],
    color: '#ef4444',
    icon: 'Rb',
    defaultEnabled: true,
  },
  java: {
    name: 'Java',
    commands: ['java'],
    color: '#f97316',
    icon: 'J',
    defaultEnabled: true,
  },
  go: {
    name: 'Go',
    commands: ['go', 'Google'],
    color: '#06b6d4',
    icon: 'Go',
    defaultEnabled: true,
  },
  php: {
    name: 'PHP',
    commands: ['php', 'php-fpm'],
    color: '#8b5cf6',
    icon: 'PHP',
    defaultEnabled: true,
  },
  rust: {
    name: 'Rust',
    commands: ['cargo'],
    color: '#f97316',
    icon: 'Rs',
    defaultEnabled: true,
  },
  dotnet: {
    name: '.NET',
    commands: ['dotnet'],
    color: '#7c3aed',
    icon: '.N',
    defaultEnabled: true,
  },
  docker: {
    name: 'Docker',
    commands: ['com.docke', 'docker-pr', 'docker'],
    color: '#0ea5e9',
    icon: 'D',
    defaultEnabled: true,
  },
  nginx: {
    name: 'Nginx',
    commands: ['nginx'],
    color: '#10b981',
    icon: 'Nx',
    defaultEnabled: false,
  },
  apache: {
    name: 'Apache',
    commands: ['httpd', 'apache2', 'apache'],
    color: '#dc2626',
    icon: 'Ap',
    defaultEnabled: false,
  },
  postgres: {
    name: 'PostgreSQL',
    commands: ['postgres', 'postmaste'],
    color: '#3b82f6',
    icon: 'PG',
    defaultEnabled: true,
  },
  mysql: {
    name: 'MySQL',
    commands: ['mysqld', 'mysql', 'mariadbd', 'mariadb'],
    color: '#f59e0b',
    icon: 'My',
    defaultEnabled: true,
  },
  redis: {
    name: 'Redis',
    commands: ['redis-ser', 'redis'],
    color: '#ef4444',
    icon: 'Rd',
    defaultEnabled: true,
  },
  mongo: {
    name: 'MongoDB',
    commands: ['mongod', 'mongos'],
    color: '#22c55e',
    icon: 'Mo',
    defaultEnabled: true,
  },
  other: {
    name: 'Other',
    commands: [],
    color: '#6b7280',
    icon: '?',
    defaultEnabled: false,
  },
};

// ── Settings persistence ─────────────────────────────────────────────
const SETTINGS_FILE = process.env.DEVDOCK_SETTINGS || path.join(__dirname, 'devdock-settings.json');

function getDefaultSettings() {
  const runtimes = {};
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    runtimes[key] = { enabled: rt.defaultEnabled };
  }
  return {
    runtimes,
    showOtherProcesses: false,
    showExport: false,
    favorites: [],
    theme: 'dark',
    notifications: true,
    groupByProject: false,
    groupingDepth: 1,
    showHistory: true,
    history: [],
    idleAfterHours: 24,   // 0 = never flag idle
    autoKillIdle: false,
    tmuxOpen: 'devdock',  // 'devdock' = in-app terminal, 'terminal' = Terminal.app
    editor: '',           // '' = first installed
    agentsEnabled: false, // "Ask an agent" stays hidden until turned on
    agent: '',            // '' = first installed
    agentReadOnly: false, // default access for new runs; each run can switch
  };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      const defaults = getDefaultSettings();
      for (const key of Object.keys(defaults.runtimes)) {
        if (!data.runtimes || !data.runtimes[key]) {
          if (!data.runtimes) data.runtimes = {};
          data.runtimes[key] = defaults.runtimes[key];
        }
      }
      return { ...defaults, ...data };
    }
  } catch (e) {
    // fall through
  }
  return getDefaultSettings();
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Runtime matching ─────────────────────────────────────────────────
function identifyRuntime(command) {
  const cmd = command.toLowerCase();
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    if (key === 'other') continue;
    for (const pattern of rt.commands) {
      if (cmd === pattern.toLowerCase() || cmd.startsWith(pattern.toLowerCase())) {
        return key;
      }
    }
  }
  return 'other';
}

// ── Runtime version ──────────────────────────────────────────────────
// Only interpreters/servers we recognise get asked for a version; we never
// run an unknown binary. Flag per runtime; output parsed for the first x.y[.z].
const VERSION_FLAGS = {
  node: '--version', python: '--version', ruby: '--version', php: '--version',
  java: '-version', dotnet: '--version', postgres: '--version', mysql: '--version',
  redis: '--version', mongo: '--version', nginx: '-v', apache: '-v',
};
// ponytail: cached per binary path for the server's lifetime; restart DevDock after upgrading a runtime in place
const versionCache = new Map();

function getVersion(runtime, exePath) {
  const flag = VERSION_FLAGS[runtime];
  if (!flag || !exePath || !exePath.startsWith('/')) return Promise.resolve(null);
  if (!versionCache.has(exePath)) {
    versionCache.set(exePath, new Promise(resolve => {
      execFile(exePath, [flag], { timeout: 3000 }, (err, stdout, stderr) => {
        const m = `${stdout || ''}\n${stderr || ''}`.match(/\d+\.\d+(?:\.\d+)?/);
        resolve(m ? m[0] : null);
      });
    }));
  }
  return versionCache.get(exePath);
}

// ── Who launched it ──────────────────────────────────────────────────
const AGENTS = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider',
  opencode: 'opencode', 'cursor-agent': 'Cursor Agent', amp: 'Amp', goose: 'Goose',
  droid: 'Droid', crush: 'Crush', qwen: 'Qwen Code', kiro: 'Kiro',
};

// Outermost bundle wins: ".../Visual Studio Code.app/.../Code Helper.app/..." -> "Visual Studio Code"
function appFromPath(p) {
  const m = p && p.match(/\/([^/]+?)\.app\//);
  return m ? m[1] : null;
}

// Agent name for a process's ps comm, or null
function agentOf(comm) {
  // "claude bg-pty-host" -> "claude"; ".../claude/versions/2.1.322" -> "claude"
  let base = path.basename(comm.split(' ')[0]).toLowerCase();
  if (/^\d+(\.\d+)+$/.test(base)) base = path.basename(path.dirname(path.dirname(comm.split(' ')[0]))).toLowerCase();
  return AGENTS[base] || null;
}

// What a Claude Code session is doing. Two sources Claude Code writes itself (checked live, v2.1.322):
//   ~/.claude/sessions/<pid>.json   status from the agent loop: running -> "busy",
//     requires_action -> "waiting" (a permission prompt or a question), idle -> "idle",
//     "shell" = idle with a background shell still running. Not always rewritten: a
//     session can keep saying "busy" for days after its last turn ended.
//   ~/.claude/projects/<cwd with non-alphanumerics as ->/<sessionId>.jsonl   the transcript.
//     Its last turn event says idle (turn_duration, stop_hook_summary, end_turn) or working
//     (a prompt, a tool call or result, an API request). Other lines get appended while idle.
// Whichever changed last wins; only the status file knows about prompts waiting on you.
const CLAUDE_STATUS = { busy: 'working', waiting: 'needs-you', idle: 'idle', shell: 'idle' };
const claudeCache = new Map(); // pid -> { key, state }
function lastTurnEvent(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; } // the first line is usually cut
      if (e.type === 'continued-in' && e.continuedInSessionId) return { next: e.continuedInSessionId };
      const at = Date.parse(e.timestamp);
      if (!at) continue;
      if (e.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(e.subtype)) return { status: 'idle', at };
      if (e.type === 'assistant') return { status: e.message?.stop_reason === 'end_turn' ? 'idle' : 'working', at };
      if (e.type === 'user' || e.type === 'api-request') return { status: 'working', at };
    }
  } catch {} finally { if (fd != null) fs.closeSync(fd); }
  return null;
}
function claudeState(pid) {
  const home = require('os').homedir();
  const f = path.join(home, '.claude/sessions', `${pid}.json`);
  let st;
  try { st = fs.statSync(f); } catch { claudeCache.delete(String(pid)); return null; }
  let d = {};
  const hit = claudeCache.get(String(pid));
  try { d = hit && hit.mtimeMs === st.mtimeMs ? hit.d : JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  // a /clear or compaction continues the session in a new transcript; follow the chain
  const dir = d.cwd && path.join(home, '.claude/projects', d.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let sid = (hit?.d === d && hit.sid) || d.sessionId, turn = null, tst = null;
  for (let i = 0; sid && dir && i < 20; i++) {
    const t = path.join(dir, `${sid}.jsonl`);
    try { tst = fs.statSync(t); } catch { tst = null; break; }
    if (hit?.sid === sid && hit.key === `${st.mtimeMs}|${tst.mtimeMs}|${tst.size}`) return hit.state;
    turn = lastTurnEvent(t);
    if (!turn?.next) break;
    sid = turn.next; turn = null;
  }
  const key = `${st.mtimeMs}|${tst?.mtimeMs}|${tst?.size}`;
  let state = null;
  const fileStatus = CLAUDE_STATUS[d.status];
  const fileAt = d.statusUpdatedAt || d.updatedAt || 0;
  if (turn && turn.at > fileAt + 2000) state = { status: turn.status, since: turn.at, bgShell: false };
  else if (fileStatus) state = { status: fileStatus, since: fileAt || null, bgShell: d.status === 'shell' };
  if (state) state.name = d.name || null;
  claudeCache.set(String(pid), { mtimeMs: st.mtimeMs, d, sid, key, state });
  return state;
}

// Nearest ancestor that is a known CLI agent or a macOS app
function findLauncher(pid, procs) {
  let cur = procs[pid]?.ppid;
  for (let i = 0; i < 25 && cur && cur !== '0' && cur !== '1'; i++) {
    const p = procs[cur];
    if (!p) break;
    const agent = agentOf(p.comm);
    if (agent) return { kind: 'agent', name: agent, pid: cur };
    const app = appFromPath(p.comm);
    if (app) return { kind: 'app', name: app, pid: cur };
    cur = p.ppid;
  }
  return null;
}

// .git dir for the repo containing dir (worktrees: .git is a file pointing at the real gitdir)
function findGitDir(dir) {
  for (let d = dir; d && d !== '/'; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    if (!fs.existsSync(dotGit)) continue;
    return fs.statSync(dotGit).isFile()
      ? path.resolve(d, fs.readFileSync(dotGit, 'utf-8').replace(/^gitdir:\s*/, '').trim())
      : dotGit;
  }
  return null;
}

function gitBranch(dir) {
  try {
    const gitDir = findGitDir(dir);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch {}
  return null;
}

// https://github.com/owner/repo for the origin remote, or null if it isn't on GitHub
function githubUrl(dir) {
  try {
    let gitDir = findGitDir(dir);
    if (!gitDir) return null;
    const common = path.join(gitDir, 'commondir'); // worktrees keep config in the main repo
    if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf-8').trim());
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf-8');
    const url = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
    const m = url?.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  } catch {}
  return null;
}

// Agent session label needs the agent's own cwd; agents live long, so cache per pid
const agentCwdCache = new Map();
function agentCwd(pid) {
  if (!agentCwdCache.has(pid)) {
    agentCwdCache.set(pid, new Promise(resolve => {
      execFile('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'], (err, out) => {
        const l = (out || '').split('\n').find(x => x.startsWith('n/'));
        resolve(l ? l.slice(1) : null);
      });
    }));
  }
  return agentCwdCache.get(pid);
}

// ── Idle tracking ────────────────────────────────────────────────────
// A process counts as active when it burned >2% CPU between two samples.
// ponytail: first sighting seeds from lifetime average (cpu time / age), so a
// server that was busy yesterday but averaged <2% looks idle since start.
// Upgrade path: persist samples across DevDock restarts.
const ACTIVE_RATE = 0.02;
const activity = new Map(); // pid -> { cpuSec, at, lastActive }

function trackActivity(pid, cpuSec, startedAt) {
  const now = Date.now();
  let a = activity.get(pid);
  if (!a) {
    const age = startedAt ? (now - startedAt) / 1000 : 0;
    const busy = !age || cpuSec / age > ACTIVE_RATE;
    a = { cpuSec, at: now, lastActive: busy ? now : startedAt };
    activity.set(pid, a);
  } else if (now - a.at >= 2000) { // ignore near-simultaneous polls
    if ((cpuSec - a.cpuSec) / ((now - a.at) / 1000) > ACTIVE_RATE) a.lastActive = now;
    a.cpuSec = cpuSec; a.at = now;
  }
  return a.lastActive;
}

// ── Port detection ───────────────────────────────────────────────────
// Everything here is fast (<100ms each) except `top`, which samples for
// ~2s; memory is refreshed from it in the background instead.
const SPLIT = '__DEVDOCK_SPLIT__';
function sh(cmd) {
  return new Promise(resolve => exec(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(out || '')));
}

// Activity Monitor's "Memory" column comes from top; refreshed every 5s.
// New pids fall back to RSS from ps until the next top sample lands.
let topMem = {};
async function refreshMemory() {
  const out = await sh('top -l 1 -stats pid,mem');
  const map = {};
  out.trim().split('\n').slice(12).forEach(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) return;
    const m = parts[1].match(/^([\d.]+)([KMG]?)/i);
    if (!m) return;
    const val = parseFloat(m[1]);
    const unit = (m[2] || '').toUpperCase();
    map[parts[0]] = Math.round((unit === 'K' ? val / 1024 : unit === 'G' ? val * 1024 : val) * 10) / 10;
  });
  topMem = map;
}

// Per-pid facts that don't change while the process lives: cwd, binary, version.
// ponytail: cwd is assumed fixed for a pid's life; a process that chdir()s keeps its first cwd.
const metaCache = new Map();

async function loadMeta(pids, runtimeOf) {
  const fresh = pids.filter(p => !metaCache.has(p));
  if (!fresh.length) return;
  // one lsof call for all new pids instead of one per pid
  const out = await sh(`lsof -a -p ${fresh.join(',')} -d cwd,txt -Fpfn`);
  const found = {};
  let pid = null, fd = null;
  out.split('\n').forEach(l => {
    if (l.startsWith('p')) { pid = l.slice(1); found[pid] = { cwdPath: null, exePath: null }; }
    else if (l.startsWith('f')) fd = l.slice(1);
    else if (l.startsWith('n/') && pid) {
      if (fd === 'cwd' && !found[pid].cwdPath) found[pid].cwdPath = l.slice(1);
      if (fd === 'txt' && !found[pid].exePath) found[pid].exePath = l.slice(1);
    }
  });
  await Promise.all(fresh.map(async p => {
    const m = found[p] || { cwdPath: null, exePath: null };
    m.version = await getVersion(runtimeOf[p], m.exePath);
    metaCache.set(p, m);
  }));
}

let latestProcs = {}; // full ps table from the last scan, shared with sources/

async function getAllPorts() {
  if (DEMO) {
    const ports = require('./demo').demoPorts(RUNTIMES);
    ports.forEach(p => { health[p.port] = p._health; delete p._health; });
    return ports;
  }
  // One spawn for everything: on some Macs each spawn costs ~80ms and blocks the event loop.
  // lstart is fixed-format in the C locale ("Thu Nov 19 07:10:16 2026"), comm comes last (may contain spaces).
  // tmux session names can't contain ':' or '.', so the session goes last
  const out = await sh(`lsof -iTCP -sTCP:LISTEN -P -n; echo ${SPLIT}; LC_ALL=C ps -axo pid=,ppid=,%cpu=,rss=,time=,lstart=,comm=; echo ${SPLIT}; tmux list-panes -a -F '#{pane_pid}:#{window_index}:#{pane_index}:#{session_name}' 2>/dev/null`);
  const [lsofOut, psOut = '', tmuxOut = ''] = out.split(SPLIT + '\n');
  const panes = {}; // shell pid of each tmux pane -> where it lives
  tmuxOut.split('\n').forEach(l => {
    const m = l.match(/^(\d+):(\d+):(\d+):(.+)$/);
    if (m) panes[m[1]] = { session: m[4], target: `${m[4]}:${m[2]}.${m[3]}` };
  });

  const procs = {}; // pid -> { ppid, comm, cpuSec, cpu, rssMB, startedAt }
  psOut.split('\n').forEach(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.]+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m) return;
    procs[m[1]] = {
      ppid: m[2],
      cpu: parseFloat(m[3]) || 0,
      rssMB: (parseInt(m[4]) || 0) / 1024,
      // time is [[hh:]mm:]ss.cc cumulative CPU
      cpuSec: m[5].split(':').reduce((a, v) => a * 60 + parseFloat(v), 0),
      startedAt: Date.parse(m[6]) || null,
      comm: m[7].trim(),
    };
  });

  const settings = loadSettings();
  const entries = [];
  const seenKeys = new Set();
  lsofOut.trim().split('\n').slice(1).forEach(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return;
    const [command, pid, user] = parts;
    const runtime = identifyRuntime(command);
    if (settings.runtimes[runtime] && !settings.runtimes[runtime].enabled) return;
    if (runtime === 'other' && !settings.showOtherProcesses) return;

    const addr = parts.find(p => p.includes(':')) || '';
    const candidate = addr.slice(addr.lastIndexOf(':') + 1);
    const port = /^\d+$/.test(candidate) ? parseInt(candidate, 10) : null;

    const key = `${pid}:${port}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    entries.push({ command, pid, user, port, runtime });
  });

  const runtimeOf = Object.fromEntries(entries.map(e => [e.pid, e.runtime]));
  await loadMeta([...new Set(entries.map(e => e.pid))], runtimeOf);

  const results = await Promise.all(entries.map(async ({ command, pid, user, port, runtime }) => {
    const { cwdPath, exePath, version } = metaCache.get(pid) || {};
    const proc = procs[pid] || {};
    const u = { cpu: proc.cpu || 0, rssMB: proc.rssMB || 0, startedAt: proc.startedAt || null };
    const launcher = findLauncher(pid, procs);
    let tmux = null; // nearest ancestor that is a tmux pane's shell
    for (let p = pid, i = 0; p && p !== '1' && i < 40 && !tmux; p = procs[p]?.ppid, i++) tmux = panes[p] || null;
    if (launcher?.kind === 'agent') launcher.cwd = await agentCwd(launcher.pid);
    const lastActive = proc.cpuSec != null ? trackActivity(pid, proc.cpuSec, u.startedAt) : null;
    const hasProject = !!cwdPath && cwdPath !== '/';
    const selfApp = appFromPath(proc.comm) || appFromPath(exePath);
    const rt = RUNTIMES[runtime];
    return {
      command, pid, user, port, runtime,
      runtimeName: rt.name, runtimeColor: rt.color, runtimeIcon: rt.icon,
      scriptPath: cwdPath || null,
      favorite: settings.favorites.includes(port),
      cpu: u.cpu,
      memMB: topMem[pid] ?? Math.round(u.rssMB * 10) / 10,
      startedAt: u.startedAt,
      exePath: exePath || null,
      version: version || null,
      procName: proc.comm ? path.basename(proc.comm) : command,
      launcher,
      // app that owns a process with no project dir (oMLX, Raycast, ...)
      appName: hasProject ? null : (launcher?.kind === 'app' ? launcher.name : selfApp),
      // parent exited: typically a dev server left behind by a closed terminal/agent session
      orphan: proc.ppid === '1' && hasProject && !selfApp,
      branch: hasProject ? gitBranch(cwdPath) : null,
      github: hasProject ? githubUrl(cwdPath) : null,
      tmux,
      ppid: proc.ppid || null,
      lastActive,
      // only project servers can be idle; apps (oMLX, Raycast) manage themselves
      idle: hasProject && !selfApp && settings.idleAfterHours > 0 && lastActive != null
        && Date.now() - lastActive >= settings.idleAfterHours * 3600 * 1000,
    };
  }));

  latestProcs = procs;
  // forget pids that are gone
  for (const pid of activity.keys()) if (!procs[pid]) activity.delete(pid);
  for (const pid of agentCwdCache.keys()) if (!procs[pid]) agentCwdCache.delete(pid);
  for (const pid of metaCache.keys()) if (!procs[pid]) metaCache.delete(pid);

  return results;
}

// ── Scanner: one loop, every client reads its snapshot ───────────────
// Up:   a listener must be seen in 2 scans (>=1s apart) before it is shown.
// Down: hidden at once if its process is gone; if the process is alive but
//       stopped listening, only after 2 misses in a row.
const SCAN_MS = 1000;
const tracked = new Map(); // "pid:port" -> { streak, missing, entry }
const transient = [];      // listeners that never lasted 2 scans (agent probes, tests)
let snapshot = null;
if (DEMO) transient.push(...require('./demo').demoTransient());
let firstScan = true;
let scanning = null;
let rescanQueued = false;

function pidAlive(pid) {
  try { process.kill(+pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function scan() {
  if (scanning) { rescanQueued = true; return scanning; }
  scanning = (async () => {
    const results = await getAllPorts();
    const now = Date.now();
    const live = new Set();
    for (const p of results) {
      const k = `${p.pid}:${p.port}`;
      live.add(k);
      const t = tracked.get(k) || { streak: firstScan ? 1 : 0 }; // already up when DevDock started
      t.streak++; t.missing = 0; t.entry = p;
      tracked.set(k, t);
    }
    for (const [k, t] of tracked) {
      if (live.has(k)) continue;
      t.missing++;
      const confirmed = t.streak >= 2;
      if (!confirmed || !pidAlive(t.entry.pid) || t.missing >= 2) {
        if (!confirmed) transient.unshift({ ...t.entry, at: now });
        tracked.delete(k);
      }
    }
    firstScan = false;
    transient.splice(50);
    for (const p of [...tracked.values()].map(t => t.entry)) if (!(p.port in health)) probeHealth(p.port);

    const ports = [...tracked.values()].filter(t => t.streak >= 2)
      .map(t => ({ ...t.entry, health: health[t.entry.port] || 'checking' }));
    snapshot = { timestamp: new Date(now).toISOString(), ports };
    recordHistory(ports, now);
    broadcast();
  })().catch(err => console.error('Scan error:', err)).finally(() => {
    scanning = null;
    if (rescanQueued) { rescanQueued = false; scan(); }
  });
  return scanning;
}


// History lives in the settings file; write it when the set of running
// ports changes, and otherwise at most every 30s to refresh lastSeen.
let lastHistoryKeys = '';
let lastHistoryWrite = 0;
function recordHistory(ports, now) {
  const keys = ports.map(p => `${p.port}:${p.scriptPath}`).sort().join(',');
  if (keys === lastHistoryKeys && now - lastHistoryWrite < 30000) return;
  lastHistoryKeys = keys; lastHistoryWrite = now;
  const settings = loadSettings();
  const seenAt = new Date(now).toISOString();
  const map = {};
  (settings.history || []).forEach(h => { map[`${h.port}:${h.scriptPath}`] = h; });
  ports.forEach(p => {
    map[`${p.port}:${p.scriptPath}`] = {
      port: p.port, command: p.command, user: p.user, runtime: p.runtime,
      runtimeName: p.runtimeName, runtimeColor: p.runtimeColor,
      runtimeIcon: p.runtimeIcon, scriptPath: p.scriptPath, lastSeen: seenAt,
    };
  });
  settings.history = Object.values(map).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
  saveSettings(settings);
}

function payload() {
  const settings = loadSettings();
  const ports = snapshot?.ports || [];
  const runningKeys = new Set(ports.map(p => `${p.port}:${p.scriptPath}`));
  const history = settings.showHistory !== false
    ? (settings.history || [])
        .filter(h => !runningKeys.has(`${h.port}:${h.scriptPath}`))
        .map(h => ({
          ...h, stopped: true,
          pathExists: h.scriptPath ? fs.existsSync(h.scriptPath) : false,
          favorite: settings.favorites.includes(h.port),
        }))
    : [];
  const cutoff = Date.now() - 10 * 60 * 1000;
  return {
    timestamp: snapshot?.timestamp || new Date().toISOString(),
    count: ports.length,
    ports,
    history,
    transient: transient.filter(t => t.at > cutoff),
  };
}

// Only push when something visible changed (cpu/mem included, timestamp not)
let lastSent = '';
function broadcast() {
  if (!wss.clients.size) { lastSent = ''; return; }
  const body = payload();
  const sig = JSON.stringify([body.ports, body.history.length, body.transient.length]);
  if (sig === lastSent) return;
  lastSent = sig;
  const msg = JSON.stringify({ type: 'ports', ...body });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// New clients get the current state right away instead of waiting for a change
wss.on('connection', (ws) => {
  if (snapshot) ws.send(JSON.stringify({ type: 'ports', ...payload() }));
});

// ── Health check ─────────────────────────────────────────────────────
// Probed in the background: new ports right away, the rest every 10s.
const health = {};
const probing = new Set();
async function probeHealth(port) {
  if (DEMO) return; // demo ports aren't real
  if (!port || probing.has(port)) return;
  probing.add(port);
  const status = await checkPortHealth(port);
  probing.delete(port);
  if (health[port] !== status) { health[port] = status; scan(); }
}
setInterval(() => {
  const live = new Set((snapshot?.ports || []).map(p => p.port));
  for (const port of Object.keys(health)) if (!live.has(+port)) delete health[port];
  live.forEach(probeHealth);
}, 10000);

// ── Health check ─────────────────────────────────────────────────────
function checkPortHealth(port) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      req.destroy();
      resolve('unknown');
    }, 2000);

    const req = http.get(`http://localhost:${port}`, (res) => {
      clearTimeout(timeout);
      resolve(res.statusCode < 500 ? 'healthy' : 'unhealthy');
    });

    req.on('error', () => {
      clearTimeout(timeout);
      resolve('unreachable');
    });
  });
}

// ── API routes ───────────────────────────────────────────────────────

app.get('/api/ports', async (req, res) => {
  if (!snapshot) await scan();
  res.json(payload());
});

// Cheap readiness check for the Electron shell
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Version, build and the newest release on GitHub. ponytail: says there is one and links it;
// installing stays a download, since the app isn't notarized for silent self-updates.
const { version: VERSION, build: BUILD } = require('./sources/version');
app.get('/api/version', (req, res) => res.json({ version: VERSION, build: BUILD }));
app.get('/api/update', async (req, res) => {
  try {
    const r = await fetch('https://api.github.com/repos/Osama-Yusuf/devdock/releases/latest', { headers: { 'User-Agent': 'DevDock', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
    const url = /^https:\/\/github\.com\/Osama-Yusuf\/devdock\//.test(rel.html_url) ? rel.html_url : 'https://github.com/Osama-Yusuf/devdock/releases/latest';
    res.json({ current: VERSION, latest, available: newer(latest, VERSION), url, published: rel.published_at });
  } catch (e) { res.status(502).json({ error: `Couldn't reach GitHub: ${e.message}` }); }
});

app.get('/api/health/:port', async (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const status = await checkPortHealth(port);
  res.json({ port, status });
});

app.get('/api/health', (req, res) => res.json(health));

app.post('/api/kill/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!pid || !/^\d+$/.test(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }
  if (+pid === process.pid || +pid === process.ppid) {
    return res.status(400).json({ error: 'Refusing to kill DevDock itself' });
  }
  exec(`kill ${pid}`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        error: `Failed to kill PID ${pid}`,
        details: stderr || err.message,
      });
    }
    res.json({ success: true, pid, message: `Process ${pid} killed` });
    setTimeout(scan, 150);
  });
});

app.post('/api/restart/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!pid || !/^\d+$/.test(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }
  // Send SIGHUP to restart
  exec(`kill -HUP ${pid}`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        error: `Failed to restart PID ${pid}`,
        details: stderr || err.message,
      });
    }
    res.json({ success: true, pid, message: `SIGHUP sent to ${pid}` });
  });
});

app.post('/api/start-server', (req, res) => {
  const dir = req.body.path;
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  // Check for package.json to determine start command
  const pkgPath = path.join(dir, 'package.json');
  let cmd = 'npm start';
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts && pkg.scripts.dev) cmd = 'npm run dev';
      else if (pkg.scripts && pkg.scripts.start) cmd = 'npm start';
    } catch {}
  }
  // Open a new terminal and run the command; the path goes in as an argument, never as script text
  execFile('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', `cd ${shq(dir)} && ${cmd}`], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to start server' });
    }
    res.json({ success: true, command: cmd });
  });
});

app.post('/api/open-terminal', (req, res) => {
  const dir = req.body.path;
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  // Verify directory exists before opening
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  // macOS: open Terminal.app at the given directory
  execFile('open', ['-a', 'Terminal', dir], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to open terminal' });
    }
    res.json({ success: true });
  });
});

// Tail a process's stdout/stderr when they go to files (agents' background tasks do).
// Terminal-attached processes only report their tty: their output isn't readable from outside.
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tmuxTargetOf = pid => (snapshot?.ports || []).find(p => p.pid === String(pid) && p.tmux)?.tmux;

// ── Sources: each extra view's data comes from a module in sources/ ──
// A source is create(ctx) -> {
//   id, intervalMs,
//   scan(): Promise<data>              polled; broadcast only when the JSON changes
//   actions: { name(params) }          POST /api/sources/:id/:action
//   terminal(params): {file, args}?    a command to open inside DevDock or Terminal
// }
// Sources validate every id they act on against their own last scan.
const os = require('os');
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin',
  path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin')];
// Apps opened from Finder get a bare PATH without Homebrew, so look in the usual places first
function findBin(name) {
  for (const dir of [...BIN_DIRS, ...(process.env.PATH || '').split(':')]) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return null;
}
// Never rejects: CLIs report "nothing here" through exit codes
function run(file, args, { timeout = 10000 } = {}) {
  return new Promise(resolve => execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' })));
}

const sourceCtx = {
  DEMO, run, findBin, agentOf, appFromPath, gitBranch, githubUrl, claudeState,
  cwdOf: agentCwd, // cached lsof cwd per pid
  procs: () => latestProcs,
  ports: () => snapshot?.ports || [],
  settings: loadSettings,
  binDirs: BIN_DIRS,
  source: id => sources[id],
};
const sources = Object.fromEntries(['sessions', 'containers', 'apps', 'coding', 'agents', 'home', 'machines']
  .map(id => [id, require(`./sources/${id}`)(sourceCtx)]));
const sourceState = {}; // id -> { msg, sig }

function sendSource(id, ws) {
  const st = sourceState[id];
  if (st && ws.readyState === 1) ws.send(st.msg);
}
async function pollSource(src) {
  clearTimeout(src._timer);
  if (src._busy) return src._busy;
  src._busy = (async () => {
    if (!wss.clients.size) return; // nobody is looking
    try {
      const data = await src.scan();
      const sig = JSON.stringify(data);
      if (sig === sourceState[src.id]?.sig) return;
      sourceState[src.id] = { sig, msg: JSON.stringify({ type: 'source', id: src.id, data }) };
      wss.clients.forEach(c => sendSource(src.id, c));
    } catch (e) { console.error(`Source ${src.id}:`, e.message); }
  })().finally(() => { src._busy = null; src._timer = setTimeout(() => pollSource(src), src.intervalMs); });
  return src._busy;
}
server.on('listening', () => Object.values(sources).forEach(pollSource));

// An app's icon as PNG (sources/apps.js); 404 means the page draws its initial
app.get('/api/app-icon/:pid', async (req, res) => {
  const file = await sources.apps.icon(req.params.pid).catch(() => null);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'max-age=86400');
  res.sendFile(file);
});

app.get('/api/machines/:id/picture', (req, res) => {
  const file = sources.machines.picturePath(req.params.id);
  file ? res.sendFile(file) : res.status(404).end();
});

app.post('/api/sources/:id/:action', async (req, res) => {
  const src = sources[req.params.id];
  const fn = src && Object.hasOwn(src.actions, req.params.action) && src.actions[req.params.action];
  if (!fn) return res.status(404).json({ error: 'Unknown action' });
  try {
    const result = await fn(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
  pollSource(src); // show the effect right away
});

// Same command a source would run inside DevDock, in a new Terminal window instead
app.post('/api/sources/:id/open-in-terminal', async (req, res) => {
  let spec;
  try { spec = await sources[req.params.id]?.terminal?.(req.body || {}); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  if (!spec) return res.status(404).json({ error: 'Nothing to open' });
  const cmd = [spec.file, ...spec.args].map(shq).join(' ');
  execFile('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', cmd],
    err => err ? res.status(500).json({ error: 'Failed to open Terminal' }) : res.json({ ok: true }));
});

// ── Terminals inside DevDock ─────────────────────────────────────────
// The source's command runs in a real pty (tmux attach, zellij attach, ...), rendered
// by xterm.js, so prefix keys, windows, copy mode and mouse behave like Terminal.
// Packaged, this file runs from app.asar.unpacked; node-pty appends ".unpacked" to its
// helper path itself, so load it through the asar path or it looks in "...unpacked.unpacked".
const ptyModule = __dirname.includes('app.asar.unpacked')
  ? path.join(__dirname.replace('app.asar.unpacked', 'app.asar'), 'node_modules', 'node-pty') : 'node-pty';
const NESTING_VARS = ['TMUX', 'TMUX_PANE', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'STY', 'HERDR_SESSION', 'HERDR_SOCKET_PATH'];

async function openTerm(ws, m) {
  closeTerm(ws);
  const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  let spec;
  try { spec = !DEMO && await sources[m.source]?.terminal?.(m.params || {}); }
  catch (e) { return send({ type: 'term-exit', reason: e.message }); }
  if (!spec) return send({ type: 'term-exit', reason: 'This session is gone' });
  const env = { ...process.env, TERM: 'xterm-256color' };
  NESTING_VARS.forEach(k => delete env[k]); // DevDock started inside a multiplexer would refuse to nest
  let term;
  try {
    term = require(ptyModule).spawn(spec.file, spec.args,
      { name: 'xterm-256color', cols: Math.max(20, m.cols | 0), rows: Math.max(5, m.rows | 0), cwd: spec.cwd || os.homedir(), env });
  } catch (e) { return send({ type: 'term-exit', reason: 'Could not start: ' + e.message }); }
  ws._term = term;
  // typed in, so it never shows in a command line; inputWhen waits until the far side is ready
  let input = spec.input;
  if (input && !spec.inputWhen) { term.write(input); input = null; }
  let blocked = false;
  term.onData(data => {
    // macOS's Local Network privacy shows up in ssh as this odd error
    if (!blocked && /connect to host .* Undefined error: 0/.test(data)) { blocked = true; data += '\r\n\x1b[33mmacOS kept DevDock off your local network. Turn on DevDock in System Settings > Privacy & Security > Local Network, then try again.\x1b[0m\r\n'; }
    if (input && data.includes(spec.inputWhen)) { term.write(input); input = null; }
    send({ type: 'term-out', data });
  });
  // a one-shot command (an install) or a failure keeps its output on screen; a detach just closes
  term.onExit(({ exitCode }) => { if (ws._term === term) { ws._term = null; send({ type: 'term-exit', reason: spec.keep || exitCode ? 'Ended' : 'Detached', code: exitCode }); } });
  send({ type: 'term-start' });
}
function closeTerm(ws) { const t = ws._term; ws._term = null; t?.kill(); }

wss.on('connection', (ws) => {
  Object.keys(sources).forEach(id => sendSource(id, ws));
  if (wss.clients.size === 1) Object.values(sources).forEach(pollSource); // first viewer: refresh now
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'term-open' && typeof m.source === 'string') openTerm(ws, m);
    else if (m.type === 'term-in' && typeof m.data === 'string') ws._term?.write(m.data);
    else if (m.type === 'term-resize') ws._term?.resize(Math.max(20, m.cols | 0), Math.max(5, m.rows | 0));
    else if (m.type === 'term-close') closeTerm(ws);
  });
  ws.on('close', () => closeTerm(ws));
});

app.get('/api/logs/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!/^\d+$/.test(pid)) return res.status(400).json({ error: 'Invalid PID' });
  // in tmux the output is the pane itself
  const t = tmuxTargetOf(pid);
  if (t) return execFile('tmux', ['capture-pane', '-p', '-J', '-S', '-500', '-t', '=' + t.target], (err, out) =>
    err ? res.json({ pid, logs: [], tty: null }) : res.json({ pid, logs: [{ file: `tmux pane ${t.target}`, text: out.replace(/\n+$/, '\n') }] }));
  execFile('lsof', ['-p', pid, '-a', '-d', '1,2', '-Fftn'], (err, out) => {
    const fds = [];
    let cur = null;
    (out || '').split('\n').forEach(l => {
      if (l.startsWith('f')) fds.push(cur = { fd: l.slice(1) });
      else if (cur && l.startsWith('t')) cur.type = l.slice(1);
      else if (cur && l.startsWith('n')) cur.name = l.slice(1);
    });
    const files = [...new Set(fds.filter(f => f.type === 'REG' && f.name?.startsWith('/')).map(f => f.name))];
    const tty = fds.find(f => f.type === 'CHR' && f.name?.startsWith('/dev/tty'))?.name || null;
    const MAX = 64 * 1024;
    const logs = files.map(file => {
      try {
        const size = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(MAX, size));
        fs.readSync(fd, buf, 0, buf.length, size - buf.length);
        fs.closeSync(fd);
        return { file, size, text: buf.toString('utf-8') };
      } catch (e) {
        return { file, error: e.message };
      }
    });
    res.json({ pid, logs, tty, piped: !files.length && !tty && fds.some(f => f.type === 'PIPE') });
  });
});

const EDITORS = ['Cursor', 'Visual Studio Code', 'Zed', 'Windsurf', 'Sublime Text', 'WebStorm', 'OpenCode'];
function installedEditors() {
  const dirs = ['/Applications', path.join(process.env.HOME || '', 'Applications')];
  return EDITORS.filter(e => dirs.some(d => fs.existsSync(path.join(d, `${e}.app`))));
}

app.get('/api/editors', (req, res) => res.json(DEMO ? ['Visual Studio Code', 'Cursor'] : installedEditors()));

app.post('/api/open-editor', (req, res) => {
  const dir = req.body.path;
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/') || !fs.existsSync(dir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const installed = installedEditors();
  const wanted = loadSettings().editor;
  const editor = installed.includes(wanted) ? wanted : installed[0];
  if (!editor) return res.status(404).json({ error: 'No supported editor installed' });
  execFile('open', ['-a', editor, dir], (err) => {
    if (err) return res.status(500).json({ error: `Failed to open ${editor}` });
    res.json({ success: true, editor });
  });
});

app.get('/api/settings', (req, res) => {
  res.json({ ...loadSettings(), home: require('os').homedir() }); // home: for ~ paths, never persisted
});

app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  if (req.body.runtimes) {
    updated.runtimes = { ...current.runtimes };
    for (const [key, val] of Object.entries(req.body.runtimes)) {
      updated.runtimes[key] = { ...current.runtimes[key], ...val };
    }
  }
  saveSettings(updated);
  res.json(updated);
  scan();
  pollSource(sources.agents); // turning agents on or off shows right away
});

app.post('/api/favorites/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  if (!settings.favorites.includes(port)) {
    settings.favorites.push(port);
  }
  saveSettings(settings);
  res.json({ favorites: settings.favorites });
});

app.delete('/api/favorites/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  settings.favorites = settings.favorites.filter(p => p !== port);
  saveSettings(settings);
  res.json({ favorites: settings.favorites });
});

app.delete('/api/history', (req, res) => {
  const settings = loadSettings();
  settings.history = [];
  saveSettings(settings);
  res.json({ success: true });
});

app.delete('/api/history/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  settings.history = (settings.history || []).filter(h => h.port !== port);
  saveSettings(settings);
  res.json({ success: true });
});

// Serve history page at clean /history route
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'history.html'));
});

app.get('/api/runtimes', (req, res) => {
  const runtimes = {};
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    runtimes[key] = {
      name: rt.name,
      color: rt.color,
      icon: rt.icon,
      commands: rt.commands,
    };
  }
  res.json(runtimes);
});

// Opt-in idle reaper. Never touches favorites, apps, or processes without a project dir.
setInterval(async () => {
  const settings = loadSettings();
  if (!settings.autoKillIdle || !(settings.idleAfterHours > 0)) return;
  const reaped = [];
  for (const p of snapshot?.ports || []) {
    if (!p.idle || p.favorite || +p.pid === process.pid || +p.pid === process.ppid) continue;
    try { process.kill(+p.pid, 'SIGTERM'); reaped.push({ port: p.port, pid: p.pid, path: p.scriptPath }); } catch {}
  }
  if (!reaped.length) return;
  console.log('Idle reaper killed', reaped);
  const payload = JSON.stringify({ type: 'reaped', reaped });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}, 60 * 1000);

// Start scanning before the first request so the first page load is instant
refreshMemory().then(() => scan()); // first snapshot gets real memory, later ones refresh in place
(async function loop() {
  await scan();
  setTimeout(loop, SCAN_MS);
})();
(async function memLoop() {
  await new Promise(r => setTimeout(r, 5000));
  await refreshMemory();
  memLoop();
})();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DevDock is running at http://localhost:${PORT}\n`);
});

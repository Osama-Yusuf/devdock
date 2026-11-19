const express = require('express');
const { exec, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = 4003;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
const SETTINGS_FILE = path.join(__dirname, 'devdock-settings.json');

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
    editor: '',           // '' = first installed
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

function getProcTable() {
  return new Promise(resolve => {
    exec('ps -axo pid=,ppid=,time=,comm=', { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      const procs = {};
      (out || '').split('\n').forEach(line => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/);
        // time is [[hh:]mm:]ss.cc cumulative CPU
        if (m) procs[m[1]] = { ppid: m[2], cpuSec: m[3].split(':').reduce((a, v) => a * 60 + parseFloat(v), 0), comm: m[4].trim() };
      });
      resolve(procs);
    });
  });
}

// Nearest ancestor that is a known CLI agent or a macOS app
function findLauncher(pid, procs) {
  let cur = procs[pid]?.ppid;
  for (let i = 0; i < 25 && cur && cur !== '0' && cur !== '1'; i++) {
    const p = procs[cur];
    if (!p) break;
    // "claude bg-pty-host" -> "claude"; ".../claude/versions/2.1.322" -> "claude"
    let base = path.basename(p.comm.split(' ')[0]).toLowerCase();
    if (/^\d+(\.\d+)+$/.test(base)) base = path.basename(path.dirname(path.dirname(p.comm.split(' ')[0]))).toLowerCase();
    if (AGENTS[base]) return { kind: 'agent', name: AGENTS[base], pid: cur };
    const app = appFromPath(p.comm);
    if (app) return { kind: 'app', name: app, pid: cur };
    cur = p.ppid;
  }
  return null;
}

function gitBranch(dir) {
  try {
    for (let d = dir; d && d !== '/'; d = path.dirname(d)) {
      const dotGit = path.join(d, '.git');
      if (!fs.existsSync(dotGit)) continue;
      // worktrees: .git is a file pointing at the real gitdir
      const gitDir = fs.statSync(dotGit).isFile()
        ? path.resolve(d, fs.readFileSync(dotGit, 'utf-8').replace(/^gitdir:\s*/, '').trim())
        : dotGit;
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
    }
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
function getAllPorts() {
  return new Promise((resolve) => {
    const cmd = 'lsof -iTCP -sTCP:LISTEN -P -n';

    exec(cmd, async (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      // Batch fetch memory from top (matches Activity Monitor)
      // and CPU from ps (top -l 1 always shows 0% CPU, needs 2 samples)
      const [procs, memMap, cpuMap] = await Promise.all([
        getProcTable(),
        new Promise(resolve2 => {
          exec('top -l 1 -stats pid,mem', (err2, out2) => {
            const map = {};
            if (err2 || !out2) return resolve2(map);
            out2.trim().split('\n').slice(12).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
                const memStr = parts[1];
                let memMB = 0;
                const match = memStr.match(/^([\d.]+)([KMG]?)$/i);
                if (match) {
                  const val = parseFloat(match[1]);
                  const unit = (match[2] || '').toUpperCase();
                  if (unit === 'K') memMB = val / 1024;
                  else if (unit === 'G') memMB = val * 1024;
                  else memMB = val;
                }
                map[parts[0]] = Math.round(memMB * 10) / 10;
              }
            });
            resolve2(map);
          });
        }),
        new Promise(resolve2 => {
          // lstart is fixed-format in the C locale, e.g. "Thu Nov 19 07:10:16 2026"
          exec('LC_ALL=C ps -eo pid=,%cpu=,lstart=', (err2, out2) => {
            const map = {};
            if (err2 || !out2) return resolve2(map);
            out2.trim().split('\n').forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                const started = Date.parse(parts.slice(2).join(' '));
                map[parts[0]] = { cpu: parseFloat(parts[1]) || 0, startedAt: started || null };
              }
            });
            resolve2(map);
          });
        }),
      ]);
      const usageMap = {};
      for (const pid of new Set([...Object.keys(memMap), ...Object.keys(cpuMap)])) {
        usageMap[pid] = { cpu: cpuMap[pid]?.cpu || 0, startedAt: cpuMap[pid]?.startedAt || null, memMB: memMap[pid] || 0 };
      }

      const lines = stdout.trim().split('\n');
      const settings = loadSettings();
      const results = [];
      const seen = new Set();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        const command = parts[0];
        const pid = parts[1];
        const user = parts[2];

        const runtime = identifyRuntime(command);

        if (settings.runtimes[runtime] && !settings.runtimes[runtime].enabled) continue;
        if (runtime === 'other' && !settings.showOtherProcesses) continue;

        const addr = parts.find(p => p.includes(':')) || '';
        let port = null;
        if (addr) {
          const lastColon = addr.lastIndexOf(':');
          if (lastColon !== -1) {
            const candidate = addr.slice(lastColon + 1);
            if (/^\d+$/.test(candidate)) {
              port = parseInt(candidate, 10);
            }
          }
        }

        const dedupeKey = `${pid}:${port}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // cwd = project dir; first txt entry = the executable itself
        const { cwdPath, exePath } = await new Promise(resolve2 => {
          exec(`lsof -p ${pid} -a -d cwd,txt -Fn`, (err2, out2) => {
            const found = { cwdPath: null, exePath: null };
            let fd = null;
            (out2 || '').split('\n').forEach(l => {
              if (l.startsWith('f')) fd = l.slice(1);
              else if (l.startsWith('n/')) {
                if (fd === 'cwd' && !found.cwdPath) found.cwdPath = l.slice(1);
                if (fd === 'txt' && !found.exePath) found.exePath = l.slice(1);
              }
            });
            resolve2(found);
          });
        });
        const version = await getVersion(runtime, exePath);

        const usage = usageMap[pid] || { cpu: 0, memMB: 0 };
        const proc = procs[pid] || {};
        const launcher = findLauncher(pid, procs);
        if (launcher?.kind === 'agent') launcher.cwd = await agentCwd(launcher.pid);
        const lastActive = proc.cpuSec != null ? trackActivity(pid, proc.cpuSec, usage.startedAt) : null;
        const hasProject = !!cwdPath && cwdPath !== '/';
        const selfApp = appFromPath(proc.comm) || appFromPath(exePath);
        const runtimeInfo = RUNTIMES[runtime];
        const isFavorite = settings.favorites.includes(port);

        results.push({
          command,
          pid,
          user,
          port,
          runtime,
          runtimeName: runtimeInfo.name,
          runtimeColor: runtimeInfo.color,
          runtimeIcon: runtimeInfo.icon,
          scriptPath: cwdPath,
          favorite: isFavorite,
          cpu: usage.cpu,
          memMB: usage.memMB,
          startedAt: usage.startedAt,
          exePath,
          version,
          procName: proc.comm ? path.basename(proc.comm) : command,
          launcher,
          // app that owns a process with no project dir (oMLX, Raycast, ...)
          appName: hasProject ? null : (launcher?.kind === 'app' ? launcher.name : selfApp),
          // parent exited: typically a dev server left behind by a closed terminal/agent session
          orphan: proc.ppid === '1' && hasProject && !selfApp,
          branch: hasProject ? gitBranch(cwdPath) : null,
          ppid: proc.ppid || null,
          lastActive,
          // only project servers can be idle; apps (oMLX, Raycast) manage themselves
          idle: hasProject && !selfApp && settings.idleAfterHours > 0 && lastActive != null
            && Date.now() - lastActive >= settings.idleAfterHours * 3600 * 1000,
        });
      }

      // forget pids that are gone
      const live = new Set(results.map(r => r.pid));
      for (const pid of activity.keys()) if (!live.has(pid)) activity.delete(pid);
      for (const pid of agentCwdCache.keys()) if (!procs[pid]) agentCwdCache.delete(pid);

      resolve(results);
    });
  });
}

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
  try {
    const ports = await getAllPorts();
    const settings = loadSettings();

    // Update history with currently running ports
    const now = new Date().toISOString();
    const historyMap = {};
    (settings.history || []).forEach(h => { historyMap[`${h.port}:${h.scriptPath}`] = h; });

    ports.forEach(p => {
      const key = `${p.port}:${p.scriptPath}`;
      historyMap[key] = {
        port: p.port,
        command: p.command,
        user: p.user,
        runtime: p.runtime,
        runtimeName: p.runtimeName,
        runtimeColor: p.runtimeColor,
        runtimeIcon: p.runtimeIcon,
        scriptPath: p.scriptPath,
        lastSeen: now,
      };
    });

    // Keep last 50 history entries, sorted by lastSeen
    settings.history = Object.values(historyMap)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 50);
    saveSettings(settings);

    // Build history list: entries not currently running
    const runningKeys = new Set(ports.map(p => `${p.port}:${p.scriptPath}`));
    const history = settings.showHistory !== false
      ? settings.history
          .filter(h => !runningKeys.has(`${h.port}:${h.scriptPath}`))
          .map(h => ({
            ...h,
            stopped: true,
            pathExists: h.scriptPath ? fs.existsSync(h.scriptPath) : false,
            favorite: settings.favorites.includes(h.port),
          }))
      : [];

    res.json({
      timestamp: now,
      count: ports.length,
      ports,
      history,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/health/:port', async (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const status = await checkPortHealth(port);
  res.json({ port, status });
});

app.get('/api/health', async (req, res) => {
  try {
    const ports = await getAllPorts();
    const checks = await Promise.all(
      ports.filter(p => p.port).map(async (p) => ({
        port: p.port,
        status: await checkPortHealth(p.port),
      }))
    );
    const healthMap = {};
    checks.forEach(c => { healthMap[c.port] = c.status; });
    res.json(healthMap);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

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
  // Open a new terminal and run the command
  exec(`open -a Terminal "${dir}" && sleep 0.5 && osascript -e 'tell application "Terminal" to do script "cd \\"${dir}\\" && ${cmd}" in front window'`, (err) => {
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
  exec(`open -a Terminal "${dir}"`, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to open terminal' });
    }
    res.json({ success: true });
  });
});

// Tail a process's stdout/stderr when they go to files (agents' background tasks do).
// Terminal-attached processes only report their tty: their output isn't readable from outside.
app.get('/api/logs/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!/^\d+$/.test(pid)) return res.status(400).json({ error: 'Invalid PID' });
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

app.get('/api/editors', (req, res) => res.json(installedEditors()));

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

// ── WebSocket broadcast ──────────────────────────────────────────────
async function broadcastPorts() {
  if (wss.clients.size === 0) return;

  try {
    const ports = await getAllPorts();
    const settings = loadSettings();
    const now = new Date().toISOString();

    // Update history
    const historyMap = {};
    (settings.history || []).forEach(h => { historyMap[`${h.port}:${h.scriptPath}`] = h; });
    ports.forEach(p => {
      historyMap[`${p.port}:${p.scriptPath}`] = {
        port: p.port, command: p.command, user: p.user, runtime: p.runtime,
        runtimeName: p.runtimeName, runtimeColor: p.runtimeColor,
        runtimeIcon: p.runtimeIcon, scriptPath: p.scriptPath, lastSeen: now,
      };
    });
    settings.history = Object.values(historyMap)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
    saveSettings(settings);

    const runningKeys = new Set(ports.map(p => `${p.port}:${p.scriptPath}`));
    const history = settings.showHistory !== false
      ? settings.history
          .filter(h => !runningKeys.has(`${h.port}:${h.scriptPath}`))
          .map(h => ({
            ...h, stopped: true,
            pathExists: h.scriptPath ? fs.existsSync(h.scriptPath) : false,
            favorite: settings.favorites.includes(h.port),
          }))
      : [];

    const payload = JSON.stringify({
      type: 'ports',
      timestamp: now,
      count: ports.length,
      ports,
      history,
    });

    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(payload);
    });
  } catch (err) {
    console.error('Broadcast error:', err);
  }
}

setInterval(broadcastPorts, 3000);

// Opt-in idle reaper. Never touches favorites, apps, or processes without a project dir.
setInterval(async () => {
  const settings = loadSettings();
  if (!settings.autoKillIdle || !(settings.idleAfterHours > 0)) return;
  const reaped = [];
  for (const p of await getAllPorts()) {
    if (!p.idle || p.favorite || +p.pid === process.pid || +p.pid === process.ppid) continue;
    try { process.kill(+p.pid, 'SIGTERM'); reaped.push({ port: p.port, pid: p.pid, path: p.scriptPath }); } catch {}
  }
  if (!reaped.length) return;
  console.log('Idle reaper killed', reaped);
  const payload = JSON.stringify({ type: 'reaped', reaped });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  DevDock is running at http://localhost:${PORT}\n`);
});

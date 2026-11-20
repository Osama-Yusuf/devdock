// Seeded data for README screenshots: `DEVDOCK_DEMO=1 PORT=4010 node server.js`.
// Every row goes through the real UI (grouping, duplicates, idle, orphans, pills);
// only the process scan is replaced, so nothing from this machine shows up.
const os = require('os');

const HOME = os.homedir();
const min = 60 * 1000, hour = 60 * min, day = 24 * hour;

const claude = { kind: 'agent', name: 'Claude Code', pid: 41200, cwd: `${HOME}/code/storefront` };
const codex = { kind: 'agent', name: 'Codex', pid: 52310, cwd: `${HOME}/code/storefront` };
const postgresApp = { kind: 'app', name: 'Postgres', pid: 812 };

const SERVERS = [
  { port: 3000, pid: 41388, ppid: 41201, runtime: 'node', procName: 'next-server', version: '22.11.0',
    path: 'code/storefront/apps/web', branch: 'feat/checkout', launcher: claude, cpu: 3.1, memMB: 612, up: 42 * min, health: 'healthy', favorite: true },
  { port: 4000, pid: 41402, ppid: 41201, runtime: 'node', procName: 'node', version: '22.11.0',
    path: 'code/storefront/apps/api', branch: 'feat/checkout', launcher: claude, cpu: 0.8, memMB: 188, up: 41 * min, health: 'healthy' },
  { port: 6006, pid: 41530, ppid: 41201, runtime: 'node', procName: 'storybook', version: '22.11.0',
    path: 'code/storefront/packages/ui', branch: 'feat/checkout', launcher: claude, cpu: 0.2, memMB: 344, up: 38 * min, health: 'healthy' },
  // a second agent started the same app again on the next free port
  { port: 3001, pid: 52477, ppid: 52311, runtime: 'node', procName: 'next-server', version: '22.11.0',
    path: 'code/storefront/apps/web', branch: 'feat/checkout', launcher: codex, cpu: 2.4, memMB: 590, up: 9 * min, health: 'healthy' },
  // terminal closed days ago, server kept running
  { port: 8000, pid: 23117, ppid: 1, runtime: 'python', procName: 'uvicorn', version: '3.12.7',
    path: 'code/billing', branch: 'feat/invoices', orphan: true, cpu: 0, memMB: 96, up: 3 * day, idleFor: 3 * day, health: 'healthy' },
  { port: 5173, pid: 30552, ppid: 30410, runtime: 'node', procName: 'vite', version: '22.11.0',
    path: 'code/docs', branch: 'main', tmux: { session: 'docs', target: 'docs:0.0' }, cpu: 0, memMB: 142, up: 2 * day, idleFor: 2 * day, health: 'healthy' },
  { port: 8080, pid: 38804, ppid: 38790, runtime: 'go', procName: 'mobile-api', version: '1.23.2',
    path: 'code/mobile-api', branch: 'main', tmux: { session: 'api', target: 'api:1.0' }, cpu: 1.2, memMB: 38, up: 3 * hour, health: 'healthy' },
  { port: 5432, pid: 901, ppid: 812, runtime: 'postgres', procName: 'postgres', version: '16.4',
    path: null, appName: 'Postgres', launcher: postgresApp, cpu: 0.1, memMB: 74, up: 5 * day, health: 'unreachable' },
];

function demoPorts(RUNTIMES) {
  const now = Date.now();
  return SERVERS.map(s => {
    const rt = RUNTIMES[s.runtime];
    return {
      command: s.procName.slice(0, 9), pid: String(s.pid), user: 'dev', port: s.port, runtime: s.runtime,
      runtimeName: rt.name, runtimeColor: rt.color, runtimeIcon: rt.icon,
      scriptPath: s.path ? `${HOME}/${s.path}` : '/',
      favorite: !!s.favorite, cpu: s.cpu, memMB: s.memMB,
      startedAt: now - s.up, exePath: null, version: s.version, procName: s.procName,
      launcher: s.launcher || null, appName: s.appName || null, orphan: !!s.orphan,
      branch: s.branch || null, github: s.path?.startsWith('code/storefront') ? 'https://github.com/acme/storefront' : null, ppid: String(s.ppid), tmux: s.tmux || null,
      lastActive: now - (s.idleFor || 0), idle: !!s.idleFor,
      _health: s.health,
    };
  });
}

// listeners that came and went (test runs, health probes)
function demoTransient() {
  const now = Date.now();
  return [
    { port: 49231, pid: '41907', procName: 'node', command: 'node', launcher: claude, at: now - 2 * min },
    { port: 49240, pid: '41933', procName: 'node', command: 'node', launcher: claude, at: now - 2 * min },
    { port: 52114, pid: '52690', procName: 'python3', command: 'python3', launcher: codex, at: now - 6 * min },
  ];
}

// ── The other tabs ──────────────────────────────────────────────────
const at = ago => Date.now() - ago;
const gh = repo => `https://github.com/acme/${repo}`;

function demoSessions() {
  const base = { state: 'running', canOpen: true, canShow: true, canKill: true, canRename: true, idle: false };
  const rows = [
    { mux: 'tmux', id: 'storefront', attached: true, createdAt: at(5 * hour), lastActive: at(20 * 1000), windows: 3, panes: 4,
      cwd: `${HOME}/code/storefront`, branch: 'feat/checkout', github: gh('storefront'), agents: ['Claude Code'],
      agentState: { status: 'working', since: at(3 * min) }, ports: [3000, 4000, 6006] },
    { mux: 'tmux', id: 'api', attached: false, createdAt: at(3 * hour), lastActive: at(12 * min), windows: 2, panes: 2,
      cwd: `${HOME}/code/mobile-api`, branch: 'main', github: gh('mobile-api'), agents: [], agentState: null, ports: [8080] },
    { mux: 'tmux', id: 'docs', attached: false, createdAt: at(2 * day), lastActive: at(2 * day), windows: 1, panes: 1,
      cwd: `${HOME}/code/docs`, branch: 'main', github: gh('docs'), agents: [], agentState: null, ports: [5173], idle: true },
    { mux: 'herdr', id: 't3', name: 'storefront / payments', attached: null, createdAt: at(26 * hour), lastActive: null, canRename: false,
      cwd: `${HOME}/code/storefront`, branch: 'feat/payments', github: gh('storefront'), agents: ['Claude Code'],
      agentState: { status: 'needs-you', since: at(4 * min) }, ports: [] },
    { mux: 'herdr', id: 't5', name: 'billing / invoices', attached: null, createdAt: at(3 * day), lastActive: null, canRename: false,
      cwd: `${HOME}/code/billing`, branch: 'feat/invoices', github: gh('billing'), agents: ['Codex'], agentState: { status: 'idle', since: null }, ports: [] },
    { mux: 'herdr', id: 't6', name: 'design-system / tokens', attached: null, createdAt: at(4 * day), lastActive: null, canRename: false,
      cwd: `${HOME}/code/design-system`, branch: 'chore/tokens', github: gh('design-system'), agents: ['Claude Code'],
      agentState: { status: 'idle', since: at(40 * min) }, ports: [] },
  ];
  return {
    sessions: rows.map(r => ({ ...base, name: r.id, ...r, key: `${r.mux}:${r.id}` })),
    muxes: [{ mux: 'tmux', label: 'tmux', available: true }, { mux: 'herdr', label: 'Herdr', available: true }, { mux: 'zellij', label: 'Zellij', available: false }],
  };
}

function demoAgents() {
  const a = (pid, agent, name, state, cwd, branch, where, up, memMB, processes, ports = []) => ({
    pid: String(pid), agent, name, state, cwd: `${HOME}/code/${cwd}`, branch, where,
    sessionId: agent === 'Claude Code' ? `5f0c${pid}-demo` : null, startedAt: at(up), cpu: 0, memMB, processes, ports,
  });
  return { agents: [
    a(41200, 'Claude Code', 'storefront', { status: 'working', since: at(3 * min) }, 'storefront', 'feat/checkout', { mux: 'tmux', id: 'storefront', name: 'storefront', target: '0.0' }, 5 * hour, 1210, 9, [3000, 4000, 6006]),
    a(44710, 'Claude Code', 'payments', { status: 'needs-you', since: at(4 * min) }, 'storefront', 'feat/payments', { mux: 'herdr', id: 't3', name: 'storefront / payments' }, 26 * hour, 402, 3),
    a(52310, 'Codex', 'storefront', null, 'storefront', 'feat/checkout', { app: 'Ghostty' }, 9 * min, 640, 4, [3001]),
    a(47002, 'Claude Code', 'review-bot', { status: 'working', since: at(1 * min) }, 'storefront', 'feat/checkout', { background: true }, 14 * min, 318, 2),
    a(39920, 'Claude Code', 'tokens', { status: 'idle', since: at(40 * min) }, 'design-system', 'chore/tokens', { mux: 'herdr', id: 't6', name: 'design-system / tokens' }, 4 * day, 287, 1),
    a(36114, 'Claude Code', 'mobile-api', { status: 'idle', since: at(2 * hour) }, 'mobile-api', 'main', { app: 'Ghostty' }, 7 * hour, 344, 2),
    a(30071, 'Codex', 'invoices', null, 'billing', 'feat/invoices', { mux: 'herdr', id: 't5', name: 'billing / invoices' }, 3 * day, 120, 2),
    a(22981, 'OpenCode', 'billing', null, 'billing', 'feat/invoices', { detached: true, parent: null }, 3 * day, 96, 1),
  ] };
}

// Real app bundles on this Mac give the icons; everything else is made up
function demoApps() {
  const GB = 1024;
  const app = (name, kind, path, bundleId, memMB, cpu, procs, extra = {}) => ({
    name, kind, path, bundleId, memMB, cpu, pid: String(1000 + name.length * 37 + memMB % 97),
    launchedAt: at(extra.up || 2 * day), front: !!extra.front, arch: 'ARM64', version: extra.version || null,
    electron: !!extra.electron, system: !!extra.system, user: false, ports: extra.ports || [],
    processes: Array.from({ length: procs }, (_, i) => ({ pid: String(2000 + i + name.length * 50), name: i ? `${name} Helper` : name, own: true, cpu: i ? 0.1 : cpu, memMB: Math.round(memMB / procs), startedAt: at(extra.up || 2 * day) })),
  });
  return { apps: [
    app('Google Chrome', 'app', '/Applications/Google Chrome.app', 'com.google.Chrome', 3.4 * GB, 12.1, 31, { version: '142.0.7444.60' }),
    app('Slack', 'app', '/Applications/Slack.app', 'com.tinyspeck.slackmacgap', 1.2 * GB, 1.4, 7, { version: '4.47.59', electron: true }),
    app('Zed', 'app', '/Applications/Zed.app', 'dev.zed.Zed', 880, 2.2, 4, { version: '0.211.4', up: 6 * hour }),
    app('Ghostty', 'app', '/Applications/Ghostty.app', 'com.mitchellh.ghostty', 640, 3.8, 3, { version: '1.3.1', front: true, up: 9 * hour }),
    app('Notion', 'app', '/Applications/Notion.app', 'notion.id', 590, 0.6, 6, { version: '6.2.0', electron: true, up: 1 * day }),
    app('OrbStack', 'app', '/Applications/OrbStack.app', 'dev.kdrag0n.MacVirt', 410, 1.1, 5, { version: '2.0.4', ports: [5432, 6379], up: 5 * day }),
    app('Raycast', 'menu', '/Applications/Raycast.app', 'com.raycast.macos', 260, 0.3, 3, { version: '1.104.1', up: 9 * day }),
    app('1Password', 'menu', '/Applications/1Password.app', 'com.1password.1password', 230, 0.2, 3, { version: '8.11.16', electron: true, up: 9 * day }),
    app('Notes', 'app', '/System/Applications/Notes.app', 'com.apple.Notes', 180, 0, 2, { version: '4.13', system: true, up: 3 * day }),
  ] };
}

function demoContainers() {
  const MB = 1024 * 1024;
  const c = (id, name, image, state, status, project, ports, size, up, volumes = []) => ({
    id: id.padEnd(64, '0'), name, image, imageId: `sha256:${image}`, state, status, createdAt: at(up), lastUsed: state === 'running' ? Date.now() : at(up / 2),
    size, project, k8s: null, ports, volumes,
  });
  const containers = [
    c('a1f3', 'storefront-db-1', 'postgres:16', 'running', 'Up 5 days', 'storefront', [5432], 63 * MB, 5 * day, ['storefront_pgdata']),
    c('b7e2', 'storefront-redis-1', 'redis:7-alpine', 'running', 'Up 5 days', 'storefront', [6379], 2 * MB, 5 * day),
    c('c9d0', 'storefront-mailpit-1', 'axllent/mailpit', 'running', 'Up 5 days', 'storefront', [8025], 1 * MB, 5 * day),
    c('d4a8', 'billing-db-1', 'postgres:15', 'exited', 'Exited (0) 3 weeks ago', 'billing', [], 41 * MB, 30 * day, ['billing_pgdata']),
    c('e2c6', 'nostalgic_hopper', 'node:22', 'exited', 'Exited (1) 2 weeks ago', null, [], 210 * MB, 16 * day),
  ];
  const img = (tag, size, users, running) => ({ id: `sha256:${tag}`, tags: tag ? [tag] : [], size: size * MB, unique: size * MB, createdAt: at(20 * day), containers: users, running, lastUsed: users ? Date.now() : null });
  const images = [img('postgres:16', 438, 1, true), img('redis:7-alpine', 41, 1, true), img('axllent/mailpit', 32, 1, true), img('postgres:15', 412, 1, false), img('node:22', 1120, 1, false), img('', 980, 0, false), img('python:3.12-slim', 155, 0, false)];
  const volumes = [
    { name: 'storefront_pgdata', size: 312 * MB, containers: 1, createdAt: at(40 * day), running: true, lastUsed: Date.now(), anonymous: false, project: 'storefront' },
    { name: 'billing_pgdata', size: 128 * MB, containers: 1, createdAt: at(60 * day), running: false, lastUsed: at(21 * day), anonymous: false, project: 'billing' },
    { name: '9c1e'.padEnd(64, 'a'), size: 54 * MB, containers: 0, createdAt: at(50 * day), running: false, lastUsed: null, anonymous: true, project: null },
  ];
  return {
    available: true, k8sContext: null, containers, images, volumes,
    buildCache: { count: 48, size: 2400 * MB, reclaimable: 1900 * MB, lastUsed: at(2 * day) },
    reclaimable: {
      containers: { count: 2, size: 251 * MB }, images: { count: 2, size: 1135 * MB }, dangling: { count: 1, size: 980 * MB },
      volumes: { count: 1, size: 54 * MB }, build: { count: 40, size: 1900 * MB },
    },
  };
}

module.exports = { demoPorts, demoTransient, demoSessions, demoAgents, demoApps, demoContainers };

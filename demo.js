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
    service: project ? name.slice(project.length + 1).replace(/-\d+$/, '') : null,
    composeDir: project ? `${HOME}/code/${project}` : null, composeFiles: project ? [`${HOME}/code/${project}/compose.yaml`] : [],
  });
  const containers = [
    c('a1f3', 'storefront-db-1', 'postgres:16', 'running', 'Up 5 days', 'storefront', [5432], 63 * MB, 5 * day, ['storefront_pgdata']),
    c('b7e2', 'storefront-redis-1', 'redis:7-alpine', 'running', 'Up 5 days', 'storefront', [6379], 2 * MB, 5 * day),
    c('c9d0', 'storefront-mailpit-1', 'axllent/mailpit', 'running', 'Up 5 days', 'storefront', [8025], 1 * MB, 5 * day),
    c('d4a8', 'billing-db-1', 'postgres:15', 'exited', 'Exited (0) 3 weeks ago', 'billing', [], 41 * MB, 30 * day, ['billing_pgdata']),
    c('e2c6', 'nostalgic_hopper', 'node:22', 'exited', 'Exited (1) 2 weeks ago', null, [], 210 * MB, 16 * day),
  ];
  // usage history like sources/containers.js keeps: 30 points over 15 minutes
  const wave = (base, amp, k) => Array.from({ length: 30 }, (_, i) => Math.max(0, Math.round((base + amp * Math.sin(i * k) + amp * 0.4 * Math.sin(i * k * 3.1)) * 10) / 10));
  const use = (cpu, mem, rx, tx, k) => ({ cpu, mem, limit: 16384, rx, tx, cpuSpark: wave(cpu, cpu * 0.6, k), memSpark: wave(mem, mem * 0.04, k / 3), rxSpark: wave(rx, rx * 0.5, k), txSpark: wave(tx, tx * 0.5, k) });
  const stats = { 'storefront-db-1': use(3.2, 182, 4200, 9800, 0.7), 'storefront-redis-1': use(0.6, 9, 1300, 1100, 1.3), 'storefront-mailpit-1': use(0.1, 22, 40, 0, 0.4) };
  containers.forEach(x => { if (stats[x.name]) x.stats = stats[x.name]; });
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

// Home: what the rules in sources/home.js find after a while of watching
function demoHome() {
  const srv = (pid, name, ports, path, branch, runtime = 'node', runtimeColor = '#22c55e') =>
    ({ kind: 'server', pid: String(pid), name, ports, cwd: `${HOME}/code/${path}`, branch, runtime, runtimeColor });
  const agent = (pid, name, agentName, path, branch, where) =>
    ({ kind: 'agent', pid: String(pid), name, agent: agentName, cwd: `${HOME}/code/${path}`, branch, where, ports: [] });
  const wave = (n, base, amp, drift = 0) => Array.from({ length: n }, (_, i) => Math.round(base + drift * i + amp * Math.sin(i * 1.7) * (i % 3 ? 1 : -0.6)));
  return {
    items: [
      { id: 'cpu:p41388', type: 'cpu', severity: 'critical', subject: srv(41388, 'next-server', [3000], 'storefront/apps/web', 'feat/checkout'),
        since: at(7 * min), value: 246, spark: [4, 6, 3, 5, 38, 120, 210, 232, 251, 240, 244, 255, 238, 249, 252, 241, 236, 250, 248, 243, 251, 239, 246, 247] },
      { id: 'mem:p41530', type: 'mem', severity: 'critical', subject: srv(41530, 'storybook', [6006], 'storefront/packages/ui', 'feat/checkout'),
        since: at(14 * min), value: 1840, from: 1120, rate: 51, spark: wave(24, 1120, 18, 31) },
      { id: 'crash:storefront-worker', type: 'crash', severity: 'critical',
        subject: { kind: 'container', id: 'f00d'.padEnd(64, '0'), name: 'storefront-worker-1', image: 'storefront-worker:dev', status: 'Restarting (5) 12 seconds ago' },
        since: at(4 * min), value: 5 },
      { id: 'needs:44710', type: 'needs-you', severity: 'needs-you', since: at(4 * min),
        subject: agent(44710, 'payments', 'Claude Code', 'storefront', 'feat/payments', { mux: 'herdr', id: 't3', name: 'storefront / payments' }) },
      { id: 'done:39920', type: 'finished', severity: 'done', since: at(6 * min),
        subject: agent(39920, 'tokens', 'Claude Code', 'design-system', 'chore/tokens', { mux: 'herdr', id: 't6', name: 'design-system / tokens' }) },
      { id: 'forgotten:22981,23117', type: 'forgotten', severity: 'tidy', value: 216, subjects: [
        { ...srv(23117, 'uvicorn', [8000], 'billing', 'feat/invoices', 'python', '#3b82f6'), memMB: 96, idleSince: at(3 * day) },
        { ...agent(22981, 'billing', 'OpenCode', 'billing', 'feat/invoices', { detached: true }), memMB: 120, idleSince: at(3 * day) },
      ] },
      { id: 'dup:41388,52477', type: 'duplicate', severity: 'tidy', name: 'web', cwd: `${HOME}/code/storefront/apps/web`, subjects: [
        srv(41388, 'next-server', [3000], 'storefront/apps/web', 'feat/checkout'), srv(52477, 'next-server', [3001], 'storefront/apps/web', 'feat/checkout'),
      ] },
    ],
    vitals: { servers: 7, agents: 8, working: 2, needsYou: 1, cpu: 318, mem: 5940, cores: 12, totalMem: 36864,
      net: { iface: 'en0', rx: 2.4e6, tx: 310e3, lan: '192.168.1.42', tailscale: '100.101.7.23',
        rxSpark: wave(24, 1.6e6, 7e5, 3e4), txSpark: wave(24, 2.6e5, 9e4, 2e3) },
      cpuSpark: [40, 42, 38, 51, 60, 140, 230, 262, 281, 300, 296, 310, 305, 298, 312, 320, 309, 315, 322, 311, 318, 314, 320, 318],
      memSpark: wave(24, 5100, 40, 36) },
  };
}

function demoTalkers() {
  const t = (name, rx, tx, pids) => ({ name, rx, tx, pids: pids.map(String) });
  return { at: Date.now(), apps: [
    t('Google Chrome', 1.7e6, 92e3, [3101, 3102]), t('OrbStack', 410e3, 120e3, [812]), t('Claude Code', 180e3, 41e3, [41200, 44710]),
    t('Slack', 64e3, 12e3, [2200]), t('next-server', 22e3, 31e3, [41388]), t('mDNSResponder', 4e3, 2e3, [495]),
  ] };
}

// Machines tab: three servers, one waiting to pair
function demoMachines() {
  const wave = (n, base, amp, k = 0) => Array.from({ length: n }, (_, i) => +(base + amp * Math.sin((i + k) / 3) + amp * .4 * Math.sin((i + k) * 1.7)).toFixed(1));
  const G = 2 ** 30, now = Date.now();
  const scope = { system: true, processes: true, ports: true, containers: true };
  const m = (id, name, emoji, color, host, distro, distroId, cores, memG, cpu, mem, disk, extra = {}) => ({
    id, name, emoji, color, picture: null, host, port: 7337, scope, networks: 'private', addedAt: now - 9e8, pairedAt: now - 9e8,
    status: 'online', error: null, lastSeen: now,
    spark: { cpu: wave(40, cpu, cpu / 3), mem: wave(40, mem, 2), rx: wave(40, 4e5, 2e5), tx: wave(40, 1e5, 5e4) },
    snap: { version: '0.1.0', at: now, uptime: 1.9e6, scope,
      host: { hostname: name.toLowerCase().replace(/\W+/g, '-'), distro, distroId, kernel: '6.8.0-49-generic', arch: 'x86_64', cpuModel: 'AMD EPYC 7763', cores, memTotal: memG * G, virt: 'vm', machineId: '3f9c2a71d04be8a1', model: 'KVM' },
      cpu: { usage: cpu, load: [cpu / 25, cpu / 28, cpu / 30] }, mem: { total: memG * G, used: memG * G * mem / 100, available: memG * G * (1 - mem / 100) },
      disks: [{ mount: '/', fs: 'ext4', total: 200 * G, used: 200 * G * disk / 100 }],
      net: [{ name: 'eth0', rx: 412e3, tx: 98e3, addrs: [host.match(/\d/) ? host : '10.0.4.12/24'] }],
      processes: [['postgres', 'postgres', 38.2, 2.1], ['node', 'app', 21.5, .9], ['nginx', 'www-data', 3.1, .05], ['dockerd', 'root', 1.4, .2]].map(([name, user, c, g], i) => ({ pid: 1200 + i * 37, name, user, cpu: c, mem: g * G })),
      ports: [22, 80, 443, 5432, 6379].map(port => ({ port, proto: 'tcp', name: { 22: 'sshd', 80: 'nginx', 443: 'nginx', 5432: 'postgres', 6379: 'redis-server' }[port] })),
      containers: [['book-api', 'bookshop/api:2.4', 'book', 12.4, .6], ['book-web', 'bookshop/web:2.4', 'book', 3.2, .2], ['book-worker', 'bookshop/api:2.4', 'book', 4.1, .3],
        ['book-search', 'opensearch:2.11', 'book', 6.8, 1.4], ['book-cron', 'bookshop/api:2.4', 'book', 0, 0, 'exited'], ['redis', 'redis:7', '', .8, .05],
        ['nginx', 'nginx:1.27', '', .4, .03], ['metrics', 'prom/node-exporter:1.8', '', .2, .02], ['old-backup', 'restic/restic:0.16', '', 0, 0, 'exited']]
        .map(([name, image, project, cpu, g, state = 'running'], i) => ({ id: `c${i}a1b2c3d4e5f6`, name, image, project, service: project ? name.replace(`${project}-`, '') : '', dir: project ? `/srv/${project}` : '', state, status: state === 'running' ? 'Up 21 days' : 'Exited (0) 3 hours ago', cpu, mem: g * G, rx: cpu * 9e3, tx: cpu * 4e3 })),
      ...extra },
  });
  return { masterFp: 'demo', machines: [
    { ...m('a1b2c3d4e5f6', 'Production DB', '🐘', '#60a5fa', 'db-1.internal', 'Ubuntu 24.04.1 LTS', 'ubuntu', 16, 64, 46, 71, 62),
      items: [{ id: 'db:cpu:1200', type: 'cpu', severity: 'critical', subject: { pid: 1200, name: 'postgres', user: 'postgres' }, since: now - 7 * 6e4, value: 384, spark: wave(30, 380, 20) },
        { id: 'db:finished:3301', type: 'finished', severity: 'done', subject: { pid: 3301, name: 'claude', user: 'deploy', mem: 410 * 1048576 }, since: now - 4 * 6e4 },
        { id: 'db:idle-agent:2290', type: 'idle-agent', severity: 'tidy', subject: { pid: 2290, name: 'codex', user: 'deploy', mem: 280 * 1048576 }, since: now - 5 * 3600e3 },
        { id: 'db:stopped', type: 'stopped', severity: 'tidy', subjects: [{ id: 'c5', name: 'book-cron' }, { id: 'c9', name: 'old-backup' }] },
        { id: 'db:mem:1237', type: 'mem', severity: 'critical', subject: { pid: 1237, name: 'node', user: 'app' }, since: now - 12 * 6e4, value: 2900, from: 1800, rate: 92, spark: Array.from({ length: 30 }, (_, i) => 1800 + i * 38) }],
      procSpark: { 1200: wave(24, 38, 12), 1237: wave(24, 21, 8, 4), 1274: wave(24, 3, 1), 1311: wave(24, 1.4, .5) } },
    { ...m('b2c3d4e5f6a1', 'Home NAS', '', '#34d399', '192.168.1.20', 'Debian GNU/Linux 12', 'debian', 4, 16, 8, 38, 91),
      items: [{ id: 'nas:disk:/', type: 'disk', severity: 'warning', subject: { mount: '/' }, value: 91, free: 18 * G }] },
    m('c3d4e5f6a1b2', 'Edge', '⚡', '#f472b6', 'edge.tail3f2a.ts.net', 'Alpine Linux v3.20', 'alpine', 2, 2, 17, 54, 23),
    { id: 'd4e5f6a1b2c3', name: 'gpu-box', emoji: '', color: '#a78bfa', host: 'gpu-box.local', port: 7337, scope, networks: 'private', addedAt: now - 6e4,
      status: 'pending', note: 'Waiting for the agent…', command: 't=k3x9Qe7LmPz2Vb; d=$(mktemp -d); { curl -fsSLo "$d/i.sh" https://github.com/Osama-Yusuf/devdock/releases/download/v1.4.0/install-agent.sh || wget -qO "$d/i.sh" https://github.com/Osama-Yusuf/devdock/releases/download/v1.4.0/install-agent.sh; } 2>/dev/null; if (sha256sum "$d/i.sh" 2>/dev/null || shasum -a 256 "$d/i.sh") | grep -q "^9f2c4e1ab07d33a1 "; then printf "%s\\n" "$t" | sudo sh "$d/i.sh" --master 7773af89e1c0 --scope system,processes,ports --port 7337; else echo "That installer is not the one this DevDock ships: not running it."; fi; rm -rf "$d"' },
  ] };
}

module.exports = { demoPorts, demoTransient, demoSessions, demoAgents, demoApps, demoContainers, demoHome, demoTalkers, demoMachines };

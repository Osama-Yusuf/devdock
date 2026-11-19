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

module.exports = { demoPorts, demoTransient };

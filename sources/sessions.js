// Terminal multiplexer sessions: tmux, zellij, screen, herdr and Rex, in one list.
// Every adapter returns sessions in the same shape; shared details (agents, ports,
// branch, idle) are filled in afterwards from the process table.
//
// Output formats are taken from each tool's source or checked live:
//   tmux 3.7c    list-sessions/list-panes -F, "=name" exact targets   (checked live)
//   screen 4.00  "-ls" rows "\t<pid>.<name>\t(Detached)", exits 1      (checked live)
//   Rex          "ls --json", "block ls --json", AppleScript show      (checked live)
//   zellij       sessions.rs print_sessions, --no-formatting           (source, v0.46)
//   herdr        session.rs SessionInfo, api/schema/panes.rs PaneInfo  (source, v0.9.5)
const os = require('os');
const path = require('path');

const STATE_RANK = { 'needs-you': 3, working: 2, idle: 1 };
const STATUS_RANK = { blocked: 4, working: 3, done: 2, idle: 1, unknown: 0 };

module.exports = function sessions(ctx) {
  const adapters = [tmux(ctx), zellij(ctx), screen(ctx), herdr(ctx), rex(ctx)];
  const byMux = Object.fromEntries(adapters.map(a => [a.mux, a]));
  let last = []; // sessions from the latest scan; actions only accept these

  async function scan() {
    if (ctx.DEMO) return { sessions: [], muxes: [] };
    const results = await Promise.all(adapters.map(async a => {
      if (!a.bin()) return { mux: a.mux, available: false, sessions: [] };
      try { return { mux: a.mux, available: true, sessions: await a.list() }; }
      catch (e) { return { mux: a.mux, available: true, error: e.message, sessions: [] }; }
    }));
    const children = childrenOf(ctx.procs());
    last = await Promise.all(results.flatMap(r => r.sessions).map(s => enrich(s, children)));
    return {
      sessions: last.map(({ rootPids, targets, ...pub }) => pub), // internals stay server-side
      muxes: results.map(({ mux, available, error }) => ({ mux, label: byMux[mux].label, available, error })),
    };
  }

  // Agents, ports and branch come from the processes under the session's panes
  async function enrich(s, children) {
    const procs = ctx.procs();
    const tree = new Set();
    const stack = [...(s.rootPids || [])];
    while (stack.length) {
      const pid = stack.pop();
      if (tree.has(pid)) continue;
      tree.add(pid);
      stack.push(...(children[pid] || []));
    }
    const agents = s.agents || [...new Set([...tree].map(pid => procs[pid] && ctx.agentOf(procs[pid].comm)).filter(Boolean))];
    // the most urgent Claude Code in it decides; Herdr's own status when there's none
    const states = [...tree].filter(pid => procs[pid] && ctx.agentOf(procs[pid].comm) === 'Claude Code').map(ctx.claudeState).filter(Boolean);
    const agentState = states.sort((a, b) => STATE_RANK[b.status] - STATE_RANK[a.status])[0]
      || (s.agentStatus && { status: { blocked: 'needs-you', working: 'working', done: 'idle', idle: 'idle' }[s.agentStatus], since: null }) || null;
    const cwd = s.cwd || (s.rootPids?.[0] ? await ctx.cwdOf(s.rootPids[0]) : null);
    const { idleAfterHours } = ctx.settings();
    const quietFor = s.lastActive ? Date.now() - s.lastActive : null;
    return {
      ...s,
      key: `${s.mux}:${s.id}`,
      cwd,
      branch: cwd ? ctx.gitBranch(cwd) : null,
      github: cwd ? ctx.githubUrl(cwd) : null,
      agents,
      agentState: agentState?.status ? agentState : null,
      ports: [...new Set(ctx.ports().filter(p => tree.has(p.pid)).map(p => p.port))].sort((a, b) => a - b),
      // nobody attached and no output for the idle threshold
      idle: s.state === 'running' && s.attached === false && quietFor != null
        && idleAfterHours > 0 && quietFor >= idleAfterHours * 3600 * 1000,
      canOpen: !!byMux[s.mux].attach,
      canShow: !!byMux[s.mux].show,
      canKill: !!byMux[s.mux].kill,
      canRename: !!byMux[s.mux].rename,
    };
  }

  // Only sessions from a scan; the list may be stale if nobody was watching, so rescan once
  async function find({ mux, id }) {
    const get = () => last.find(x => x.mux === mux && x.id === id);
    if (!get()) await scan();
    const s = get();
    if (!s) throw Object.assign(new Error('That session is gone'), { status: 404 });
    return s;
  }

  return {
    id: 'sessions',
    last: () => last, // with rootPids and targets, for sources/coding.js
    intervalMs: 2000,
    scan,
    actions: {
      async kill(p) {
        const s = await find(p);
        if (!byMux[s.mux].kill) throw Object.assign(new Error(`${byMux[s.mux].label} sessions can't be closed from DevDock`), { status: 400 });
        const r = await byMux[s.mux].kill(s);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'Could not close the session');
        return {};
      },
      async rename(p) {
        const s = await find(p);
        if (!byMux[s.mux].rename) throw Object.assign(new Error(`${byMux[s.mux].label} sessions can't be renamed from DevDock`), { status: 400 });
        // tmux turns . and : into _ (they separate window and pane); say so instead
        const name = typeof p.name === 'string' ? p.name.trim() : '';
        if (!name || name.length > 100 || /[.:\n]/.test(name)) throw Object.assign(new Error('Names need 1 to 100 characters, without . or :'), { status: 400 });
        if (last.some(x => x.mux === s.mux && x.id === name)) throw Object.assign(new Error(`There's already a session called ${name}`), { status: 409 });
        const r = await byMux[s.mux].rename(s, name);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'Could not rename the session');
        return {};
      },
      async show(p) {
        const s = await find(p);
        if (!byMux[s.mux].show) throw Object.assign(new Error('Not supported'), { status: 400 });
        const r = await byMux[s.mux].show(s);
        if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not open the session');
        return {};
      },
    },
    // The attach command for the in-app terminal (or Terminal.app)
    async terminal(p) {
      try {
        const s = await find(p);
        return byMux[s.mux].attach ? byMux[s.mux].attach(s, p.target) : null;
      } catch { return null; }
    },
  };
};

function childrenOf(procs) {
  const kids = {};
  for (const [pid, p] of Object.entries(procs)) (kids[p.ppid] ||= []).push(pid);
  return kids;
}

const lines = out => out.split('\n').filter(Boolean);

// ── tmux ─────────────────────────────────────────────────────────────
// Targets use "=name": a bare name also matches other sessions by prefix.
// Fields are tab-separated because session names may contain spaces.
function tmux(ctx) {
  const bin = () => ctx.findBin('tmux');
  const fmt = (...f) => f.join('\t');
  return {
    mux: 'tmux', label: 'tmux', bin,
    async list() {
      const s = await ctx.run(bin(), ['list-sessions', '-F',
        fmt('#{session_name}', '#{session_created}', '#{session_activity}', '#{session_attached}', '#{session_windows}')]);
      if (s.code !== 0) return []; // no tmux server running
      const p = await ctx.run(bin(), ['list-panes', '-a', '-F',
        fmt('#{session_name}', '#{window_index}.#{pane_index}', '#{pane_pid}', '#{pane_current_path}', '#{window_active}', '#{pane_active}')]);
      const panes = {};
      lines(p.stdout).forEach(l => {
        const [session, target, pid, cwd, winActive, paneActive] = l.split('\t');
        (panes[session] ||= []).push({ target, pid, cwd, active: winActive === '1' && paneActive === '1' });
      });
      return lines(s.stdout).map(l => {
        const [name, created, activity, attached, windows] = l.split('\t');
        const list = panes[name] || [];
        return {
          mux: 'tmux', id: name, name, state: 'running',
          attached: +attached > 0,
          createdAt: +created * 1000,
          lastActive: +activity * 1000, // last output in any pane
          windows: +windows, panes: list.length,
          cwd: (list.find(x => x.active) || list[0])?.cwd || null,
          rootPids: list.map(x => x.pid),
          targets: list.map(x => x.target),
        };
      });
    },
    // target: "window.pane" inside this session, only if it exists
    attach: (s, target) => ({
      file: bin(),
      args: ['attach-session', '-t', `=${s.id}`,
        ...(s.targets.includes(target) ? [';', 'select-window', '-t', `=${s.id}:${target}`, ';', 'select-pane', '-t', `=${s.id}:${target}`] : [])],
    }),
    kill: s => ctx.run(bin(), ['kill-session', '-t', `=${s.id}`]),
    rename: (s, name) => ctx.run(bin(), ['rename-session', '-t', `=${s.id}`, name]),
  };
}

// ── zellij ───────────────────────────────────────────────────────────
// "<name> [Created <humantime> ago] <suffix>", suffix "(current)", "(EXITED - attach to
// resurrect)" or empty. No sessions: exit 1, message on stderr. No pids are exposed.
function zellij(ctx) {
  const bin = () => ctx.findBin('zellij');
  return {
    mux: 'zellij', label: 'Zellij', bin,
    async list() {
      const r = await ctx.run(bin(), ['list-sessions', '--no-formatting']);
      return lines(r.stdout).map(l => {
        const m = l.match(/^(.+?) \[Created (.+?) ago\] ?(.*)$/);
        if (!m) return null;
        const age = humantimeMs(m[2]);
        return {
          mux: 'zellij', id: m[1], name: m[1],
          state: m[3].includes('EXITED') ? 'exited' : 'running',
          // rounded so the value doesn't drift between scans
          attached: null, createdAt: age == null ? null : Math.round((Date.now() - age) / 60000) * 60000,
        };
      }).filter(Boolean);
    },
    attach: s => ({ file: bin(), args: ['attach', s.id] }), // also resurrects an exited session
    kill: s => ctx.run(bin(), s.state === 'exited' ? ['delete-session', s.id] : ['kill-session', s.id]),
  };
}

// humantime's format_duration: "1year 2months 3days 4h 5m 6s 7ms" (units from its source)
const HUMANTIME_MS = { year: 31557600000, month: 2630016000, day: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
function humantimeMs(text) {
  let total = 0, matched = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([a-z]+)/g)) {
    const ms = HUMANTIME_MS[unit.replace(/s$/, '')] ?? HUMANTIME_MS[unit];
    if (ms == null) return null;
    total += +n * ms; matched++;
  }
  return matched ? total : null;
}

// ── GNU screen ───────────────────────────────────────────────────────
// Rows: "\t<pid>.<name>\t[(<date>)\t](Attached|Detached)". Exits 1 even with sessions.
function screen(ctx) {
  const bin = () => ctx.findBin('screen');
  return {
    mux: 'screen', label: 'screen', bin,
    async list() {
      const r = await ctx.run(bin(), ['-ls']);
      return lines(r.stdout).filter(l => l.startsWith('\t')).map(l => {
        const parts = l.split('\t').filter(Boolean);
        const m = parts[0].match(/^(\d+)\.(.+)$/);
        if (!m) return null;
        const pid = m[1];
        return {
          mux: 'screen', id: parts[0], name: m[2], state: 'running',
          attached: /attached/i.test(parts[parts.length - 1]),
          createdAt: ctx.procs()[pid]?.startedAt || null,
          rootPids: [pid],
        };
      }).filter(Boolean);
    },
    attach: s => ({ file: bin(), args: ['-x', s.id] }), // -x joins even if attached elsewhere
    kill: s => ctx.run(bin(), ['-S', s.id, '-X', 'quit']),
  };
}

// ── herdr ────────────────────────────────────────────────────────────
// session list --json: {"sessions":[{name, default, running, connection_error?, socket_path, session_dir}]}
// pane list (always JSON): response envelope holding PaneInfo records
//   {pane_id, tab_id, focused, cwd?, foreground_cwd?, agent?, display_agent?, agent_status}
// Not verified against a running herdr (not installed here).
function herdr(ctx) {
  if (!ctx.findBin('herdr') && ctx.findBin('hc')) return herdrCore(ctx);
  const bin = () => ctx.findBin('herdr');
  return {
    mux: 'herdr', label: 'herdr', bin,
    async list() {
      const r = await ctx.run(bin(), ['session', 'list', '--json']);
      if (r.code !== 0) return [];
      const list = JSON.parse(r.stdout).sessions || [];
      // the default session always appears; when it isn't running it's not a session yet
      return Promise.all(list.filter(s => s.running || !s.default).map(async s => {
        const base = { mux: 'herdr', id: s.name, name: s.name, state: s.running ? 'running' : 'stopped', attached: null };
        if (!s.running) return base;
        const p = await ctx.run(bin(), ['--session', s.name, 'pane', 'list']);
        const panes = p.code === 0 ? findPanes(JSON.parse(p.stdout)) : [];
        const focused = panes.find(x => x.focused) || panes[0];
        const statuses = panes.map(x => x.agent_status).filter(st => st in STATUS_RANK);
        return {
          ...base,
          panes: panes.length,
          windows: new Set(panes.map(x => x.tab_id)).size,
          cwd: focused?.foreground_cwd || focused?.cwd || null,
          agents: [...new Set(panes.map(x => x.display_agent || x.agent).filter(Boolean))],
          // the most urgent pane decides: blocked > working > done > idle
          agentStatus: statuses.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] || null,
        };
      }));
    },
    attach: s => ({ file: bin(), args: ['session', 'attach', s.id] }), // starts a stopped session
    kill: s => ctx.run(bin(), ['session', s.state === 'running' ? 'stop' : 'delete', s.id]),
  };
}

// The Herdr desktop app ships herdr-core, `hc`, instead of the herdr TUI (checked live):
//   ls --json  {"terminals":[{address, agent, cwd, state, status, turn, where: "Space / tab"}]}
//   get <t> --json  adds pid (the terminal's shell) and created_ms; neither changes, so cached
function herdrCore(ctx) {
  const bin = () => ctx.findBin('hc');
  const fixed = new Map(); // address -> { pid, createdAt }
  return {
    mux: 'herdr', label: 'Herdr', bin,
    async list() {
      const r = await ctx.run(bin(), ['ls', '--json']);
      if (r.code !== 0) return []; // core not running
      const list = JSON.parse(r.stdout).terminals || [];
      for (const k of fixed.keys()) if (!list.some(t => t.address === k)) fixed.delete(k);
      return Promise.all(list.map(async t => {
        if (!fixed.has(t.address)) {
          const g = await ctx.run(bin(), ['get', t.address, '--json']);
          const d = g.code === 0 ? JSON.parse(g.stdout) : {};
          fixed.set(t.address, { pid: d.pid ? String(d.pid) : null, createdAt: d.created_ms || null });
        }
        const { pid, createdAt } = fixed.get(t.address);
        const agent = t.agent && (ctx.agentOf(t.agent.replace(/-code$/, '')) || t.agent);
        return {
          mux: 'herdr', id: t.address, name: t.where || t.address, state: t.state === 'live' ? 'running' : t.state, attached: null,
          createdAt, cwd: t.cwd || null, rootPids: pid ? [pid] : [],
          ...(agent && { agents: [agent] }),
          agentStatus: t.status in STATUS_RANK ? t.status : null,
        };
      }));
    },
    attach: s => ({ file: bin(), args: ['attach', s.id] }),
    kill: s => ctx.run(bin(), ['kill', s.id]),
  };
}

// The pane array's key inside the envelope isn't documented: take the array of pane records
function findPanes(node) {
  if (Array.isArray(node)) return node.every(x => x && typeof x === 'object' && 'pane_id' in x) ? node : node.flatMap(findPanes);
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) { const found = findPanes(v); if (found.length) return found; }
  }
  return [];
}

// ── Rex ──────────────────────────────────────────────────────────────
// No attach: Rex is its own terminal app, so sessions open there. --autostart=false
// keeps DevDock from starting Rex's server just by looking.
const REX_SERVER_BIN = path.join(os.homedir(), 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex');
function rex(ctx) {
  const bin = () => ctx.findBin('rex') || (require('fs').existsSync(REX_SERVER_BIN) ? REX_SERVER_BIN : null);
  return {
    mux: 'rex', label: 'Rex', bin,
    async list() {
      const r = await ctx.run(bin(), ['ls', '--json', '--autostart=false']);
      if (r.code !== 0) return []; // Rex isn't running
      return Promise.all((JSON.parse(r.stdout).sessions || []).map(async s => {
        const b = await ctx.run(bin(), ['block', 'ls', '-s', s.session_id, '--json', '--autostart=false']);
        const blocks = b.code === 0 ? JSON.parse(b.stdout).blocks || [] : [];
        return {
          mux: 'rex', id: s.session_id, name: s.label, state: 'running', attached: null,
          windows: new Set(blocks.map(x => x.window_id)).size, panes: blocks.length,
        };
      }));
    },
    // the scripting id is "<server uuid>/session:<uuid>"; match on the suffix
    show: s => ctx.run('osascript', ['-e', 'on run argv',
      '-e', 'tell application id "com.superlogical.rex" to show (first session whose id ends with ("/" & item 1 of argv))',
      '-e', 'end run', s.id]),
  };
}

module.exports.humantimeMs = humantimeMs; // for the self-check below

if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(humantimeMs('2h 3m 5s'), 2 * 3600000 + 3 * 60000 + 5000);
  assert.strictEqual(humantimeMs('1day 4h'), 86400000 + 4 * 3600000);
  assert.strictEqual(humantimeMs('3months'), 3 * 2630016000);
  assert.strictEqual(humantimeMs('soon'), null);
  assert.deepStrictEqual(findPanes({ id: 'r', result: { type: 'pane_list', panes: [{ pane_id: 'w1:p1' }] } }), [{ pane_id: 'w1:p1' }]);
  assert.deepStrictEqual(findPanes({ result: { workspaces: [] } }), []);
  console.log('sessions self-check ok');
}

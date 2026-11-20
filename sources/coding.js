// Agents tab: every coding agent running on this Mac (Claude Code, Codex, OpenCode...),
// what it's doing and where it lives, so you can jump straight to it.
//
// An agent is a process whose name is a known CLI agent and whose parent isn't one
// (that skips Claude Code's own helpers and sub-processes). Where it lives comes from
// its ancestors: a multiplexer pane DevDock already lists (tmux pane, Herdr terminal),
// else the terminal app it runs in (Ghostty, iTerm...). Claude Code's state is its own:
// ~/.claude/sessions/<pid>.json (see claudeState in server.js).
const fs = require('fs');
const path = require('path');

module.exports = function coding(ctx) {
  let last = [];

  function childrenOf(procs) {
    const kids = {};
    for (const [pid, p] of Object.entries(procs)) (kids[p.ppid] ||= []).push(pid);
    return kids;
  }

  async function scan() {
    if (ctx.DEMO) return require('../demo').demoAgents();
    const procs = ctx.procs();
    const kids = childrenOf(procs);
    const isAgent = pid => procs[pid] && !procs[pid].comm.includes('.app/') && !/ bg-/.test(procs[pid].comm) && ctx.agentOf(procs[pid].comm);
    // shell pid of each multiplexer pane DevDock lists -> the session (and tmux pane)
    const paneOf = {};
    for (const s of ctx.source('sessions')?.last?.() || []) {
      (s.rootPids || []).forEach((pid, i) => { paneOf[pid] = { mux: s.mux, id: s.id, name: s.name, target: s.targets?.[i] || null }; });
    }
    const portsByPid = {};
    for (const p of ctx.ports()) (portsByPid[p.pid] ||= []).push(p.port);

    last = await Promise.all(Object.keys(procs).filter(pid => isAgent(pid) && !isAgent(procs[pid].ppid)).map(async pid => {
      const p = procs[pid];
      let where = null;
      for (let cur = pid, i = 0; cur && cur !== '1' && i < 40 && !where; cur = procs[cur]?.ppid, i++) {
        if (paneOf[cur]) where = paneOf[cur];
        else { const app = ctx.appFromPath(procs[cur]?.comm); if (app && cur !== pid) where = { app, pid: cur }; }
      }
      // Claude Code's background sessions run under its own helper app, not a terminal
      if (where?.app === 'ClaudeCode') where = { background: true };
      // no pane, no terminal app: its parent is gone or it was started by a script
      if (!where) where = { detached: procs[p.ppid] ? false : true, parent: path.basename(procs[p.ppid]?.comm || '') || null };
      // everything it started: servers, shells, MCP servers
      const tree = [], stack = [pid];
      while (stack.length) { const x = stack.pop(); tree.push(x); stack.push(...(kids[x] || [])); }
      const agent = ctx.agentOf(p.comm);
      const state = agent === 'Claude Code' ? ctx.claudeState(pid) : null;
      const cwd = await ctx.cwdOf(pid);
      return {
        pid, agent, name: state?.name || (cwd ? path.basename(cwd) : agent),
        state, cwd, branch: cwd ? ctx.gitBranch(cwd) : null,
        sessionId: agent === 'Claude Code' ? sessionIdOf(pid) : null,
        where, startedAt: p.startedAt,
        cpu: tree.reduce((n, x) => n + (procs[x]?.cpu || 0), 0),
        memMB: tree.reduce((n, x) => n + (procs[x]?.rssMB || 0), 0),
        processes: tree.length,
        ports: [...new Set(tree.flatMap(x => portsByPid[x] || []))].sort((a, b) => a - b),
      };
    }));
    return { agents: last };
  }

  function sessionIdOf(pid) {
    try { return JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude/sessions', `${pid}.json`), 'utf8')).sessionId || null; } catch { return null; }
  }

  // Ghostty 1.3's AppleScript lists terminals with a title and folder, not a tty or pid, so
  // the agent's tab is the one in its folder; several there -> the title closest to its name
  async function focusGhostty(a) {
    // three lists, each joined by linefeeds, the lists split by a NUL-ish marker
    const r = await ctx.run('osascript', ['-e', 'tell application "Ghostty" to set {i, d, n} to {id, working directory, name} of every terminal',
      '-e', 'set AppleScript\'s text item delimiters to linefeed', '-e', 'return (i as text) & "\u241E" & (d as text) & "\u241E" & (n as text)'], { timeout: 5000 });
    if (r.code !== 0) return false;
    const [ids, dirs, names] = r.stdout.replace(/\n$/, '').split('\u241E').map(x => x.split('\n'));
    const terms = (ids || []).map((id, k) => [id, dirs?.[k], names?.[k] || '']).filter(t => t[1] === a.cwd);
    if (!terms.length) return false;
    const want = a.name.toLowerCase();
    const score = ([, , title]) => { const t = title.toLowerCase().replace(/^[^\w]+/, ''); let n = 0; while (n < t.length && t[n] === want[n]) n++; return n; };
    const best = terms.sort((x, y) => score(y) - score(x))[0];
    const f = await ctx.run('osascript', ['-e', 'on run argv', '-e', 'tell application "Ghostty" to focus (first terminal whose id is (item 1 of argv))', '-e', 'end run', best[0]], { timeout: 5000 });
    return f.code === 0;
  }

  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  async function find(pid) {
    const get = () => last.find(a => a.pid === String(pid));
    if (!get()) await scan();
    if (!get()) throw bad('That agent is gone', 404);
    return get();
  }

  return {
    id: 'coding',
    intervalMs: 2000,
    scan,
    actions: {
      // not in a multiplexer: bring its terminal app to the front (the page attaches to panes itself)
      async focus({ pid }) {
        const a = await find(pid);
        if (!a.where?.app) throw bad("It isn't running in a terminal app DevDock can find");
        if (a.where.app === 'Ghostty' && await focusGhostty(a)) return {};
        const r = await ctx.run('open', ['-a', a.where.app]);
        if (r.code !== 0) throw bad(`Could not bring ${a.where.app} to the front`);
        return {};
      },
      async stop({ pid, force }) {
        const a = await find(pid);
        try { process.kill(+a.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw bad(e.message); }
        return {};
      },
    },
  };
};

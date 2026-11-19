// Coding agents (Claude Code, Codex, OpenCode) run headless on what the user selected.
//
// Each run is a tmux session "devdock-agent-<id>" running agents/runner.js, which writes
// milestones to <tmp>/devdock-agents/<id>/events.jsonl. This source lists the runs from
// those files, so a run survives DevDock restarting, and anyone can attach to watch it.
// Off until enabled in Settings; never in demo mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AGENTS } = require('../agents/adapters');

const RUNS_DIR = path.join(os.tmpdir(), 'devdock-agents');
const RUNNER = path.join(__dirname, '..', 'agents', 'runner.js');
const PREFIX = 'devdock-agent-';
const KEEP = 20;              // runs kept on disk
const SNAPSHOT_CHARS = 2500;  // per item, so a big selection still fits a prompt

// DevDock draws the answer as a verdict, findings and next steps (agents/adapters.js
// parseReply reads it back). Anything off-shape falls back to the prose as markdown.
const REPLY_FORMAT = `Reply format: DevDock renders your final message as cards, not text. End it with exactly one fenced \`\`\`json block and nothing after it:
{
  "status": "ok" | "warning" | "problem" | "info",
  "summary": "the answer in one sentence",
  "findings": [{ "status": "ok" | "warning" | "problem" | "info", "title": "short headline", "detail": "one or two sentences, \`code\` allowed", "items": ["names of selected items it concerns"] }],
  "actions": [{ "title": "what to do, imperative", "command": "exact shell command, or empty", "risk": "safe" | "changes" | "destructive", "why": "one short sentence" }],
  "replies": ["short follow-up the user might send"]
}
At most 5 findings and 4 actions, most important first. "replies" holds 2 or 3 short messages the user would likely send you next, in their voice ("Do step 1", "Show me its logs", "Why did that happen?"); only offer what you could actually do, and never have the user claim something changed (like permissions). Before the block, write at most two sentences.`;
const REPLY_AGAIN = 'Reply in the same format as before: at most two sentences, then the ```json block with status, summary, findings, actions and replies.';

module.exports = function agents(ctx) {
  const tmux = () => ctx.findBin('tmux');
  let versions = null, versionsAt = 0;
  const cache = new Map(); // run id -> { size, events }
  let anyRunning = false;

  async function installed() {
    if (versions && Date.now() - versionsAt < 60000) return versions;
    versions = await Promise.all(Object.entries(AGENTS).map(async ([id, a]) => {
      const bin = ctx.findBin(a.bin);
      const v = bin ? (await ctx.run(bin, ['--version'], { timeout: 5000 })).stdout.trim().split('\n')[0] : '';
      return { id, label: a.label, installed: !!bin, version: v.replace(/^[^\d]*/, '').split(' ')[0] || null };
    }));
    versionsAt = Date.now();
    return versions;
  }

  function readEvents(id) {
    const file = path.join(RUNS_DIR, id, 'events.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    const c = cache.get(id);
    if (c && c.size === size) return c.events;
    const events = size ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    cache.set(id, { size, events });
    return events;
  }

  function runIds() {
    try {
      return fs.readdirSync(RUNS_DIR).filter(d => /^[0-9a-f]{8}$/.test(d))
        .map(d => ({ d, t: fs.statSync(path.join(RUNS_DIR, d)).mtimeMs })).sort((a, b) => b.t - a.t).map(x => x.d);
    } catch { return []; }
  }

  async function scan() {
    const s = ctx.settings();
    if (ctx.DEMO) return { enabled: false, agents: [], runs: [] };
    const agents = await installed();
    if (!s.agentsEnabled) { anyRunning = false; return { enabled: false, agents, runs: [] }; }
    const live = new Set();
    if (tmux()) {
      const r = await ctx.run(tmux(), ['list-sessions', '-F', '#{session_name}']);
      r.stdout.split('\n').filter(n => n.startsWith(PREFIX)).forEach(n => live.add(n.slice(PREFIX.length)));
    }
    const runs = runIds().map(id => {
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'meta.json'), 'utf8')); } catch { return null; }
      const events = readEvents(id);
      // a conversation: the state is the latest turn's, each reply starts one
      const lastUser = events.map(e => e.t).lastIndexOf('user');
      const done = events.slice(lastUser + 1).find(e => e.t === 'done');
      const alive = live.has(id);
      const state = done ? (done.ok ? 'done' : 'failed') : alive ? 'running' : 'stopped';
      return { ...meta, id, session: PREFIX + id, alive, state, resumed: events.some(e => e.t === 'resumed'), events };
    }).filter(Boolean);
    anyRunning = runs.some(r => r.state === 'running');
    return { enabled: true, agents, runs };
  }

  // What DevDock already knows about each item, so the agent starts with facts instead of
  // spending turns finding them (and a read-only codex, which can't reach Docker, still sees).
  async function snapshot(item) {
    try {
      if (item.kind === 'container' && item.ref) return await ctx.source('containers').snapshot(item.ref);
      if (item.kind === 'session' && item.mux === 'tmux' && item.ref && tmux()) {
        const r = await ctx.run(tmux(), ['capture-pane', '-p', '-J', '-S', '-40', '-t', `=${item.ref}:`]);
        return r.code === 0 && r.stdout.trim() ? `Screen (last lines):\n${r.stdout.trimEnd()}` : '';
      }
    } catch {}
    return '';
  }

  async function buildPrompt({ request, items, readOnly, k8sContext }) {
    const blocks = await Promise.all(items.map(async it => {
      const facts = Object.entries(it.facts || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join('\n');
      const snap = (await snapshot(it)).slice(-SNAPSHOT_CHARS);
      return `## ${it.kind}: ${it.name}\n${facts}${snap ? `\n${snap}` : ''}`;
    }));
    const notes = [
      k8sContext && `kubectl: always pass --context ${k8sContext} (the cluster these run in). Never use the current kubectl context.`,
      items.some(i => i.mux === 'tmux') && 'tmux: read a session\'s screen with `tmux capture-pane -p -J -S -200 -t =<name>:`.',
      readOnly && 'This is a read-only run: inspect only. Do not stop, start, restart, delete, edit or install anything. If something needs changing, give the exact commands instead.',
    ].filter(Boolean).map(n => `- ${n}`).join('\n');
    return `${request}\n\n<devdock_context>\nSelected in DevDock, a local dev dashboard on this Mac (${items.length} item${items.length > 1 ? 's' : ''}):\n\n${blocks.join('\n\n')}\n</devdock_context>\n\nNotes:\n${notes}\n\n${REPLY_FORMAT}`;
  }

  function prune() {
    for (const id of runIds().slice(KEEP)) {
      fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
      cache.delete(id);
    }
  }

  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const known = id => {
    if (!/^[0-9a-f]{8}$/.test(id || '') || !fs.existsSync(path.join(RUNS_DIR, id))) throw bad('That run is gone', 404);
    return id;
  };
  const kill = id => tmux() && ctx.run(tmux(), ['kill-session', '-t', `=${PREFIX}${id}`]);

  // The run's tmux session: Electron's binary runs the script as plain Node, and PATH
  // lets the agent find node, git, docker... even when DevDock was opened from Finder.
  async function launch(id, bin, cwd) {
    const PATH = [...new Set([path.dirname(bin), ...ctx.binDirs, ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':');
    const r = await ctx.run(tmux(), ['new-session', '-d', '-s', PREFIX + id, '-c', cwd, '-x', '160', '-y', '45',
      '-e', 'ELECTRON_RUN_AS_NODE=1', '-e', `PATH=${PATH}`, '--', process.execPath, RUNNER, path.join(RUNS_DIR, id)]);
    if (r.code !== 0) throw bad(r.stderr.trim() || 'Could not start tmux', 500);
    anyRunning = true;
  }

  // A next step's command, run in DevDock's terminal from the run's folder. Only commands
  // the agent actually suggested in this run; the terminal stays open until a key.
  async function terminal({ id, cmd }) {
    if (!/^[0-9a-f]{8}$/.test(id || '') || typeof cmd !== 'string') return null;
    const events = readEvents(id);
    if (!events.some(e => e.t === 'answer' && e.data?.actions.some(a => a.command === cmd))) return null;
    let cwd = os.homedir();
    try { cwd = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'meta.json'), 'utf8')).cwd || cwd; } catch {}
    const script = `printf '\\033[2m$ %s\\033[0m\\n' "$1"; eval "$1"; s=$?; printf '\\n\\033[2m[exit %s] press any key to close\\033[0m' $s; read -rsk1`;
    return { file: '/bin/zsh', args: ['-lc', script, 'devdock', cmd], cwd };
  }

  return {
    id: 'agents',
    terminal,
    get intervalMs() { return anyRunning ? 1000 : 5000; },
    scan,
    actions: {
      async start(p) {
        if (ctx.DEMO || !ctx.settings().agentsEnabled) throw bad('Agents are off. Turn them on in Settings.', 403);
        const agent = AGENTS[p.agent];
        const bin = agent && ctx.findBin(agent.bin);
        if (!bin) throw bad(`${agent?.label || 'That agent'} isn't installed`);
        if (!tmux()) throw bad('Agents run in tmux, and tmux isn\'t installed');
        const request = str(p.request, 4000).trim();
        if (!request) throw bad('Write what you want to know');
        const items = (Array.isArray(p.items) ? p.items : []).slice(0, 40).map(it => ({
          kind: str(it.kind, 20), name: str(it.name, 200), ref: str(it.ref, 200), mux: str(it.mux, 20),
          facts: Object.fromEntries(Object.entries(it.facts || {}).slice(0, 20).map(([k, v]) => [str(k, 40), str(String(v ?? ''), 400)])),
        }));
        const readOnly = !!p.readOnly;
        const k8sContext = /^[\w.-]{1,64}$/.test(p.k8sContext || '') ? p.k8sContext : null;
        const cwd = typeof p.cwd === 'string' && path.isAbsolute(p.cwd) && fs.existsSync(p.cwd) ? p.cwd : os.homedir();

        const id = crypto.randomBytes(4).toString('hex');
        const dir = path.join(RUNS_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        const prompt = await buildPrompt({ request, items, readOnly, k8sContext });
        fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ agent: p.agent, bin, prompt, readOnly, k8sContext, cwd, request }));
        fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
          agent: p.agent, label: agent.label, request, readOnly, cwd, createdAt: Date.now(),
          items: items.map(i => ({ kind: i.kind, name: i.name })),
        }));
        try { await launch(id, bin, cwd); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
        prune();
        return { id, session: PREFIX + id };
      },
      // Reply in the same conversation. The runner reads the inbox between turns; a stopped
      // run gets its runner back, which answers what's waiting.
      async reply({ id, text, readOnly }) {
        if (ctx.DEMO || !ctx.settings().agentsEnabled) throw bad('Agents are off. Turn them on in Settings.', 403);
        known(id);
        text = str(text, 4000).trim();
        if (!text) throw bad('Write a reply');
        const dir = path.join(RUNS_DIR, id);
        const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
        const events = readEvents(id);
        if (!events.some(e => e.t === 'session')) throw bad('This run never started a conversation');
        const alive = (await ctx.run(tmux(), ['has-session', '-t', `=${PREFIX}${id}`])).code === 0;
        if (alive && events.some(e => e.t === 'resumed')) throw bad('You\'re talking to it in the terminal now', 409);
        // busy: a turn in flight, or a reply the runner hasn't picked up yet
        const lastUser = events.map(e => e.t).lastIndexOf('user');
        const queued = fs.existsSync(path.join(dir, 'inbox.jsonl')) ? fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
        if (queued > events.filter(e => e.t === 'user').length || (alive && !events.slice(lastUser + 1).some(e => e.t === 'done'))) throw bad('It\'s still working on the last one', 409);
        readOnly = !!readOnly;
        const prompt = `${text}\n\n(${readOnly ? 'Read-only: inspect only, change nothing. ' : ''}${REPLY_AGAIN})`;
        fs.appendFileSync(path.join(dir, 'inbox.jsonl'), JSON.stringify({ text, prompt, readOnly, at: Date.now() }) + '\n');
        if (!alive) await launch(id, spec.bin, spec.cwd);
        anyRunning = true;
        return {};
      },
      async stop({ id }) { await kill(known(id)); return {}; },
      async dismiss({ id }) {
        await kill(known(id));
        fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
        cache.delete(id);
        return {};
      },
    },
  };
};

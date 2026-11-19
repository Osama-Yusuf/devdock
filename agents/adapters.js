// Coding agents DevDock can run headless, and how to read what they do.
//
// Every agent prints JSON events; each adapter turns them into the same small set of
// milestones the run window shows. Shapes checked against real runs (Nov 2026):
//   claude -p --output-format stream-json --verbose   (Claude Code 2.1)
//   codex exec --json                                  (codex-cli 0.167)
//   opencode run --format json                         (opencode 1.18)
//
// Milestones (one JSON object per line in the run's events file):
//   { t:'session', id }                               resumable session id
//   { t:'step', id, kind, label, detail, change, status:'run'|'ok'|'fail', exit?, out? }
//   { t:'note', text }                                something the agent said mid-run
//   { t:'answer', text }                              its final message
//   { t:'done', ok, error?, ms, cost?, tokens? }
const path = require('path');

// Read-only runs may only start these. Prefix match, per command in a pipeline.
// ponytail: codex has no per-command allowlist; its read-only sandbox also blocks Docker.
function readOnlyCommands(k8sContext) {
  return [
    'docker ps', 'docker inspect', 'docker logs', 'docker stats --no-stream', 'docker top', 'docker port',
    'docker diff', 'docker history', 'docker images', 'docker image ls', 'docker image inspect',
    'docker volume ls', 'docker volume inspect', 'docker system df', 'docker compose ps', 'docker compose logs',
    ...(k8sContext ? ['get', 'describe', 'logs', 'top', 'events'].map(v => `kubectl --context ${k8sContext} ${v}`) : []),
    'tmux ls', 'tmux list-sessions', 'tmux list-windows', 'tmux list-panes', 'tmux capture-pane', 'tmux display-message',
    'ps', 'pgrep', 'lsof', 'top -l 1', 'netstat', 'git status', 'git log', 'git diff', 'git show', 'git branch',
    'cat', 'head', 'tail', 'grep', 'rg', 'ls', 'wc', 'sort', 'uniq', 'jq', 'du', 'df', 'which', 'uname', 'date',
    'echo', 'printf', 'stat', 'pwd', 'whoami', 'uptime', 'sw_vers', 'vm_stat', 'sysctl -n', 'launchctl list', 'brew services list',
  ];
}

const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    args: ({ prompt, readOnly, k8sContext, session }) => ['-p', prompt, ...(session ? ['--resume', session] : []), '--output-format', 'stream-json', '--verbose',
      ...(readOnly
        ? ['--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Grep', 'Glob', ...readOnlyCommands(k8sContext).map(c => `Bash(${c}:*)`)]
        : ['--permission-mode', 'bypassPermissions'])],
    resume: id => ['--resume', id],
    parse: parseClaude,
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    // `exec resume` has no -s flag; the same sandbox goes in as config
    args: ({ prompt, readOnly, session }) => session
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...(readOnly ? ['-c', 'sandbox_mode="read-only"'] : ['--dangerously-bypass-approvals-and-sandbox']), session, prompt]
      : ['exec', '--json', '--skip-git-repo-check', ...(readOnly ? ['-s', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']), prompt],
    resume: id => ['resume', id],
    parse: parseCodex,
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    args: ({ prompt, readOnly, session }) => ['run', '--format', 'json', ...(session ? ['--session', session] : []), ...(readOnly ? [] : ['--auto']), prompt],
    // opencode reads extra config from this variable, merged over the user's own
    env: ({ readOnly, k8sContext }) => readOnly ? {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: {
        edit: 'deny', webfetch: 'allow',
        bash: Object.fromEntries([['*', 'deny'], ...readOnlyCommands(k8sContext).flatMap(c => [[c, 'allow'], [`${c} *`, 'allow']])]),
      } }),
    } : {},
    resume: id => ['--session', id],
    parse: parseOpencode,
  },
};

// ── per-agent event parsing ──────────────────────────────────────────
// parse(event, state) -> milestones[]. `state` is per run, adapters keep what they need in it.

function parseClaude(e, st) {
  const out = [];
  if (e.type === 'system' && e.subtype === 'init' && e.session_id) out.push({ t: 'session', id: e.session_id });
  if (e.type === 'assistant') for (const c of e.message?.content || []) {
    if (c.type === 'text' && c.text.trim()) out.push({ t: 'text', text: c.text });
    if (c.type === 'tool_use') out.push(claudeTool(c));
  }
  if (e.type === 'user') for (const c of e.message?.content || []) {
    if (c.type === 'tool_result') out.push({ t: 'result', id: c.tool_use_id, ok: !c.is_error, out: textOf(c.content) });
  }
  if (e.type === 'result') {
    if (e.result && !e.is_error) out.push({ t: 'final', text: e.result });
    out.push({ t: 'done', ok: !e.is_error, error: e.is_error ? (e.result || e.subtype) : undefined, cost: e.total_cost_usd });
  }
  return out.filter(Boolean);
}
function claudeTool(c) {
  const i = c.input || {};
  const step = { t: 'step', id: c.id };
  switch (c.name) {
    case 'Bash': return { ...step, ...describeCommand(i.command), ...(i.description ? { label: i.description } : {}) };
    case 'Read': return { ...step, kind: 'read', label: `Read ${base(i.file_path)}`, detail: i.file_path };
    case 'Grep': return { ...step, kind: 'search', label: `Searched for “${clip(i.pattern, 40)}”`, detail: i.path || '' };
    case 'Glob': return { ...step, kind: 'search', label: `Looked for ${clip(i.pattern, 40)}`, detail: i.path || '' };
    case 'WebFetch': return { ...step, kind: 'web', label: `Read ${host(i.url)}`, detail: i.url };
    case 'WebSearch': return { ...step, kind: 'web', label: `Searched the web for “${clip(i.query, 40)}”` };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { ...step, kind: 'edit', change: true, label: `Edited ${base(i.file_path || i.notebook_path)}`, detail: i.file_path };
    case 'TodoWrite': case 'ToolSearch': return null;
    case 'Task': case 'Agent': return { ...step, kind: 'tool', label: clip(i.description || 'Started a helper agent', 60) };
    default: return { ...step, kind: 'tool', label: `Used ${c.name.replace(/^mcp__/, '').replace(/__/g, ' ')}` };
  }
}

function parseCodex(e, st) {
  const out = [];
  if (e.type === 'thread.started') out.push({ t: 'session', id: e.thread_id });
  const it = e.item;
  if (it && (e.type === 'item.started' || e.type === 'item.completed')) {
    const done = e.type === 'item.completed';
    if (it.type === 'agent_message' && done) out.push({ t: 'text', text: it.text });
    if (it.type === 'command_execution') {
      if (!done) out.push({ t: 'step', id: it.id, ...describeCommand(unwrapShell(it.command)) });
      else {
        if (!st.seen?.has(it.id)) out.push({ t: 'step', id: it.id, ...describeCommand(unwrapShell(it.command)) });
        out.push({ t: 'result', id: it.id, ok: it.status === 'completed' && !it.exit_code, exit: it.exit_code, out: it.aggregated_output });
      }
      (st.seen ||= new Set()).add(it.id);
    }
    if (it.type === 'file_change' && done) {
      const files = (it.changes || []).map(c => base(c.path));
      out.push({ t: 'step', id: it.id, kind: 'edit', change: true, label: `Edited ${list(files)}`, detail: (it.changes || []).map(c => c.path).join('\n') },
        { t: 'result', id: it.id, ok: it.status !== 'failed' });
    }
    if (it.type === 'mcp_tool_call' && done) out.push({ t: 'step', id: it.id, kind: 'tool', label: `Used ${it.server} ${it.tool}` }, { t: 'result', id: it.id, ok: it.status !== 'failed' });
    if (it.type === 'web_search' && done) out.push({ t: 'step', id: it.id, kind: 'web', label: `Searched the web for “${clip(it.query, 40)}”` }, { t: 'result', id: it.id, ok: true });
    if (it.type === 'error' && done) st.error = it.message;
  }
  if (e.type === 'turn.completed') {
    const u = e.usage || {};
    st.tokens = (st.tokens || 0) + (u.input_tokens || 0) + (u.output_tokens || 0);
    out.push({ t: 'done', ok: true, tokens: st.tokens });
  }
  if (e.type === 'turn.failed') out.push({ t: 'done', ok: false, error: e.error?.message || st.error || 'Codex stopped' });
  if (e.type === 'error') st.error = e.message;
  return out;
}

function parseOpencode(e, st) {
  const out = [];
  if (e.sessionID && !st.session) { st.session = e.sessionID; out.push({ t: 'session', id: e.sessionID }); }
  const p = e.part || {};
  if (e.type === 'text' && p.text?.trim()) out.push({ t: 'text', text: p.text });
  if (e.type === 'tool_use') {
    const s = p.state || {}, i = s.input || {};
    const id = p.callID || p.id;
    const step = { t: 'step', id };
    const tools = {
      bash: () => ({ ...step, ...describeCommand(i.command) }),
      read: () => ({ ...step, kind: 'read', label: `Read ${base(i.filePath)}`, detail: i.filePath }),
      list: () => ({ ...step, kind: 'read', label: `Listed ${base(i.path) || 'folder'}`, detail: i.path }),
      grep: () => ({ ...step, kind: 'search', label: `Searched for “${clip(i.pattern, 40)}”` }),
      glob: () => ({ ...step, kind: 'search', label: `Looked for ${clip(i.pattern, 40)}` }),
      webfetch: () => ({ ...step, kind: 'web', label: `Read ${host(i.url)}`, detail: i.url }),
      edit: () => ({ ...step, kind: 'edit', change: true, label: `Edited ${base(i.filePath)}`, detail: i.filePath }),
      write: () => ({ ...step, kind: 'edit', change: true, label: `Wrote ${base(i.filePath)}`, detail: i.filePath }),
      todowrite: () => null, todoread: () => null,
    };
    const s1 = (tools[p.tool] || (() => ({ ...step, kind: 'tool', label: `Used ${p.tool}` })))();
    if (s1) {
      out.push(s1);
      if (s.status === 'completed' || s.status === 'error') {
        const exit = s.metadata?.exit;
        out.push({ t: 'result', id, ok: s.status === 'completed' && !exit, exit, out: s.status === 'error' ? s.error : s.output ?? s.metadata?.output });
      }
    }
  }
  if (e.type === 'step_finish') {
    st.cost = (st.cost || 0) + (p.cost || 0);
    st.tokens = (st.tokens || 0) + (p.tokens?.input || 0) + (p.tokens?.output || 0);
    if (p.reason === 'stop') out.push({ t: 'done', ok: true, cost: st.cost || undefined, tokens: st.tokens });
  }
  if (e.type === 'error') out.push({ t: 'done', ok: false, error: e.error?.data?.message || e.error?.message || e.error?.name || 'OpenCode stopped' });
  return out;
}

// ── raw parse output -> milestones ───────────────────────────────────
// Agents narrate ("I'll run...", "Let me check..."). Steps already show that, so those
// lines are dropped; the last message is held back because it's usually the answer.
const FILLER = /^(i([’']ll| will| am going to| need to|[’']m going to)|let me|let's|now,? (i|let)|first,? (i|let)|next,? (i|let)|ok(ay)?\b|great\b|alright\b|sure\b|perfect\b|good\b)/i;
const DENIED = /permission to use .* (has been|was) denied|rule which prevents you from using|user rejected permission|blocked by (the )?(sandbox|policy)/i;
function isFiller(text) {
  const t = text.trim();
  return t.length < 240 && FILLER.test(t);
}

function createReducer(agentId) {
  const agent = AGENTS[agentId];
  const st = {};
  const steps = new Map();
  let pending = null; // latest text, not yet known to be the last one
  let final = null, done = null;
  let trailing = [];  // notes since the last step: one of them may be the real answer
  const flush = () => {
    const out = [];
    if (pending && !isFiller(pending)) { out.push({ t: 'note', text: pending.trim() }); trailing.push(pending.trim()); }
    pending = null;
    return out;
  };
  return {
    push(event) {
      const out = [];
      for (const m of agent.parse(event, st)) {
        if (m.t === 'text') { out.push(...flush()); pending = m.text; }
        else if (m.t === 'step') {
          if (steps.has(m.id)) continue;
          out.push(...flush());
          trailing = [];
          const s = { t: 'step', id: m.id, kind: m.kind, label: m.label, detail: m.detail || '', change: !!m.change, status: 'run' };
          steps.set(m.id, s);
          out.push({ ...s });
        } else if (m.t === 'result') {
          const s = steps.get(m.id);
          if (!s) continue;
          // a permission denial isn't a failure of the command: it never ran
          const blocked = !m.ok && DENIED.test(String(m.out || '').slice(0, 300));
          Object.assign(s, { status: m.ok ? 'ok' : blocked ? 'blocked' : 'fail', exit: m.exit ?? undefined, out: m.ok || blocked ? undefined : tailLines(m.out, 6) });
          out.push({ ...s });
        } else if (m.t === 'final') final = m.text;
        else if (m.t === 'done') done = m;
        else out.push(m);
      }
      return out;
    },
    // after the process exits: the held-back message is the answer
    finish({ code, stderr, ms }) {
      let answer = (final || pending || '').trim();
      pending = null;
      // A short last word after a long finding (a hook's follow-up, "anything else?") isn't
      // the answer: the finding is. The short one stays visible as a note.
      const extra = [];
      const best = trailing.reduce((a, b) => (b.length > a.length ? b : a), '');
      if (answer.length < 200 && best.length > Math.max(400, answer.length * 2)) { if (answer) extra.push({ t: 'note', text: answer }); answer = best; }
      const ok = done ? done.ok : code === 0;
      const error = ok ? undefined : (done?.error || tailLines(stderr, 4) || `${agent.label} exited with code ${code}`);
      return [
        ...extra,
        ...(answer ? [{ t: 'answer', text: answer, ...(parseReply(answer) || {}) }] : []),
        { t: 'done', ok, error, ms, cost: done?.cost, tokens: done?.tokens },
      ];
    },
  };
}

// ── the structured reply (sources/agents.js REPLY_FORMAT) ───────────
// The last ```json block of the answer, checked field by field; null when there's none or
// it's off-shape, and the UI shows the prose as markdown instead.
const STATUS = ['ok', 'warning', 'problem', 'info'];
const RISK = ['safe', 'changes', 'destructive'];
function parseReply(text = '') {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  const last = blocks.at(-1);
  if (!last) return null;
  let d;
  try { d = JSON.parse(last[1]); } catch { return null; }
  if (!d || typeof d !== 'object' || typeof d.summary !== 'string' || !d.summary.trim()) return null;
  const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  const pick = (v, list, dflt) => list.includes(v) ? v : dflt;
  const arr = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
  return {
    prose: text.slice(0, last.index).trim(),
    data: {
      status: pick(d.status, STATUS, 'info'),
      summary: str(d.summary, 400),
      findings: arr(d.findings).slice(0, 8).map(f => ({
        status: pick(f.status, STATUS, 'info'), title: str(f.title, 160), detail: str(f.detail, 800),
        items: Array.isArray(f.items) ? f.items.filter(i => typeof i === 'string').slice(0, 12).map(i => i.slice(0, 80)) : [],
      })).filter(f => f.title),
      replies: (Array.isArray(d.replies) ? d.replies : []).filter(r => typeof r === 'string' && r.trim()).slice(0, 3).map(r => r.trim().slice(0, 100)),
      actions: arr(d.actions).slice(0, 6).map(a => ({
        title: str(a.title, 160), command: str(a.command, 2000), risk: pick(a.risk, RISK, 'changes'), why: str(a.why, 300),
      })).filter(a => a.title),
    },
  };
}

// ── shell commands -> a human label ──────────────────────────────────
// codex wraps everything: /bin/zsh -lc 'docker ps'
function unwrapShell(cmd = '') {
  const m = cmd.match(/^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!m) return cmd;
  const a = m[1].trim();
  if (a.startsWith("'") && a.endsWith("'")) return a.slice(1, -1).replace(/'\\''/g, "'");
  if (a.startsWith('"') && a.endsWith('"')) return a.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return a;
}

// Split on ; && || | and newlines, outside quotes
function segments(cmd) {
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q) q = null; else if (ch === '\\' && q === '"') cur += cmd[++i] || ''; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      parts.push({ text: cur.trim(), piped: ch === '|' && cmd[i + 1] !== '|' });
      if (cmd[i + 1] === ch) i++;
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push({ text: cur.trim(), piped: false });
  // anything after a single | only filters the previous command
  const out = [];
  let skip = false;
  for (const p of parts) { if (!skip && p.text) out.push(p.text); skip = p.piped; }
  return out;
}

function words(s) {
  return (s.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g) || []).map(w => w.replace(/^(['"])([\s\S]*)\1$/, '$2'));
}

const CHANGE = /^(docker (rm|rmi|stop|kill|restart|start|run|exec|prune|system prune|image prune|volume (rm|prune)|container (rm|stop|prune)|compose (up|down|restart|stop|rm))|kubectl( --context \S+)? (delete|apply|scale|rollout|edit|patch|cordon|drain)|kill|pkill|killall|rm|mv|git (commit|push|reset|checkout|stash|merge|rebase)|npm (i|install)|brew (install|uninstall)|tmux kill)/;

const VALUE_FLAGS = new Set(['--context', '-n', '--namespace', '-c', '--container', '--tail', '-t', '--format', '-f', '--since',
  '-o', '--output', '-l', '--selector', '-S', '-E', '-u', '--user', '-w', '--workdir', '-e', '--env', '-p', '--filter']);

// One segment -> label. null = not worth a milestone (echo, true, cd...).
function labelOf(seg) {
  const w = words(seg).filter(x => !/^\w+=/.test(x) && !/^\d?>&?\d?$/.test(x) && !/^\d?>/.test(x));
  if (!w.length) return null;
  const [cmd, ...a] = w;
  // flags that take a value: their value is not a positional argument
  const pos = a.filter((x, i) => !x.startsWith('-') && !(VALUE_FLAGS.has(a[i - 1]) && !a[i - 1].includes('=')));
  const flag = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const name = x => clip(x || '', 28);
  switch (cmd) {
    case 'echo': case 'printf': case 'true': case 'false': case 'cd': case 'sleep': case 'export': return null;
    case 'docker': {
      const [sub, sub2] = pos;
      const target = pos[pos.length - 1];
      const map = {
        ps: 'Listed containers', images: 'Listed images', stats: 'Checked container usage',
        inspect: `Inspected ${name(target)}`, logs: `Read logs of ${name(target)}`, top: `Checked processes in ${name(target)}`,
        port: `Checked ports of ${name(target)}`, diff: `Checked file changes in ${name(target)}`, history: `Read history of ${name(target)}`,
        rm: `Removed ${name(target)}`, rmi: `Removed image ${name(target)}`, stop: `Stopped ${name(target)}`, kill: `Killed ${name(target)}`,
        restart: `Restarted ${name(target)}`, start: `Started ${name(target)}`, run: `Started a container from ${name(pos[1])}`,
        exec: `Ran ${name(pos[2])} in ${name(pos[1])}`,
      };
      if (sub === 'system' && sub2 === 'df') return 'Checked Docker disk usage';
      if (sub === 'volume' || sub === 'image' || sub === 'container' || sub === 'network') return `${sub2 === 'ls' ? 'Listed' : sub2 === 'inspect' ? 'Inspected' : cap(sub2 || '')} ${sub}${sub2 === 'ls' ? 's' : pos[2] ? ' ' + name(pos[2]) : ''}`;
      if (sub === 'compose') return `docker compose ${pos[1] || ''}`.trim();
      return map[sub] || `docker ${sub || ''}`.trim();
    }
    case 'kubectl': {
      const [verb, ...rest] = pos;
      const ns = flag('-n') || flag('--namespace');
      const what = rest.join(' ');
      const verbs = { get: 'Listed', describe: 'Described', logs: 'Read logs of', top: 'Checked usage of', events: 'Read events', delete: 'Deleted', apply: 'Applied', scale: 'Scaled', rollout: 'Rolled out' };
      return `${verbs[verb] || 'kubectl ' + verb} ${name(what)}${ns ? ` in ${ns}` : ''}`.trim();
    }
    case 'tmux': {
      const t = flag('-t');
      if (pos[0] === 'capture-pane') return `Read the screen of ${name((t || '').replace(/^=/, '')) || 'a pane'}`;
      if (/^list-/.test(pos[0] || '')) return `Listed tmux ${pos[0].slice(5)}`;
      if (pos[0] === 'kill-session') return `Closed tmux session ${name((t || '').replace(/^=/, ''))}`;
      return `tmux ${pos[0] || ''}`.trim();
    }
    case 'lsof': { const i = a.find(x => /^-i:?\S*/.test(x)); const port = (i && i.replace(/^-i/, '')) || flag('-i') || ''; return port ? `Checked who uses ${port.replace(/^:/, 'port ').replace(/^tcp:/i, 'port ')}` : 'Checked open files'; }
    case 'ps': case 'pgrep': case 'top': return 'Checked running processes';
    case 'kill': case 'pkill': case 'killall': return `Stopped process ${name(pos[0])}`;
    case 'git': return { status: 'Checked git status', log: 'Read git history', diff: 'Read the diff', show: `Read commit ${name(pos[1] || '')}`.trim(), branch: 'Listed branches' }[pos[0]] || `git ${pos[0] || ''}`.trim();
    case 'cat': case 'head': case 'tail': case 'less': case 'bat': case 'sed': return pos.length ? `Read ${list(pos.filter(x => !/^\d+$/.test(x) && !/^s\//.test(x)).map(base))}` : null;
    case 'ls': return `Listed ${base(pos[0]) || 'folder'}`;
    case 'grep': case 'rg': return pos[0] ? `Searched for “${clip(pos[0], 30)}”` : 'Searched';
    case 'find': case 'fd': return 'Searched files';
    case 'curl': case 'wget': { const u = pos.find(x => /^https?:\/\//.test(x) || /^localhost/.test(x)); return u ? `Requested ${clip(u.replace(/^https?:\/\//, ''), 40)}` : 'Made a request'; }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return `Ran ${cmd} ${pos.slice(0, 2).join(' ')}`.trim();
    case 'du': case 'df': return 'Checked disk usage';
    case 'jq': return null;
    default: return clip(`Ran ${base(cmd)}${pos[0] ? ' ' + pos[0] : ''}`, 48);
  }
}

function describeCommand(command = '') {
  const segs = segments(command);
  const labels = [...new Set(segs.map(labelOf).filter(Boolean))];
  return {
    kind: 'cmd',
    label: labels.length ? labels.slice(0, 2).join(' · ') + (labels.length > 2 ? ` +${labels.length - 2}` : '') : clip(command, 48),
    detail: command,
    change: segs.some(s => CHANGE.test(words(s).filter(x => !/^\w+=/.test(x)).join(' '))),
  };
}

// ── small helpers ────────────────────────────────────────────────────
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function base(p) { return p ? path.basename(String(p).replace(/\/+$/, '')) || p : ''; }
function host(u) { try { return new URL(u).host; } catch { return clip(u, 30); } }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function list(xs) { xs = xs.filter(Boolean); return xs.length > 2 ? `${xs.slice(0, 2).join(', ')} +${xs.length - 2}` : xs.join(', '); }
function textOf(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join('\n') : ''; }
function tailLines(s, n) { return s ? String(s).trimEnd().split('\n').slice(-n).join('\n').slice(-800) : undefined; }

module.exports = { AGENTS, createReducer, describeCommand, unwrapShell, isFiller, readOnlyCommands, parseReply };

// Self-check: node agents/adapters.js
if (require.main === module) {
  const assert = require('assert');
  const L = c => describeCommand(c).label;
  assert.strictEqual(unwrapShell(`/bin/zsh -lc 'docker ps'`), 'docker ps');
  assert.strictEqual(unwrapShell(`/bin/zsh -lc "docker inspect --format '{{json .State}}' ce4"`), "docker inspect --format '{{json .State}}' ce4");
  assert.strictEqual(L('docker ps --format "{{.Names}}" | head -3'), 'Listed containers');
  assert.strictEqual(L("docker inspect --format '{{json .State}}' ce47; echo ---; docker logs --tail 5 ce47 2>&1; false"), 'Inspected ce47 · Read logs of ce47');
  assert.strictEqual(L('kubectl --context orbstack -n kube-system logs coredns-abc -c coredns --tail 50'), 'Read logs of coredns-abc in kube-system');
  assert.strictEqual(L('kubectl --context orbstack get pods -n web'), 'Listed pods in web');
  assert.strictEqual(L('tmux capture-pane -p -t =api'), 'Read the screen of api');
  assert.strictEqual(L('lsof -i :3000'), 'Checked who uses port 3000');
  assert.strictEqual(L('docker system df -v'), 'Checked Docker disk usage');
  assert.strictEqual(L('cat /etc/hosts'), 'Read hosts');
  assert.strictEqual(L('docker volume ls'), 'Listed volumes');
  assert.strictEqual(describeCommand('docker rm -f web').change, true);
  assert.strictEqual(describeCommand('docker ps -a').change, false);
  assert.strictEqual(describeCommand('FOO=1 kill 123').change, true);
  assert.strictEqual(describeCommand('echo "a; docker rm x"').change, false); // quoted, not run
  assert.ok(isFiller("I'll run those checks in order."));
  assert.ok(isFiller('Let me check the logs.'));
  assert.ok(!isFiller('The container was OOM killed: exit 137 with 512MB limit.'));

  // reducers over event shapes recorded from real runs
  const run = (id, events, code = 0) => {
    const r = createReducer(id);
    return [...events.flatMap(e => r.push(e)), ...r.finish({ code, stderr: '', ms: 1 })];
  };
  const c = run('claude', [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'docker ps', description: 'List running containers' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/etc/hosts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'no' }], is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'It is healthy.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'It is healthy.', session_id: 's1', total_cost_usd: 0.3 },
  ]);
  assert.deepStrictEqual(c.map(m => m.t), ['session', 'step', 'step', 'step', 'step', 'answer', 'done']);
  assert.strictEqual(c[1].label, 'List running containers');
  assert.strictEqual(c[4].status, 'fail');
  assert.strictEqual(c[6].cost, 0.3);

  const x = run('codex', [
    { type: 'thread.started', thread_id: 'th' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I’ll run those checks.' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'docker ps'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'docker ps'", aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: '/bin/zsh -lc false', aggregated_output: '', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'The container exited with 137, which is an OOM kill.' } },
    { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Healthy.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  assert.deepStrictEqual(x.map(m => m.t), ['session', 'step', 'step', 'step', 'step', 'note', 'answer', 'done']);
  assert.strictEqual(x[4].status, 'fail'); // `false` gets a raw label, still a step
  assert.strictEqual(x[6].text, 'Healthy.');
  assert.strictEqual(x[7].tokens, 15);

  const o = run('opencode', [
    { type: 'step_start', sessionID: 'ses', part: {} },
    { type: 'tool_use', sessionID: 'ses', part: { tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'false' }, output: '(no output)', metadata: { exit: 1 } } } },
    { type: 'tool_use', sessionID: 'ses', part: { tool: 'read', callID: 'c2', state: { status: 'completed', input: { filePath: '/etc/hosts' } } } },
    { type: 'text', sessionID: 'ses', part: { text: 'Done, healthy.' } },
    { type: 'step_finish', sessionID: 'ses', part: { reason: 'stop', cost: 0, tokens: { input: 3, output: 2 } } },
  ]);
  assert.deepStrictEqual(o.map(m => m.t), ['session', 'step', 'step', 'step', 'step', 'answer', 'done']);
  assert.strictEqual(o[2].status, 'fail');
  assert.strictEqual(o[2].exit, 1);
  assert.strictEqual(o[6].ok, true);

  const denied = run('claude', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'd1', name: 'Bash', input: { command: 'docker rm x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.', is_error: true }] } },
  ]);
  assert.strictEqual(denied[1].status, 'blocked');
  const hooked = run('codex', [
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'docker ps', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'docker ps', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Both containers are healthy. '.repeat(30) } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'What should the hook do?' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepStrictEqual(hooked.map(m => m.t), ['step', 'step', 'note', 'note', 'answer', 'done']);
  assert.ok(hooked[4].text.startsWith('Both containers'));
  const reply = parseReply('Short take.\n\n```json\n{"status":"warning","summary":"17 copies run.","findings":[{"status":"bogus","title":"Old","items":["a",3]}],"actions":[{"title":"Stop","command":"docker stop a","risk":"destructive"},{"command":"no title"}]}\n```');
  assert.strictEqual(reply.prose, 'Short take.');
  assert.strictEqual(reply.data.status, 'warning');
  assert.strictEqual(reply.data.findings[0].status, 'info');
  assert.deepStrictEqual(reply.data.findings[0].items, ['a']);
  assert.strictEqual(reply.data.actions.length, 1);
  assert.deepStrictEqual(reply.data.replies, []);
  assert.deepStrictEqual(parseReply('```json\n{"summary":"x","replies":["Do step 1",5,"  Show logs  "]}\n```').data.replies, ['Do step 1', 'Show logs']);
  assert.deepStrictEqual(AGENTS.codex.args({ prompt: 'p', readOnly: true, session: 's' }), ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 's', 'p']);
  assert.ok(AGENTS.claude.args({ prompt: 'p', session: 's' }).join(' ').includes('-p p --resume s'));
  assert.strictEqual(parseReply('no block here'), null);
  assert.strictEqual(parseReply('```json\n{not json}\n```'), null);
  assert.strictEqual(parseReply('```json\n{"status":"ok"}\n```'), null); // no summary
  const failed = run('claude', [{ type: 'system', subtype: 'init', session_id: 's' }], 1);
  assert.strictEqual(failed.at(-1).ok, false);
  console.log('adapters: ok');
}

// Runs one agent conversation inside its tmux session: node agents/runner.js <runDir>
//
// <runDir>/spec.json      what to run (agent, first prompt, access, folder)
// <runDir>/events.jsonl   milestones, written here, read by DevDock; a turn per message
// <runDir>/inbox.jsonl    replies from DevDock, one per line: { text, prompt, readOnly }
//
// The first turn runs the request; each reply resumes the same agent session headless
// (claude -p --resume, codex exec resume, opencode run --session). Between turns, Enter
// here continues the conversation interactively instead. Started again on a stopped run,
// it picks up where the events file left off and answers what's waiting in the inbox.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AGENTS, createReducer } = require('./adapters');

const dir = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const agent = AGENTS[spec.agent];
const eventsFile = path.join(dir, 'events.jsonl');
const inboxFile = path.join(dir, 'inbox.jsonl');
const rawFile = fs.createWriteStream(path.join(dir, 'raw.jsonl'), { flags: 'a' });
const emit = m => fs.appendFileSync(eventsFile, JSON.stringify({ ...m, at: Date.now() }) + '\n');
const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m', reset: '\x1b[0m' };
const say = (s = '') => process.stdout.write(s + '\n');

function print(m) {
  if (m.t === 'user') say(`\n${C.blue}${C.bold}you${C.reset} ${m.text}${m.readOnly !== spec.readOnly ? `  ${C.dim}(${m.readOnly ? 'read-only' : 'full access'})${C.reset}` : ''}\n`);
  if (m.t === 'step' && m.status !== 'run') {
    const mark = m.status === 'ok' ? `${C.green}✓` : m.status === 'blocked' ? `${C.yellow}⊘` : `${C.red}✗`;
    say(`  ${mark}${C.reset} ${m.change ? C.yellow : ''}${m.label}${C.reset}${m.kind === 'cmd' ? `  ${C.dim}$ ${m.detail.split('\n')[0].slice(0, 100)}${C.reset}` : ''}`);
    if (m.status === 'fail' && m.out) say(C.dim + m.out.split('\n').map(l => '      ' + l).join('\n') + C.reset);
  }
  if (m.t === 'note') say(`\n  ${C.cyan}›${C.reset} ${m.text}\n`);
  if (m.t === 'answer' && !m.data) say(`\n${m.text}\n`);
  if (m.t === 'answer' && m.data) {
    // the same cards DevDock draws, as text: the raw JSON is for DevDock, not for people
    const mark = { ok: `${C.green}✓`, warning: `${C.yellow}!`, problem: `${C.red}✗`, info: `${C.cyan}i` };
    const d = m.data;
    say(`\n${mark[d.status]} ${C.bold}${d.summary}${C.reset}\n`);
    for (const f of d.findings) say(`  ${mark[f.status]}${C.reset} ${C.bold}${f.title}${C.reset}${f.detail ? `\n    ${f.detail}` : ''}`);
    if (d.actions.length) say(`\n${C.dim}Next steps${C.reset}`);
    d.actions.forEach((a, i) => say(`  ${i + 1}. ${a.title} ${C.dim}(${a.risk})${C.reset}${a.why ? `\n     ${C.dim}${a.why}${C.reset}` : ''}${a.command ? `\n     ${C.cyan}$ ${a.command}${C.reset}` : ''}`));
    say('');
  }
  if (m.t === 'done') {
    const secs = Math.round(m.ms / 1000);
    const extra = [m.cost ? `$${m.cost.toFixed(2)}` : '', m.tokens ? `${Math.round(m.tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ');
    say(m.ok ? `${C.dim}Done in ${secs}s${extra ? ' · ' + extra : ''}${C.reset}` : `${C.red}${m.error || 'Stopped'}${C.reset}`);
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // only for this script, not the agent's own node tools
let phase = 'running'; // 'running' a turn, 'waiting' for a reply or Enter, 'resumed' interactive
let child = null, stopped = false;
let offered = false; // the Enter-to-continue line is showing

// One headless turn; resolves when the agent exits
function turn({ prompt, readOnly, session }) {
  return new Promise(resolve => {
    const started = Date.now();
    const reducer = createReducer(spec.agent);
    let stderr = '', buf = '', sid = session;
    const opts = { prompt, readOnly, k8sContext: spec.k8sContext, session };
    child = spawn(spec.bin, agent.args(opts), { cwd: spec.cwd, env: { ...env, ...(agent.env?.(opts) || {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    emit({ t: 'start', pid: child.pid });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      rawFile.write(chunk);
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; } // banners, warnings
        for (const m of reducer.push(e)) {
          if (m.t === 'session') { if (m.id === sid) continue; sid = m.id; }
          emit(m);
          print(m);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => { stderr += e.message; });
    child.on('close', code => {
      for (const m of reducer.finish({ code: stopped ? 130 : code, stderr, ms: Date.now() - started })) {
        if (m.t === 'done' && stopped) Object.assign(m, { ok: false, error: 'Stopped' });
        emit(m);
        print(m);
      }
      child = null;
      resolve(sid);
    });
  });
}

// tmux kill-session sends SIGHUP: take the agent down with us.
// ⌃C mid-turn stops the agent; while waiting it closes; once resumed it's the agent's key.
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (sig === 'SIGINT' && phase === 'resumed') return;
  if (!child) process.exit(0);
  stopped = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  if (sig !== 'SIGINT') setTimeout(() => process.exit(0), 300);
});

(async () => {
  const past = readLines(eventsFile);
  let session = past.filter(e => e.t === 'session').at(-1)?.id || null;
  say(`${C.bold}${agent.label}${C.reset} ${C.dim}· ${spec.readOnly ? 'read-only' : 'full access'} · ${spec.cwd}${C.reset}`);
  say(`${C.dim}${spec.request}${C.reset}\n`);
  if (!past.length) session = await turn({ prompt: spec.prompt, readOnly: spec.readOnly });
  else past.forEach(print);

  // replies arrive in the inbox; every line past the ones already answered is new
  let answered = past.filter(e => e.t === 'user').length;
  while (session && !stopped) {
    if (phase === 'resumed') return; // the interactive agent owns the session now
    phase = 'waiting';
    const next = readLines(inboxFile)[answered];
    if (!next) {
      if (!offered) offerTerminal(session);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    answered++;
    phase = 'running';
    const m = { t: 'user', text: next.text, readOnly: !!next.readOnly };
    emit(m);
    print(m);
    session = await turn({ prompt: next.prompt, readOnly: !!next.readOnly, session }) || session;
    offered = false;
  }
  rawFile.end();
  setTimeout(() => process.exit(0), 100);
})();

// Between turns, Enter here hands the conversation to the agent's own interactive UI
function offerTerminal(session) {
  offered = true;
  say(`\n${C.bold}↵${C.reset} keep talking to ${agent.label} here, or reply in DevDock   ${C.dim}⌃C close${C.reset}`);
  process.stdin.removeAllListeners('data');
  process.stdin.resume();
  process.stdin.once('data', () => {
    if (phase !== 'waiting') return;
    phase = 'resumed';
    process.stdin.pause();
    emit({ t: 'resumed' });
    const r = spawn(spec.bin, agent.resume(session), { cwd: spec.cwd, env, stdio: 'inherit' });
    r.on('close', () => process.exit(0));
  });
}

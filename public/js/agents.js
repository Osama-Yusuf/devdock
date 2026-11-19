// Agent runs: one window with what the agent is doing, minimized runs wait in a dock.
// Data: DevDock.sourceData.agents.runs (sources/agents.js), milestones from agents/adapters.js.
// The agent itself runs in tmux; "Open in terminal" attaches to it, and once it's done,
// Enter there continues the same conversation interactively.
(function () {
  const $ = id => document.getElementById(id);
  const svg = (d, s = 14, w = 2) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    term: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    min: svg('<line x1="5" y1="12" x2="19" y2="12"/>', 14, 2.4),
    ok: svg('<polyline points="20 6 9 17 4 12"/>', 12, 3),
    fail: svg('<path d="M18 6 6 18M6 6l12 12"/>', 12, 3),
    blocked: svg('<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>', 12, 2.6),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 12),
    chev: svg('<polyline points="6 9 12 15 18 9"/>', 12),
  };
  const KIND = {
    cmd: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', 12),
    read: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 12),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 12),
    web: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>', 12),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 12),
    tool: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>', 12),
  };
  const SHOWN = 5; // latest steps on screen; earlier ones fold into one line

  let openId = null;
  let pending = null;            // a run just started, before the first scan lists it
  const expanded = new Set();    // step ids opened to show their command
  const allSteps = new Set();    // run ids with the earlier steps unfolded
  const states = {};             // run id -> last seen state, to announce finishes
  const unseen = new Set();      // finished while minimized
  let tick = null;

  const runs = () => DevDock.sourceData.agents?.runs || [];
  const runOf = id => runs().find(r => r.id === id) || (pending?.id === id ? pending : null);

  const win = Object.assign(document.createElement('div'), { className: 'agent-win', hidden: true });
  const dock = Object.assign(document.createElement('div'), { className: 'agent-dock' });
  document.body.append(win, dock);

  // ── a run is a conversation: the request, then a turn per reply ──
  function turnsOf(run) {
    const out = [{ user: run.request, readOnly: run.readOnly, events: [] }];
    for (const e of run.events || []) {
      if (e.t === 'user') out.push({ user: e.text, readOnly: e.readOnly, events: [] });
      else out.at(-1).events.push(e);
    }
    return out;
  }
  // steps in order (a step's later events replace its earlier ones) and what it said
  function timeline(events, answer) {
    const items = [], at = {};
    for (const e of events) {
      if (e.t === 'step') { if (at[e.id] == null) { at[e.id] = items.length; items.push(e); } else items[at[e.id]] = e; }
      if (e.t === 'note' && e.text.trim() !== answer?.trim()) items.push(e); // the answer has its own box
    }
    return items;
  }
  const lastTurn = run => turnsOf(run).at(-1);
  const doneOf = run => lastTurn(run).events.find(e => e.t === 'done');

  // ── the answer: verdict, findings, next steps (or plain markdown) ──
  const STATUS_ICON = {
    ok: svg('<circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>', 15),
    warning: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 15),
    problem: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>', 15),
    info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 15),
  };
  const RISK_LABEL = { safe: 'safe', changes: 'changes things', destructive: 'destructive' };
  function answerHTML(ev) {
    if (!ev.data) return `<div class="aw-answer md">${md(names(ev.text))}</div>`;
    const d = ev.data;
    return `<div class="ans st-${d.status}">
      <div class="ans-verdict"><span class="ans-ico">${STATUS_ICON[d.status]}</span><div class="md">${md(names(d.summary), true)}</div></div>
      ${d.findings.length ? `<div class="ans-findings">${d.findings.map((f, i) => `
        <div class="ans-f st-${f.status}" style="--i:${i}">
          <span class="ans-ico">${STATUS_ICON[f.status]}</span>
          <div class="ans-fbody">
            <div class="ans-ft">${md(names(f.title), true)}</div>
            ${f.detail ? `<div class="ans-fd md">${md(names(f.detail), true)}</div>` : ''}
            ${f.items.length ? `<div class="ans-items">${f.items.map(x => `<span>${esc(names(x))}</span>`).join('')}</div>` : ''}
          </div>
        </div>`).join('')}</div>` : ''}
      ${d.actions.length ? `<div class="ans-label">Next steps</div><div class="ans-actions">${d.actions.map((a, i) => `
        <div class="ans-a risk-${a.risk}" style="--i:${i + d.findings.length}">
          <div class="ans-at"><span class="ans-n">${i + 1}</span><span class="ans-atext">${md(names(a.title), true)}</span><span class="ans-risk">${RISK_LABEL[a.risk]}</span></div>
          ${a.why ? `<div class="ans-why">${md(names(a.why), true)}</div>` : ''}
          ${a.command ? `<div class="ans-cmd"><code>${esc(a.command)}</code><button class="aw-copy" data-copy="${esc(a.command)}" title="Copy">${ICON.copy}</button></div>` : ''}
        </div>`).join('')}</div>` : ''}
      ${ev.prose ? `<details class="ans-raw"><summary>Full reply</summary><div class="md">${md(names(ev.prose))}</div></details>` : ''}
    </div>`;
  }

  // agents print container ids; show the names people know them by
  function names(text) {
    const ctrs = DevDock.sourceData.containers?.containers;
    if (!ctrs) return text;
    return text.replace(/\b[0-9a-f]{12,64}\b/g, id => ctrs.find(c => c.id.startsWith(id))?.name || id);
  }

  function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function stepHTML(e) {
    if (e.t === 'note') return `<li class="aw-note">${md(e.text, true)}</li>`;
    const open = expanded.has(e.id);
    const mark = { run: '<span class="aw-spin"></span>', ok: ICON.ok, fail: ICON.fail, blocked: ICON.blocked }[e.status] || '';
    const tip = e.status === 'blocked' ? 'Blocked: this run is read-only' : e.status === 'fail' ? `Failed${e.exit ? ` (exit ${e.exit})` : ''}` : '';
    return `<li class="aw-step s-${e.status} ${e.change ? 'is-change' : ''} ${open ? 'open' : ''}" data-step="${esc(e.id)}">
      <button class="aw-step-row" ${e.detail ? '' : 'disabled'} title="${esc(tip || (e.detail ? 'Show the command' : ''))}">
        <span class="aw-mark">${mark}</span><span class="aw-kind">${KIND[e.kind] || KIND.tool}</span>
        <span class="aw-label">${esc(names(e.label))}</span>${e.change ? '<span class="aw-tag" title="This changed something">changed</span>' : ''}
      </button>
      ${open ? `<div class="aw-detail"><code>${esc(e.detail)}</code><button class="aw-copy" data-copy="${esc(e.detail)}" title="Copy">${ICON.copy}</button>${e.out ? `<pre>${esc(e.out)}</pre>` : ''}</div>` : ''}
    </li>`;
  }

  function summary(list) {
    const n = k => list.filter(e => e.kind === k).length;
    const parts = [n('cmd') && `${n('cmd')} command${n('cmd') > 1 ? 's' : ''}`, n('read') && `read ${n('read')} file${n('read') > 1 ? 's' : ''}`,
      n('search') && `${n('search')} search${n('search') > 1 ? 'es' : ''}`, n('edit') && `${n('edit')} edit${n('edit') > 1 ? 's' : ''}`].filter(Boolean);
    return parts.join(', ') || `${list.length} earlier steps`;
  }

  // ── the window ───────────────────────────────────────────────────
  // Header, thread and footer re-render as events arrive; the reply bar is built once per
  // run so what you're typing survives updates.
  let lastSig = '', mounted = null;
  const outbox = {};   // run id -> reply on its way, shown before the runner picks it up
  const replyRO = {};  // run id -> access for the next reply
  const READ_ONLY_ICON = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 13, 2.4);
  const FULL_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  const SEND_ICON = svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 16, 2.6);
  const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';

  function mount(run) {
    mounted = run.id;
    win.innerHTML = `<header class="aw-head"></header><div class="aw-progress" hidden></div><div class="aw-body"></div>
      <div class="aw-reply">
        <div class="aw-sugs"></div>
        <div class="aw-bar">
          <button class="aw-acc" data-do="access"></button>
          <textarea rows="1" spellcheck="false"></textarea>
          <button class="aw-send" data-do="send"></button>
        </div>
        <div class="aw-reply-note" hidden></div>
      </div>
      <footer class="aw-foot"></footer>`;
    const ta = win.querySelector('.aw-bar textarea');
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; win.classList.toggle('has-text', !!ta.value.trim()); });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ta.blur(); }
    });
  }

  function turnHTML(run, t, i, last) {
    const answerEv = t.events.find(e => e.t === 'answer');
    const done = t.events.find(e => e.t === 'done');
    const items = timeline(t.events, answerEv?.text);
    const running = last && ['running', 'starting'].includes(run.state);
    const key = `${run.id}:${i}`;
    // earlier turns fold their steps away; the latest shows its last few
    const keep = last ? SHOWN : 0;
    const fold = !allSteps.has(key) && items.length > keep + 1 ? items.slice(0, items.length - keep) : [];
    const visible = items.slice(fold.length);
    const access = t.readOnly !== run.readOnly || i > 0 ? `<span class="bubble-acc" title="${t.readOnly ? 'Read-only' : 'Full access'}">${t.readOnly ? READ_ONLY_ICON : FULL_ICON}</span>` : '';
    return `<div class="aw-turn">
      <div class="bubble me">${esc(t.user)}${access}</div>
      ${items.length || running ? `<ol class="aw-steps">
        ${fold.length ? `<li class="aw-fold"><button data-do="unfold" data-key="${key}">${ICON.chev}${esc(summary(fold.filter(e => e.t === 'step')))}${last ? ' earlier' : ''}</button></li>` : ''}
        ${visible.map(stepHTML).join('')}
        ${running && !visible.some(e => e.status === 'run') ? `<li class="aw-thinking"><span class="aw-spin"></span>${items.length ? 'Thinking' : `Starting ${esc(run.label)}`}\u2026</li>` : ''}
      </ol>` : ''}
      ${answerEv ? answerHTML(answerEv) : ''}
      ${done && !done.ok ? `<div class="aw-error">${esc(done.error || 'It stopped')}</div>` : ''}
      ${last && run.state === 'stopped' ? '<div class="aw-error">Stopped before it finished.</div>' : ''}
    </div>`;
  }

  function renderWin(force) {
    const run = openId && runOf(openId);
    if (!run) { if (!win.hidden) hideWin(); return; }
    if (mounted !== run.id) { mount(run); force = true; }
    const turns = turnsOf(run);
    const pend = outbox[run.id];
    if (pend && turns.length > pend.turns) delete outbox[run.id]; // the runner took it
    const sending = !!outbox[run.id];
    const done = doneOf(run);
    const sig = JSON.stringify([run.id, run.state, run.alive, run.resumed, (run.events || []).length, [...expanded], [...allSteps], sending, replyRO[run.id]]);
    updateClock(run, done);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const running = ['running', 'starting'].includes(run.state) || sending;
    const all = turns.flatMap(t => t.events);
    const steps = all.filter(e => e.t === 'step');
    const changes = steps.filter(s => s.change && s.status === 'ok').length;
    const cost = all.filter(e => e.t === 'done').reduce((n, d) => n + (d.cost || 0), 0);
    const hasSession = all.some(e => e.t === 'session');
    const inTerminal = run.alive && run.resumed;
    const ro = replyRO[run.id] ?? turns.at(-1).readOnly ?? run.readOnly;

    win.className = `agent-win st-${run.state}${win.classList.contains('in') ? ' in' : ''}${win.classList.contains('has-text') ? ' has-text' : ''}`;
    win.querySelector('.aw-head').innerHTML = `
      ${DevDockGlyph(run.agent)}
      <div class="aw-title">
        <div class="aw-req" title="${esc(run.request)}">${esc(run.request)}</div>
        <div class="aw-sub"><span>${esc(run.label)}</span>${run.items?.length ? `<span title="${esc(run.items.map(i => `${i.kind}: ${i.name}`).join('\n'))}">${run.items.length} item${run.items.length > 1 ? 's' : ''}</span>` : ''}${turns.length > 1 ? `<span>${turns.length} messages</span>` : ''}<span class="aw-clock"></span></div>
      </div>
      ${run.alive ? `<button class="aw-btn" data-do="term" title="Open its tmux session${run.resumed ? '' : '. Press \u21B5 there to keep talking in the terminal'}">${ICON.term}</button>` : ''}
      <button class="aw-btn" data-do="min" title="Minimize  Esc">${ICON.min}</button>`;
    win.querySelector('.aw-progress').hidden = !running;

    const body = win.querySelector('.aw-body');
    const stick = force || body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    const top = body.scrollTop;
    body.innerHTML = turns.map((t, i) => turnHTML(run, t, i, i === turns.length - 1 && !sending)).join('')
      + (sending ? `<div class="aw-turn"><div class="bubble me sending">${esc(outbox[run.id].text)}</div><ol class="aw-steps"><li class="aw-thinking"><span class="aw-spin"></span>Sending\u2026</li></ol></div>` : '');
    body.scrollTop = stick ? body.scrollHeight : top;

    // reply bar: suggestions from the last answer, access for this reply, send or stop
    const reply = win.querySelector('.aw-reply');
    const note = reply.querySelector('.aw-reply-note');
    reply.hidden = !hasSession && !running;
    note.hidden = !inTerminal;
    note.textContent = inTerminal ? "You're talking to it in the terminal. Reply here once you leave it." : '';
    reply.querySelector('.aw-bar').hidden = inTerminal;
    const ta = reply.querySelector('textarea');
    ta.placeholder = running ? `${run.label} is working\u2026` : `Reply to ${run.label}`;
    const acc = reply.querySelector('.aw-acc');
    acc.className = `aw-acc ${ro ? 'ro' : 'full'}`;
    acc.innerHTML = ro ? READ_ONLY_ICON : FULL_ICON;
    acc.title = `${ro ? 'Read-only' : 'Full access'} for this reply. Click to switch.`;
    const send = reply.querySelector('.aw-send');
    send.innerHTML = running ? STOP_ICON : SEND_ICON;
    send.dataset.do = running ? 'stop' : 'send';
    send.title = running ? 'Stop' : 'Send  \u21B5';
    send.classList.toggle('is-stop', running);
    const sugs = (!running && !inTerminal && turns.at(-1).events.find(e => e.t === 'answer')?.data?.replies) || [];
    const sugBox = reply.querySelector('.aw-sugs');
    const sugSig = JSON.stringify(sugs);
    if (sugBox.dataset.sig !== sugSig) {
      sugBox.dataset.sig = sugSig;
      sugBox.innerHTML = sugs.map((r, i) => `<button class="aw-sug" data-reply="${esc(r)}" style="--i:${i}">${esc(r)}</button>`).join('');
    }

    win.querySelector('.aw-foot').innerHTML = `
      <span class="aw-meta">${done && !running ? [done.ok ? `Done in ${dur(done.ms)}` : 'Failed', cost ? `$${cost.toFixed(2)}` : '', done.tokens ? `${Math.round(done.tokens / 1000)}k tokens` : '', changes ? `${changes} change${changes > 1 ? 's' : ''}` : ''].filter(Boolean).join(' \u00B7 ')
        : running ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}</span>
      <span class="aw-access ${run.readOnly ? 'ro' : ''}">${run.readOnly ? 'read-only' : 'full access'}</span>
      ${!running ? '<button class="aw-ghost" data-do="dismiss">Dismiss</button>' : ''}`;
    updateClock(run, done);
  }

  async function sendReply(textArg) {
    const run = runOf(openId);
    const ta = win.querySelector('.aw-bar textarea');
    const text = (textArg ?? ta.value).trim();
    if (!run || !text || outbox[run.id] || ['running', 'starting'].includes(run.state)) return;
    const readOnly = replyRO[run.id] ?? turnsOf(run).at(-1).readOnly ?? run.readOnly;
    outbox[run.id] = { text, turns: turnsOf(run).length };
    ta.value = ''; ta.style.height = 'auto'; win.classList.remove('has-text');
    renderWin(true);
    const ok = await sourceAction('agents', 'reply', { id: run.id, text, readOnly });
    if (!ok) { delete outbox[run.id]; ta.value = text; win.classList.add('has-text'); renderWin(true); }
  }
  function updateClock(run, done) {
    const el = win.querySelector('.aw-clock');
    const since = (run.events || []).filter(e => e.t === 'user').at(-1)?.at || run.createdAt || Date.now(); // this turn's start
    if (el) el.textContent = done || !['running', 'starting'].includes(run.state) ? '' : dur(Date.now() - since);
  }

  function showWin() {
    win.hidden = false;
    requestAnimationFrame(() => win.classList.add('in'));
    clearInterval(tick);
    tick = setInterval(() => { const r = runOf(openId); if (r) updateClock(r, doneOf(r)); }, 1000);
  }
  function hideWin() {
    mounted = null;
    win.classList.remove('in');
    win.hidden = true;
    clearInterval(tick);
    lastSig = '';
  }

  function show(id, optimistic) {
    if (optimistic && !runs().some(r => r.id === id)) {
      pending = { id, ...optimistic, state: 'starting', alive: true, events: [], createdAt: Date.now(), session: 'devdock-agent-' + id };
    }
    openId = id;
    states[id] ||= 'running';
    renderWin(true);
    showWin();
    renderDock();
  }
  function minimize() { openId = null; hideWin(); renderDock(); }

  win.addEventListener('click', async e => {
    const step = e.target.closest('.aw-step-row');
    if (step && !step.disabled) {
      const id = step.parentElement.dataset.step;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      return renderWin(true);
    }
    const sug = e.target.closest('[data-reply]');
    if (sug) return sendReply(sug.dataset.reply); // quick replies send right away, like iMessage
    const cp = e.target.closest('[data-copy]');
    if (cp) return copyText(cp.dataset.copy, 'Command');
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const run = runOf(openId);
    if (!run) return;
    const act = b.dataset.do;
    if (act === 'min') minimize();
    if (act === 'unfold') { allSteps.add(b.dataset.key); renderWin(true); }
    if (act === 'send') sendReply();
    if (act === 'access') { replyRO[run.id] = !(replyRO[run.id] ?? turnsOf(run).at(-1).readOnly ?? run.readOnly); renderWin(true); }
    if (act === 'term') openSession({ mux: 'tmux', id: run.session }, `${run.label} · ${run.request.slice(0, 60)}`);
    if (act === 'stop') await sourceAction('agents', 'stop', { id: run.id });
    if (act === 'dismiss') {
      if (await sourceAction('agents', 'dismiss', { id: run.id })) {
        DevDock.sourceData.agents.runs = runs().filter(r => r.id !== run.id);
        minimize();
      }
    }
  });
  document.addEventListener('keydown', e => {
    if (win.hidden) return;
    if (e.key === 'Escape' && !document.querySelector('.composer') && !e.defaultPrevented && !win.contains(document.activeElement)) {
      const overlay = [...document.querySelectorAll('.modal-overlay, .confirm-overlay')].some(m => m.style.display && m.style.display !== 'none');
      if (!overlay) minimize();
    }
  });

  // ── the dock ─────────────────────────────────────────────────────
  let dockSig = '';
  function renderDock() {
    const list = runs().slice(0, 6);
    const sig = JSON.stringify([openId, [...unseen], list.map(r => [r.id, r.state])]);
    if (sig === dockSig) return;
    dockSig = sig;
    document.body.classList.toggle('has-agent-dock', list.length > 0);
    dock.innerHTML = list.map(r => `<button class="ad-pill st-${r.state} ${r.id === openId ? 'is-open' : ''} ${unseen.has(r.id) ? 'unseen' : ''}" data-run="${r.id}"
        title="${esc(`${r.request}\n${r.label} · ${{ running: 'working', done: 'done', failed: 'failed', stopped: 'stopped' }[r.state] || r.state}`)}">
        ${DevDockGlyph(r.agent)}<span class="ad-ring"></span></button>`).join('');
  }
  dock.addEventListener('click', e => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    unseen.delete(b.dataset.run);
    b.dataset.run === openId ? minimize() : show(b.dataset.run);
  });

  // ── data in ──────────────────────────────────────────────────────
  document.addEventListener('devdock:source', e => {
    if (e.detail !== 'agents') return;
    if (pending && runs().some(r => r.id === pending.id)) pending = null;
    for (const r of runs()) {
      const was = states[r.id];
      states[r.id] = r.state;
      if (was === 'running' && r.state !== 'running' && (r.id !== openId || document.hidden)) {
        if (r.id !== openId) unseen.add(r.id);
        notify(`${r.label} ${r.state === 'done' ? 'finished' : r.state}`, r.request.slice(0, 80));
      }
    }
    if (openId && !runOf(openId)) minimize();
    renderWin();
    renderDock();
  });

  // ── a small markdown renderer: answers come as GitHub-flavored text ──
  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, (m, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function md(text, oneLine) {
    const parts = String(text).split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
    return parts.map((p, i) => {
      if (i % 2) return `<div class="md-code"><pre><code>${esc(p.replace(/\n$/, ''))}</code></pre><button class="aw-copy" data-copy="${esc(p.trim())}" title="Copy">${ICON.copy}</button></div>`;
      const lines = esc(p).split('\n');
      let html = '', list = null, para = [];
      const flushPara = () => { if (para.length) html += oneLine ? inline(para.join(' ')) : `<p>${inline(para.join(' '))}</p>`; para = []; };
      const flushList = () => { if (list) html += `</${list}>`; list = null; };
      for (const l of lines) {
        const h = l.match(/^#{1,4}\s+(.*)/), ul = l.match(/^\s*[-*•]\s+(.*)/), ol = l.match(/^\s*\d+[.)]\s+(.*)/);
        if (h) { flushPara(); flushList(); html += `<h4>${inline(h[1])}</h4>`; }
        else if (ul || ol) {
          flushPara();
          const want = ul ? 'ul' : 'ol';
          if (list !== want) { flushList(); html += `<${want}>`; list = want; }
          html += `<li>${inline((ul || ol)[1])}</li>`;
        } else if (!l.trim()) { flushPara(); flushList(); }
        else { flushList(); para.push(l.trim()); }
      }
      flushPara(); flushList();
      return html;
    }).join('');
  }

  window.DevDockAgents = { show, minimize };
})();

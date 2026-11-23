// Select rows on any tab, then act on them together or hand them to a coding agent.
//
//   drag on empty space      draw a box, every row it touches is selected (⇧ or ⌘ flips them)
//   ⌘-click a row            add or remove it; once something is selected a plain click does
//   ⇧-click                  select the range from the last row clicked
//   ⌘A / Esc                 select everything shown / clear
//   ⌥-drag                   selects text, as usual
//
// Each tab answers two questions (dashboard.js, views/*.js):
//   DevDockViews[tab].pick(key)   -> { kind, name, facts, ref?, cwd?, raw } or null when it's gone
//   DevDockViews[tab].bulk(items) -> [{ label, icon?, danger?, run() }]
// Selections survive searching: pick what one search finds, search again, add more.
(function () {
  const ROWS = { servers: '#tableBody', sessions: '#sessionsView', containers: '#containersView', apps: '#appsView', coding: '#codingView' };
  // where a drag must not start: anything you can click, type in or that floats above the table
  const INTERACTIVE = 'a, button, input, select, textarea, label, [onclick], [contenteditable], .path-link, .pid-copy, .chip-tmux, .actions-menu, .group-header, .modal-overlay, .confirm-overlay, #selDock, .agent-win, .agent-dock, .xterm, .help-panel, header, .toolbar, .tabs, .icon-group';
  const sel = new Set();
  let anchor = null;

  const $ = id => document.getElementById(id);
  const view = () => DevDockViews[DevDock.tab];
  const container = () => ROWS[DevDock.tab] && document.querySelector(ROWS[DevDock.tab]);
  const rows = () => [...(container()?.querySelectorAll('tr[data-key]') || [])].filter(r => !r.classList.contains('group-row') && r.offsetParent);
  const items = () => [...sel].map(k => view()?.pick?.(k)).filter(Boolean);
  const agentsData = () => DevDock.sourceData.agents;
  const agentsOn = () => !!agentsData()?.enabled && agentsData().agents.some(a => a.installed);

  // ── painting ─────────────────────────────────────────────────────
  function paintRows() {
    container()?.querySelectorAll('tr[data-key]').forEach(r => r.classList.toggle('is-selected', sel.has(r.dataset.key)));
  }
  function paint() {
    for (const k of [...sel]) if (!view()?.pick?.(k)) sel.delete(k); // killed, removed, closed
    document.body.classList.toggle('selecting', sel.size > 0);
    paintRows();
    renderBar();
  }
  // Views re-render whole tables on every update; put the selection back each time
  const mo = new MutationObserver(() => { if (sel.size) paint(); });
  Object.values(ROWS).forEach(q => { const el = document.querySelector(q); if (el) mo.observe(el, { childList: true, subtree: true }); });
  new MutationObserver(() => clear()).observe(document.body, { attributes: true, attributeFilter: ['data-tab'] });
  document.addEventListener('devdock:source', () => { if (sel.size) paint(); else renderBar(); });

  function set(keys) { sel.clear(); keys.forEach(k => sel.add(k)); paint(); }
  function toggle(key) { sel.has(key) ? sel.delete(key) : sel.add(key); anchor = key; paint(); }
  function clear() { if (!sel.size && !composerOpen) return; sel.clear(); anchor = null; closeComposer(); paint(); }

  // ── drag to select ───────────────────────────────────────────────
  let drag = null;
  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.altKey || !container() || e.target.closest(INTERACTIVE)) return; // ⌥-drag selects text
    // the table, or the empty margins around it; not the header and search bar
    if (!e.target.closest('section[data-view]') && !e.target.matches('html, body, .card, .inner')) return;
    e.preventDefault(); // no text selection while drawing the box
    drag = { x: e.pageX, y: e.pageY, cx: e.clientX, cy: e.clientY, base: e.shiftKey || e.metaKey ? new Set(sel) : new Set(), active: false };
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    drag.cx = e.clientX; drag.cy = e.clientY;
    if (!drag.active) {
      if (Math.hypot(e.pageX - drag.x, e.pageY - drag.y) < 6) return; // a click, not a drag
      drag.active = true;
      drag.box = Object.assign(document.createElement('div'), { className: 'marquee' });
      document.body.append(drag.box);
      document.body.classList.add('marquee-on');
      window.getSelection()?.removeAllRanges();
      autoScroll();
    }
    updateDrag();
  });
  function updateDrag() {
    const x = drag.cx + scrollX, y = drag.cy + scrollY;
    const l = Math.min(x, drag.x), t = Math.min(y, drag.y), r = Math.max(x, drag.x), b = Math.max(y, drag.y);
    Object.assign(drag.box.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
    const hits = rows().filter(row => {
      const bb = row.getBoundingClientRect();
      return bb.bottom + scrollY > t && bb.top + scrollY < b && bb.right + scrollX > l && bb.left + scrollX < r;
    }).map(row => row.dataset.key);
    // ⇧/⌘-drag flips what it touches: unselected rows join, selected ones leave
    sel.clear();
    drag.base.forEach(k => sel.add(k));
    hits.forEach(k => (drag.base.has(k) ? sel.delete(k) : sel.add(k)));
    document.body.classList.toggle('selecting', sel.size > 0);
    paintRows();
  }
  // Near the window's top or bottom edge the page scrolls, faster the closer you get
  function autoScroll() {
    if (!drag?.active) return;
    const edge = 48, y = drag.cy;
    const v = y < edge ? -(edge - y) / 3 : y > innerHeight - edge ? (y - innerHeight + edge) / 3 : 0;
    if (v) { scrollBy(0, v); updateDrag(); }
    requestAnimationFrame(autoScroll);
  }
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const was = drag.active;
    drag.box?.remove();
    document.body.classList.remove('marquee-on');
    drag = null;
    if (!was) return;
    // the mouseup becomes a click on whatever is under it; that click isn't a choice
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, true), 0);
    if (sel.size && !anchor) anchor = [...sel].at(-1);
    paint();
  });

  // ── clicks and keys ──────────────────────────────────────────────
  document.addEventListener('click', e => {
    const row = e.target.closest('tr[data-key]');
    if (!row || row.classList.contains('group-row') || !container()?.contains(row) || e.target.closest(INTERACTIVE)) return;
    if (!sel.size && !e.metaKey && !e.shiftKey) return; // plain clicks belong to the row until you start selecting
    e.preventDefault();
    if (e.shiftKey && anchor) {
      const keys = rows().map(r => r.dataset.key);
      const [a, b] = [keys.indexOf(anchor), keys.indexOf(row.dataset.key)].sort((x, y) => x - y);
      if (a >= 0) { keys.slice(a, b + 1).forEach(k => sel.add(k)); return paint(); }
    }
    toggle(row.dataset.key);
  });
  const typing = () => document.activeElement?.matches('input, textarea, select, [contenteditable]');
  const overlayOpen = () => [...document.querySelectorAll('.modal-overlay, .confirm-overlay')].some(m => m.style.display && m.style.display !== 'none');
  document.addEventListener('keydown', e => {
    if (overlayOpen()) return;
    if (e.key === 'Escape' && composerOpen) { e.preventDefault(); return closeComposer(); }
    if (e.key === 'Escape' && sel.size && !typing()) { e.preventDefault(); return clear(); }
    if (e.metaKey && e.key.toLowerCase() === 'a' && container() && !typing()) { e.preventDefault(); return set(rows().map(r => r.dataset.key)); }
    if (e.metaKey && e.key === 'Enter' && sel.size && agentsOn()) { e.preventDefault(); return composerOpen ? send() : openComposer(); }
  });

  // ── the floating bar ─────────────────────────────────────────────
  const dock = Object.assign(document.createElement('div'), { id: 'selDock' });
  document.body.append(dock);
  let barSig = '', actions = [];

  function renderBar() {
    const its = items();
    if (!its.length) { if (barSig) { dock.className = ''; barSig = ''; setTimeout(() => { if (!barSig) dock.innerHTML = ''; }, 200); } return; }
    actions = view()?.bulk?.(its) || [];
    const shown = new Set(rows().map(r => r.dataset.key));
    const hidden = [...sel].filter(k => !shown.has(k)).length;
    const agent = currentAgent();
    const sig = JSON.stringify([its.length, hidden, actions.map(a => a.label), agentsOn() && agent?.id, composerOpen]);
    if (sig === barSig) return;
    const fresh = !barSig;
    barSig = sig;
    dock.className = 'show';
    const bar = `<div class="sel-bar ${fresh ? 'enter' : ''}" role="toolbar" aria-label="Selection">
      <span class="sel-count"><b>${its.length}</b> selected${hidden ? `<span class="sel-hidden" title="Selected, but the search hides them">${hidden} hidden</span>` : ''}</span>
      <button class="sel-x" data-act="clear" title="Clear selection  Esc" aria-label="Clear selection"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      ${actions.length ? '<span class="sel-sep"></span>' : ''}
      ${actions.map((a, i) => `<button class="sel-act ${a.danger ? 'danger' : ''}" data-act="${i}">${a.icon || ''}${esc(a.label)}</button>`).join('')}
      ${agentsOn() ? `<span class="sel-sep"></span><button class="sel-ask ask-${esc(agent.id)} ${composerOpen ? 'open' : ''}" data-act="ask" title="Hand these to ${esc(agent.label)} with a prompt  ⌘↵">${glyph(agent.id)}<span>Ask ${esc(agent.label)}</span></button>` : ''}
    </div>`;
    const cmp = dock.querySelector('.composer');
    dock.innerHTML = bar;
    if (cmp) dock.prepend(cmp); // keep what's typed
  }
  dock.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'clear') return clear();
    if (a === 'ask') return composerOpen ? closeComposer() : openComposer();
    const act = actions[+a];
    if (act && await act.run() !== false) clear();
  });

  // ── composer: prompt + suggestions ───────────────────────────────
  let composerOpen = false;
  let runAgent = null, readOnly = null; // this run only; Settings hold the defaults
  function currentAgent() {
    const list = agentsData()?.agents.filter(a => a.installed) || [];
    return list.find(a => a.id === runAgent) || list.find(a => a.id === currentSettings.agent) || list[0];
  }
  const runReadOnly = () => readOnly ?? !!currentSettings.agentReadOnly;
  const ACCESS = {
    full: 'Full access: it runs any command without asking, including stopping or deleting things.',
    claude: 'Read-only: only inspection commands (docker ps/inspect/logs, kubectl get/describe/logs, ps, lsof, git status, cat…).',
    opencode: 'Read-only: only inspection commands (docker ps/inspect/logs, kubectl get/describe/logs, ps, lsof, git status, cat…).',
    codex: "Read-only: Codex's sandbox can't change files or reach Docker; it works from the snapshot DevDock attaches.",
  };
  const KIND_ICON = {
    server: '<path d="M4 4h16v6H4zM4 14h16v6H4z"/><path d="M8 7h.01M8 17h.01"/>',
    session: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    container: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M6 7V4h12v3"/>',
    image: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/>',
    volume: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
    agent: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    app: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  };
  const ico = (k, s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KIND_ICON[k] || KIND_ICON.server}</svg>`;

  function openComposer() {
    if (!sel.size || !agentsOn()) return;
    composerOpen = true;
    runAgent = null; readOnly = null;
    window.DevDockAgents?.minimize(); // one floating panel at a time
    renderComposer();
    renderBar();
    dock.querySelector('.cmp-input textarea')?.focus();
  }
  function closeComposer() {
    if (!composerOpen) return;
    composerOpen = false;
    const c = dock.querySelector('.composer');
    if (c) { c.classList.add('leave'); setTimeout(() => c.remove(), 160); }
    renderBar();
  }

  function renderComposer() {
    const its = items();
    const agent = currentAgent();
    const ro = runReadOnly();
    const sugs = window.DevDockSuggest(its);
    const counts = {};
    its.forEach(i => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
    const old = dock.querySelector('.composer');
    const text = old?.querySelector('textarea')?.value || '';
    const installed = agentsData().agents.filter(a => a.installed);
    const html = `<div class="composer">
      <div class="cmp-head">
        <div class="cmp-ctx" title="${esc(its.map(i => `${i.kind}: ${i.name}`).join('\n'))}">${Object.entries(counts).map(([k, n]) => `<span class="cmp-chip">${ico(k)}${n} ${k}${n > 1 ? 's' : ''}</span>`).join('')}</div>
        <div class="cmp-opts">
          ${installed.length > 1 ? `<div class="cmp-seg" role="radiogroup" aria-label="Agent">${installed.map(a => `<button role="radio" aria-checked="${a.id === agent.id}" data-agent="${a.id}" title="${esc(a.label)}${a.version ? ' ' + esc(a.version) : ''}">${glyph(a.id)}<span>${esc(a.label)}</span></button>`).join('')}</div>`
            : `<span class="cmp-agent">${glyph(agent.id)}${esc(agent.label)}</span>`}
          <button class="cmp-access ${ro ? 'ro' : 'full'}" data-access title="${esc((ro ? ACCESS[agent.id] : ACCESS.full) + '\nClick to switch for this run only. The default is in Settings.')}">
            ${ro ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Read-only'
              : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Full access'}
          </button>
        </div>
      </div>
      <div class="cmp-input">
        <textarea rows="1" spellcheck="false" placeholder="${esc(sugs[0] ? sugs[0].text : `Ask about ${its.length === 1 ? its[0].name : 'these'}…`)}">${esc(text)}</textarea>
        ${sugs[0] ? '<kbd class="cmp-tab" title="Use the suggestion">tab</kbd>' : ''}
        <button class="cmp-send" data-send title="Send  ↵" aria-label="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
      <div class="cmp-sugs">${sugs.map((s, i) => `<button class="cmp-sug" data-sug="${i}" style="--i:${i}">${s.icon}<span>${esc(s.text)}</span></button>`).join('')}</div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const fresh = wrap.firstElementChild;
    if (old) { fresh.classList.add('no-enter'); old.replaceWith(fresh); } else dock.prepend(fresh);
    fresh._sugs = sugs;
    const ta = fresh.querySelector('textarea');
    autosize(ta);
    ta.addEventListener('input', () => { autosize(ta); fresh.classList.toggle('has-text', !!ta.value); });
    fresh.classList.toggle('has-text', !!ta.value);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      if (e.key === 'Tab' && !ta.value && sugs[0]) { e.preventDefault(); useSuggestion(0); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposer(); }
    });
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
  function useSuggestion(i) {
    const c = dock.querySelector('.composer');
    const ta = c?.querySelector('textarea');
    if (!ta || !c._sugs[i]) return;
    ta.value = c._sugs[i].text;
    autosize(ta);
    c.classList.add('has-text');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  dock.addEventListener('click', e => {
    const s = e.target.closest('[data-sug]');
    if (s) return useSuggestion(+s.dataset.sug);
    const a = e.target.closest('[data-agent]');
    if (a) { runAgent = a.dataset.agent; return renderComposer(); }
    if (e.target.closest('[data-access]')) { readOnly = !runReadOnly(); return renderComposer(); }
    if (e.target.closest('[data-send]')) send();
  });

  let sending = false;
  async function send() {
    const c = dock.querySelector('.composer');
    const ta = c?.querySelector('textarea');
    const request = (ta?.value.trim() || '');
    if (!request) { c?.classList.add('shake'); setTimeout(() => c?.classList.remove('shake'), 400); ta?.focus(); return; }
    if (sending) return;
    sending = true;
    c.classList.add('sending');
    const its = items();
    const cwds = [...new Set(its.map(i => i.cwd).filter(Boolean))];
    const agent = currentAgent();
    const res = await sourceAction('agents', 'start', {
      agent: agent.id, request, readOnly: runReadOnly(), cwd: cwds.length === 1 ? cwds[0] : '',
      k8sContext: its.find(i => i.k8sContext)?.k8sContext || '',
      items: its.map(({ kind, name, ref, mux, facts }) => ({ kind, name, ref, mux, facts })),
    });
    sending = false;
    c.classList.remove('sending');
    if (!res) return;
    composerOpen = false;
    dock.querySelector('.composer')?.remove();
    clear();
    window.DevDockAgents?.show(res.id, { agent: agent.id, label: agent.label, request, readOnly: runReadOnly() });
  }

  // Agent marks: a colored initial, not a logo
  function glyph(id) { return `<span class="agent-glyph g-${id}">${{ claude: '✻', codex: '◎', opencode: '⌬' }[id] || '✦'}</span>`; }
  window.DevDockGlyph = glyph;
  window.DevDockSelection = { clear, items, set, get size() { return sel.size; } };

  // ── Pattern chips: groups worth acting on together ───────────────
  // A view lists rules; each rule maps an item to a group ({ id, label, title, min }) or
  // nothing. Groups big enough become chips. A click filters the view to the group and
  // selects it; another click shows everything again. Per view, not saved.
  const active = {}; // view -> group
  window.DevDockPatterns = {
    find(scope, items, keyOf, rules) {
      const g = {};
      for (const it of items) for (const rule of rules) {
        const m = rule(it);
        if (m) (g[m.id] ||= { ...m, keys: [] }).keys.push(keyOf(it));
      }
      // a group of everything filters nothing
      const found = Object.values(g).filter(x => x.keys.length >= (x.min || 2) && x.keys.length < items.length)
        .sort((a, b) => b.keys.length - a.keys.length).slice(0, 4);
      if (active[scope]) active[scope] = found.find(x => x.id === active[scope].id) || null; // keys stay current
      return found;
    },
    filter(scope, list, keyOf) { const a = active[scope]; return a ? list.filter(it => a.keys.includes(keyOf(it))) : list; },
    on: scope => !!active[scope],
    html(scope, groups) {
      return groups.map(p => {
        const on = active[scope]?.id === p.id;
        return `<button class="pattern ${on ? 'active' : ''}" data-scope="${esc(scope)}" data-p="${esc(p.id)}" onclick="DevDockPatterns.toggle(this.dataset.scope, this.dataset.p)" title="${esc(p.title)}. ${on ? 'Click to show all' : 'Click to filter and select them'}">${esc(p.label)}<span>${p.keys.length}</span></button>`;
      }).join('');
    },
    toggle(scope, id) {
      const was = active[scope];
      active[scope] = was?.id === id ? null : { id, keys: [] };
      DevDockViews[scope.split(':')[0]].render(); // find() fills in the keys
      if (active[scope]) set(rows().map(r => r.dataset.key));
      else if (was) clear();
    },
  };
})();

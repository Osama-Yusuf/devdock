// Sessions tab: every tmux, Zellij, screen, herdr and Rex session, servers or not.
// Data comes from sources/sessions.js; helpers (esc, timeAgo, ...) from dashboard.js.
(function () {
  const view = document.getElementById('sessionsView');
  const ICON_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_CODE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  const ICON_BRANCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  let byKey = {};
  let mux = 'all'; // the multiplexer filter
  try { mux = localStorage.getItem('devdock:sessions-mux') || 'all'; } catch {}

  const data = () => DevDock.sourceData.sessions || { sessions: [], muxes: [] };
  const label = mux => data().muxes.find(m => m.mux === mux)?.label || mux;

  function matches(s, q) {
    if (!q) return true;
    const hay = [s.name, s.mux, s.cwd, s.branch, ...s.agents, ...s.ports, s.idle ? 'idle' : '', s.attached ? 'attached' : ''].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  }

  // attached first, then most recently active
  const order = (a, b) => (b.attached === true) - (a.attached === true) || (b.lastActive || b.createdAt || 0) - (a.lastActive || a.createdAt || 0);

  function stateHTML(s) {
    if (s.state !== 'running') return `<span class="chip chip-idle" title="Not running; opening it starts it again">${esc(s.state)}</span>`;
    if (s.attached) return '<span class="chip chip-live" title="A terminal is attached">attached</span>';
    if (s.idle) return `<span class="chip chip-idle" title="Nobody attached, no output for ${currentSettings.idleAfterHours}h">idle</span>`;
    return '';
  }

  function rowHTML(s, i) {
    const open = s.canOpen || s.canShow;
    const menu = [
      open && `<button onclick="DevDockViews.sessions.open(this.dataset.key)" data-key="${esc(s.key)}">${ICON_OPEN}${s.canOpen ? 'Open here' : `Show in ${esc(label(s.mux))}`}</button>`,
      s.cwd && `<button onclick="openEditor(this.dataset.path)" data-path="${esc(s.cwd)}">${ICON_CODE}Open in ${esc(editorName())}</button>`,
      s.github && s.branch && `<button onclick="window.open(this.dataset.url)" data-url="${esc(s.github + '/tree/' + s.branch.split('/').map(encodeURIComponent).join('/'))}">${ICON_BRANCH}Open branch on GitHub</button>`,
      s.canRename && `<button onclick="DevDockViews.sessions.rename(this.dataset.key)" data-key="${esc(s.key)}">${ICON_EDIT}Rename</button>`,
      s.canKill && `<div class="actions-divider"></div><button class="danger" onclick="DevDockViews.sessions.kill(this.dataset.key)" data-key="${esc(s.key)}">${ICON_CLOSE}Close session</button>`,
    ].filter(Boolean).join('');
    return `<tr data-key="${esc(s.key)}">
      <td><span class="chip chip-mux" title="${esc(label(s.mux))}">${esc(label(s.mux))}</span></td>
      <td class="col-name"><span class="path-cell">${open
        ? `<button class="link-btn trunc" onclick="DevDockViews.sessions.open(this.dataset.key)" data-key="${esc(s.key)}" title="${s.canOpen ? 'Open it here' : 'Show it in ' + esc(label(s.mux))}">${esc(s.name)}</button>`
        : `<span class="trunc">${esc(s.name)}</span>`}${s.name.startsWith('devdock-agent-') ? '<span class="chip chip-agent" title="An agent DevDock started for you">agent run</span>' : ''}${stateHTML(s)}${agentStateHTML(s.agentState, true)}</span></td>
      <td class="col-path"><span class="path-cell">${s.cwd
        ? `<span class="path-link trunc" data-path="${esc(s.cwd)}" onclick="copyText(this.dataset.path, 'Path')" title="${esc(s.cwd)}\nClick to copy">‎${esc(tildify(s.cwd))}‎</span>`
        : '<span class="code">—</span>'}${s.branch ? `<span class="branch trunc" title="git branch: ${esc(s.branch)}">⎇ ${esc(s.branch)}</span>` : ''}${s.agents.map(a => agentHTML(a, `${a} runs in this session${s.agentStatus ? ' · ' + s.agentStatus : ''}`)).join('')}</span></td>
      <td>${s.ports.map(p => `<a href="http://localhost:${p}" target="_blank" class="code port-link">${p}</a>`).join(' ') || '<span class="code">—</span>'}</td>
      <td class="col-user">${s.windows ? `<span class="code" title="${s.windows} window${s.windows > 1 ? 's' : ''}, ${s.panes} pane${s.panes > 1 ? 's' : ''}">${s.windows}</span>` : '<span class="code">—</span>'}</td>
      <td class="col-user">${s.lastActive ? `<span title="Last output ${new Date(s.lastActive).toLocaleString()}">${timeAgo(s.lastActive)}</span>` : '<span class="code">—</span>'}</td>
      <td class="col-user">${s.createdAt ? `<span title="${new Date(s.createdAt).toLocaleString()}">${timeAgo(s.createdAt)}</span>` : '<span class="code">—</span>'}</td>
      <td class="actions-cell" style="text-align:right;">${menu
        ? `<button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('ses-${i}',this)">⋯</button><div class="actions-menu" id="menu-ses-${i}">${menu}</div>`
        : ''}</td>
    </tr>`;
  }

  // Pattern chips (DevDockPatterns in js/selection.js): gv-b1, gv-b3, gv-b5 are one
  // family; so are sessions in one folder, ones running the same agent, idle ones
  const base = p => p.replace(/\/$/, '').split('/').pop() || p;
  const PATTERNS = [
    s => { const fam = s.name.replace(/[-_.]?([0-9a-f]{6,}|\d+)$/i, ''); return fam && fam !== s.name && { id: `name:${fam}`, label: `${fam}\u2026`, title: `Sessions named ${fam}\u2026` }; },
    s => s.name.includes(' / ') && { id: `space:${s.name.split(' / ')[0]}`, label: s.name.split(' / ')[0], title: `${label(s.mux)} space ${s.name.split(' / ')[0]}` },
    s => s.cwd && { id: `cwd:${s.cwd}`, label: base(s.cwd), title: `Sessions in ${s.cwd}` },
    s => s.agents[0] && { id: `agent:${s.agents[0]}`, label: s.agents[0], title: `Sessions running ${s.agents[0]}` },
    s => s.idle && { id: 'idle', label: 'idle', title: 'Idle sessions' },
    s => s.agentState?.status === 'needs-you' && { id: 'needs', label: 'needs you', title: 'Claude Code is waiting on a permission prompt or a question', min: 1 },
    s => s.agentState?.status === 'working' && { id: 'working', label: 'working', title: 'Claude Code is working', min: 1 },
  ];

  function render() {
    const d = data();
    byKey = Object.fromEntries(d.sessions.map(s => [s.key, s]));
    const q = searchInput.value.trim().toLowerCase();
    // one button per multiplexer that has sessions; a choice that emptied out falls back to All
    const kinds = [...new Set(d.sessions.map(s => s.mux))];
    if (!kinds.includes(mux)) mux = 'all';
    const base = d.sessions.filter(s => mux === 'all' || s.mux === mux);
    const patterns = DevDockPatterns.find('sessions', base, s => s.key, PATTERNS);
    const list = DevDockPatterns.filter('sessions', base.filter(s => matches(s, q)), s => s.key).sort(order);
    const idle = d.sessions.filter(s => s.idle && s.canKill);

    document.getElementById('viewStats').innerHTML = `
      <div class="stat"><span class="stat-value">${d.sessions.length}</span><span class="stat-label">sessions</span></div>
      <div class="stat"><span class="stat-value">${d.sessions.filter(s => s.attached).length}</span><span class="stat-label">attached</span></div>
      <div class="stat"><span class="stat-value">${idle.length}</span><span class="stat-label">idle</span></div>
      ${['working', 'needs-you'].map(k => { const n = d.sessions.filter(s => s.agentState?.status === k).length; return n ? `<div class="stat stat-${k}"><span class="stat-value">${n}</span><span class="stat-label">${k === 'working' ? 'working' : 'need you'}</span></div>` : ''; }).join('')}`;
    // Searching: act on what matched, like Servers' "Kill N matching"; otherwise offer the idle ones
    const matching = q ? list.filter(s => s.canKill) : [];
    document.getElementById('viewTools').innerHTML = q
      ? (matching.length ? `<button class="kill-all-btn" onclick="DevDockViews.sessions.killMatching()">\u2715 Close ${matching.length} matching</button>` : '')
      : idle.length ? `<button class="kill-all-btn" onclick="DevDockViews.sessions.killIdle()" title="Nobody attached and no output for ${currentSettings.idleAfterHours}h">Close ${idle.length} idle</button>` : '';
    setViewResult(list.length, d.sessions.length);

    const missing = d.muxes.filter(m => !m.available).map(m => m.label);
    const errors = d.muxes.filter(m => m.error).map(m => `${m.label}: ${m.error}`);
    const seg = kinds.length > 1 ? `<div class="subtabs" role="tablist"><button role="tab" class="txt" aria-selected="${mux === 'all'}" title="All sessions  \u23251" onclick="DevDockViews.sessions.setMux('all')">All</button>${kinds.map((k, i) => `<button role="tab" class="txt" aria-selected="${mux === k}" title="${esc(label(k))} sessions  \u2325${i + 2}" onclick="DevDockViews.sessions.setMux('${esc(k)}')">${esc(label(k))}<span class="seg-n">${d.sessions.filter(s => s.mux === k).length}</span></button>`).join('')}</div>` : '';
    const chips = seg || patterns.length ? `<div class="subbar">${seg}${patterns.length ? `<div class="patterns">${DevDockPatterns.html('sessions', patterns)}</div>` : ''}</div>` : '';
    view.innerHTML = chips + (list.length ? `
      <div class="scroll"><table class="sessions-table">
        <thead><tr><th>Kind</th><th>Session</th><th>Folder</th><th>Ports</th><th class="col-user">Windows</th><th class="col-user">Active</th><th class="col-user">Created</th><th></th></tr></thead>
        <tbody>${list.map(rowHTML).join('')}</tbody>
      </table></div>
      <div class="view-foot">${errors.map(esc).join('<br>')}${missing.length ? `Not installed: ${esc(missing.join(', '))}` : ''}</div>`
      : `<div class="empty-view">${q ? 'No sessions match.' : DevDock.sourceData.sessions ? 'No multiplexer sessions running.' : 'Looking for sessions…'}</div>`);
  }

  async function kill(key) {
    closeAllMenus();
    const s = byKey[key];
    if (!s) return;
    const what = [s.agents.length && `${s.agents.join(', ')} running`, s.ports.length && `serving ${s.ports.map(p => ':' + p).join(' ')}`].filter(Boolean).join(', ');
    if (!await confirmDialog(`Close ${label(s.mux)} session "${s.name}"?`, what ? `Everything in it stops: ${what}.` : 'Everything running in it stops.', 'Close')) return;
    if (await sourceAction('sessions', 'kill', { mux: s.mux, id: s.id })) showToast(`Closed ${s.name}`);
  }

  async function killMany(list, what) {
    if (!list.length) return;
    const busy = list.filter(s => s.attached || s.agents.length || s.ports.length).length;
    const detail = list.map(s => s.name).join(', ') + (busy ? `\n${busy} of them are attached or running an agent or server.` : '');
    if (!await confirmDialog(`Close ${list.length} ${what} session${list.length > 1 ? 's' : ''}?`, detail, 'Close')) return false;
    let closed = 0;
    for (const s of list) if (await sourceAction('sessions', 'kill', { mux: s.mux, id: s.id })) closed++;
    showToast(`Closed ${closed} ${what} session${closed === 1 ? '' : 's'}`);
    return true;
  }
  const killIdle = () => killMany(data().sessions.filter(s => s.idle && s.canKill), 'idle');
  const killMatching = () => {
    const q = searchInput.value.trim().toLowerCase();
    return killMany(data().sessions.filter(s => s.canKill && matches(s, q)), 'matching');
  };

  async function rename(key) {
    closeAllMenus();
    const s = byKey[key];
    if (!s) return;
    const name = await confirmDialog(`Rename ${label(s.mux)} session`, '', 'Rename', s.name);
    if (name && name !== s.name && await sourceAction('sessions', 'rename', { mux: s.mux, id: s.id, name })) showToast(`Renamed to ${name}`);
  }

  function open(key) {
    closeAllMenus();
    const s = byKey[key];
    if (!s) return;
    if (s.canOpen) openSession({ mux: s.mux, id: s.id }, `${label(s.mux)} · ${s.name}`);
    else sourceAction('sessions', 'show', { mux: s.mux, id: s.id });
  }

  // ── selection (js/selection.js) ──
  function pick(key) {
    const s = byKey[key] || data().sessions.find(x => x.key === key);
    return s && { kind: 'session', name: s.name, mux: s.mux, ref: s.mux === 'tmux' ? s.id : '', cwd: s.cwd, raw: s, facts: {
      multiplexer: label(s.mux), state: s.state, attached: s.attached == null ? '' : s.attached ? 'yes' : 'no', idle: s.idle ? 'yes' : '',
      folder: s.cwd, 'git branch': s.branch, 'agents running': s.agents.join(', '), 'agent status': s.agentState ? `${s.agentState.status}${s.agentState.since ? ' since ' + timeAgo(s.agentState.since) : ''}` : s.agentStatus, ports: s.ports.join(', '),
      windows: s.windows, 'last output': s.lastActive ? timeAgo(s.lastActive) : '', created: s.createdAt ? timeAgo(s.createdAt) : '',
    } };
  }
  function bulk(items) {
    const list = items.map(i => i.raw).filter(s => s.canKill);
    return list.length ? [{ label: `Close ${list.length}`, icon: ICON_CLOSE, danger: true, run: () => killMany(list, 'selected') }] : [];
  }

  DevDockViews.sessions = { render, open, rename, kill, setMux(m) { mux = m; try { localStorage.setItem('devdock:sessions-mux', m); } catch {} render(); }, killIdle, killMatching, pick, bulk };
})();

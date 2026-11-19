// Sessions tab: every tmux, Zellij, screen, herdr and Rex session, servers or not.
// Data comes from sources/sessions.js; helpers (esc, timeAgo, ...) from dashboard.js.
(function () {
  const view = document.getElementById('sessionsView');
  const ICON_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_CODE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  const ICON_BRANCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  let byKey = {};

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
      s.canKill && `<div class="actions-divider"></div><button class="danger" onclick="DevDockViews.sessions.kill(this.dataset.key)" data-key="${esc(s.key)}">${ICON_CLOSE}Close session</button>`,
    ].filter(Boolean).join('');
    return `<tr data-key="${esc(s.key)}">
      <td><span class="chip chip-mux" title="${esc(label(s.mux))}">${esc(label(s.mux))}</span></td>
      <td class="col-name"><span class="path-cell">${open
        ? `<button class="link-btn trunc" onclick="DevDockViews.sessions.open(this.dataset.key)" data-key="${esc(s.key)}" title="${s.canOpen ? 'Open it here' : 'Show it in ' + esc(label(s.mux))}">${esc(s.name)}</button>`
        : `<span class="trunc">${esc(s.name)}</span>`}${s.name.startsWith('devdock-agent-') ? '<span class="chip chip-agent" title="An agent DevDock started for you">agent run</span>' : ''}${stateHTML(s)}</span></td>
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

  function render() {
    const d = data();
    byKey = Object.fromEntries(d.sessions.map(s => [s.key, s]));
    const q = searchInput.value.trim().toLowerCase();
    const list = d.sessions.filter(s => matches(s, q)).sort(order);
    const idle = d.sessions.filter(s => s.idle && s.canKill);

    document.getElementById('viewStats').innerHTML = `
      <div class="stat"><span class="stat-value">${d.sessions.length}</span><span class="stat-label">sessions</span></div>
      <div class="stat"><span class="stat-value">${d.sessions.filter(s => s.attached).length}</span><span class="stat-label">attached</span></div>
      <div class="stat"><span class="stat-value">${idle.length}</span><span class="stat-label">idle</span></div>`;
    // Searching: act on what matched, like Servers' "Kill N matching"; otherwise offer the idle ones
    const matching = q ? list.filter(s => s.canKill) : [];
    document.getElementById('viewTools').innerHTML = q
      ? (matching.length ? `<button class="kill-all-btn" onclick="DevDockViews.sessions.killMatching()">\u2715 Close ${matching.length} matching</button>` : '')
      : idle.length ? `<button class="kill-all-btn" onclick="DevDockViews.sessions.killIdle()" title="Nobody attached and no output for ${currentSettings.idleAfterHours}h">Close ${idle.length} idle</button>` : '';
    setViewResult(list.length, d.sessions.length);

    const missing = d.muxes.filter(m => !m.available).map(m => m.label);
    const errors = d.muxes.filter(m => m.error).map(m => `${m.label}: ${m.error}`);
    view.innerHTML = list.length ? `
      <div class="scroll"><table class="sessions-table">
        <thead><tr><th>Kind</th><th>Session</th><th>Folder</th><th>Ports</th><th class="col-user">Windows</th><th class="col-user">Active</th><th class="col-user">Created</th><th></th></tr></thead>
        <tbody>${list.map(rowHTML).join('')}</tbody>
      </table></div>
      <div class="view-foot">${errors.map(esc).join('<br>')}${missing.length ? `Not installed: ${esc(missing.join(', '))}` : ''}</div>`
      : `<div class="empty-view">${q ? 'No sessions match.' : DevDock.sourceData.sessions ? 'No multiplexer sessions running.' : 'Looking for sessions…'}</div>`;
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
      folder: s.cwd, 'git branch': s.branch, 'agents running': s.agents.join(', '), 'agent status': s.agentStatus, ports: s.ports.join(', '),
      windows: s.windows, 'last output': s.lastActive ? timeAgo(s.lastActive) : '', created: s.createdAt ? timeAgo(s.createdAt) : '',
    } };
  }
  function bulk(items) {
    const list = items.map(i => i.raw).filter(s => s.canKill);
    return list.length ? [{ label: `Close ${list.length}`, icon: ICON_CLOSE, danger: true, run: () => killMany(list, 'selected') }] : [];
  }

  DevDockViews.sessions = { render, open, kill, killIdle, killMatching, pick, bulk };
})();

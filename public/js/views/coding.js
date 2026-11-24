// Agents tab: every coding agent running on this Mac, from sources/coding.js. Click one to
// jump to it: its tmux pane or Herdr terminal opens in DevDock; otherwise its terminal app
// comes to the front.
(function () {
  const view = document.getElementById('codingView');
  const svg = (d, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    jump: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    term: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    stop: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
    force: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
  };
  const STATE_ALL = svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>', 16);
  const FILTERS = [['all', 'All'], ['working', 'Working'], ['needs-you', 'Needs you'], ['idle', 'Idle']];
  let filter = 'all';
  try { filter = localStorage.getItem('devdock:coding-filter') || 'all'; } catch {}

  const data = () => DevDock.sourceData.coding || { agents: [] };
  const RANK = { 'needs-you': 3, working: 2, idle: 1 };
  // needs you first, then working, then most recently changed
  const order = (a, b) => (RANK[b.state?.status] || 0) - (RANK[a.state?.status] || 0) || (b.state?.since || b.startedAt || 0) - (a.state?.since || a.startedAt || 0);
  // Click a header to sort by it, again to flip; State goes back to the default order
  let sort = null;
  try { sort = JSON.parse(localStorage.getItem('devdock:coding-sort')); } catch {}
  const COLS = { name: a => a.name, folder: a => a.cwd || '', where: a => whereText(a), ports: a => a.ports[0] ?? Infinity, mem: a => a.memMB, started: a => a.startedAt || 0 };
  const sorter = () => {
    const get = sort && COLS[sort.k];
    if (!get) return order;
    return (a, b) => { const x = get(a), y = get(b); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir || order(a, b); };
  };
  const th = (label, k, cls = '', num = false) => {
    const on = k === 'state' ? !sort : sort?.k === k;
    return `<th class="${cls} sortable ${on ? `sorted ${k === 'state' ? 'desc' : sort.dir > 0 ? 'asc' : 'desc'}` : ''}" onclick="DevDockViews.coding.sort('${k}', ${num})">${label}</th>`;
  };
  const hit = (q, a) => !q || q.split(/\s+/).every(w => [a.name, a.agent, a.cwd, a.branch, a.pid, whereText(a), a.state?.status, ...a.ports].join(' ').toLowerCase().includes(w));
  const muxLabel = m => DevDock.sourceData.sessions?.muxes?.find(x => x.mux === m)?.label || m;

  function whereText(a) {
    const w = a.where || {};
    if (w.mux) return `${muxLabel(w.mux)} ${w.name}`;
    if (w.app) return w.app;
    if (w.background) return 'background';
    return 'no terminal';
  }
  function whereHTML(a) {
    const w = a.where || {};
    if (w.mux) return `<span class="chip chip-mux" title="${esc(muxLabel(w.mux))} session ${esc(w.name)}${w.target ? ', pane ' + esc(w.target) : ''}">${esc(muxLabel(w.mux))}</span><span class="trunc">${esc(w.name)}</span>`;
    if (w.app) return `<span class="chip" title="Runs in a ${esc(w.app)} window${w.background ? ', in the background of the session that started it' : ''}">${esc(w.app)}${w.background ? ' · background' : ''}</span>`;
    if (w.background) return '<span class="chip" title="A Claude Code background session, started by another session">background</span>';
    return `<span class="chip chip-orphan" title="Not in any terminal${w.parent ? `; its parent is ${esc(w.parent)}` : ''}. Often left behind by a tool that started it">no terminal</span>`;
  }
  const canJump = a => !!(a.where?.mux || a.where?.app);

  // Pattern chips (DevDockPatterns in js/selection.js)
  const PATTERNS = [
    a => ({ id: `agent:${a.agent}`, label: a.agent, title: `${a.agent} sessions` }),
    a => a.cwd && { id: `cwd:${a.cwd}`, label: a.cwd.split('/').pop(), title: `Agents in ${a.cwd}` },
    a => a.where?.mux && { id: `mux:${a.where.mux}`, label: `in ${muxLabel(a.where.mux)}`, title: `Running in ${muxLabel(a.where.mux)}` },
    a => a.where?.app && { id: `app:${a.where.app}`, label: `in ${a.where.app}`, title: `Running in ${a.where.app}` },
    a => !canJump(a) && !a.where?.background && { id: 'loose', label: 'no terminal', title: 'Not in any terminal: often leftovers' },
  ];

  function rowHTML(a, i) {
    const menu = [
      canJump(a) && `<button onclick="DevDockViews.coding.jump('${a.pid}')">${ICON.jump}Jump to it</button>`,
      a.where?.mux && `<button onclick="DevDockViews.coding.openHere('${a.pid}')">${ICON.term}Open here</button>`,
      a.cwd && `<button onclick="openEditor(this.dataset.path)" data-path="${esc(a.cwd)}">${ICON.code}Open in ${esc(editorName())}</button>`,
      a.sessionId && `<button onclick="copyText(this.dataset.v, 'Resume command')" data-v="${esc(`cd ${a.cwd} && claude --resume ${a.sessionId}`)}">${ICON.copy}Copy resume command</button>`,
      '<div class="actions-divider"></div>',
      `<button class="danger" onclick="DevDockViews.coding.stop('${a.pid}', false)">${ICON.stop}Stop</button>`,
      `<button class="danger" onclick="DevDockViews.coding.stop('${a.pid}', true)">${ICON.force}Force stop</button>`,
    ].filter(Boolean).join('');
    return `<tr data-key="g:${a.pid}">
      <td class="col-name"><span class="path-cell">${agentHTML(a.agent, a.agent)}${canJump(a)
        ? `<button class="link-btn trunc" onclick="DevDockViews.coding.jump('${a.pid}')" title="Jump to it">${esc(a.name)}</button>`
        : `<span class="trunc">${esc(a.name)}</span>`}</span></td>
      <td>${a.state ? agentStateHTML(a.state) : `<span class="code" title="${esc(a.agent)} doesn't report what it's doing">—</span>`}</td>
      <td class="col-path"><span class="path-cell">${a.cwd
        ? `<span class="path-link trunc" data-path="${esc(a.cwd)}" onclick="copyText(this.dataset.path, 'Path')" title="${esc(a.cwd)}\nClick to copy">‎${esc(tildify(a.cwd))}‎</span>` : '<span class="code">—</span>'}${a.branch ? `<span class="branch trunc" title="git branch: ${esc(a.branch)}">⎇ ${esc(a.branch)}</span>` : ''}</span></td>
      <td><span class="path-cell">${whereHTML(a)}</span></td>
      <td>${a.ports.map(p => `<a href="http://localhost:${p}" target="_blank" class="code port-link">${p}</a>`).join(' ') || '<span class="code">—</span>'}</td>
      <td class="code col-user" title="${a.processes} process${a.processes > 1 ? 'es' : ''} incl. what it started">${formatMem(a.memMB)}</td>
      <td class="col-user">${a.startedAt ? `<span title="${new Date(a.startedAt).toLocaleString()}">${timeAgo(a.startedAt)}</span>` : '—'}</td>
      <td class="actions-cell" style="text-align:right;"><button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('cod-${i}',this)">⋯</button><div class="actions-menu" id="menu-cod-${i}">${menu}</div></td>
    </tr>`;
  }

  // Plan limits (sources/limits.js): one card per tool, a meter per window
  function limitsHTML() {
    const tools = DevDock.sourceData.limits?.tools || [];
    if (!tools.length) return '';
    const left = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`; };
    return `<div class="plimits">${tools.map(t => `<section class="plimit">
      <header>${agentHTML(t.tool, t.tool)}<b>${esc(t.tool)}</b>${t.plan ? `<span class="chip">${esc(t.plan)}</span>` : ''}${t.stale ? '<em title="From Codex\'s last session: it updates when Codex runs">last seen</em>' : ''}</header>
      ${t.error && !t.limits.length ? `<p class="plimit-err">${esc(t.error)}</p>` : t.limits.map(l => {
        const used = Math.min(100, l.used), lvl = used >= 95 ? 'bad' : used >= 80 ? 'warn' : '';
        return `<div class="plimit-row ${lvl}" title="${Math.round(used)}% used${l.resetsAt ? ', resets ' + esc(new Date(l.resetsAt).toLocaleString()) : ''}">
          <span>${esc(l.label)}</span><span class="hbar"><i style="width:${used.toFixed(1)}%"></i></span>
          <em>${Math.round(100 - used)}% left${l.resetsAt ? ` · ${left(l.resetsAt - Date.now())}` : ''}</em></div>`;
      }).join('')}</section>`).join('')}</div>`;
  }

  function render() {
    const d = data();
    const q = searchInput.value.trim().toLowerCase();
    const count = k => d.agents.filter(a => a.state?.status === k).length;
    document.getElementById('viewStats').innerHTML = `
      <div class="stat"><span class="stat-value">${d.agents.length}</span><span class="stat-label">agents</span></div>
      ${count('working') ? `<div class="stat stat-working"><span class="stat-value">${count('working')}</span><span class="stat-label">working</span></div>` : ''}
      ${count('needs-you') ? `<div class="stat stat-needs-you"><span class="stat-value">${count('needs-you')}</span><span class="stat-label">need you</span></div>` : ''}`;
    document.getElementById('viewTools').innerHTML = '';
    const f = FILTERS.some(([k]) => k === filter) ? filter : 'all';
    const base = d.agents.filter(a => f === 'all' || a.state?.status === f);
    const patterns = DevDockPatterns.find('coding', base, a => `g:${a.pid}`, PATTERNS);
    const list = DevDockPatterns.filter('coding', base.filter(a => hit(q, a)), a => `g:${a.pid}`).sort(sorter());
    setViewResult(list.length, base.length);
    view.innerHTML = limitsHTML() + `
      <div class="subbar">
        <div class="subtabs" role="tablist">${FILTERS.map(([k, label], i) => `<button role="tab" aria-selected="${k === f}" aria-label="${label}" title="${label}${k === 'all' ? ` \u00B7 ${d.agents.length}` : ` \u00B7 ${count(k)}`}  \u2325${i + 1}" onclick="DevDockViews.coding.setFilter('${k}')">${k === 'all' ? STATE_ALL : STATE_ICON[k]}</button>`).join('')}</div>
        ${patterns.length ? `<div class="patterns">${DevDockPatterns.html('coding', patterns)}</div>` : ''}
      </div>
      ${list.length ? `<div class="scroll"><table class="coding-table">
        <thead><tr>${th('Agent', 'name')}${th('State', 'state')}${th('Folder', 'folder')}${th('Where', 'where')}${th('Ports', 'ports', '', true)}${th('Memory', 'mem', 'col-user', true)}${th('Started', 'started', 'col-user', true)}<th></th></tr></thead>
        <tbody>${list.map(rowHTML).join('')}</tbody>
      </table></div>` : `<div class="empty-view">${DevDock.sourceData.coding ? (q || f !== 'all' ? 'No agents match.' : 'No coding agents running.') : 'Looking for agents…'}</div>`}`;
  }

  const byPid = pid => data().agents.find(a => a.pid === pid);

  function jump(pid) {
    closeAllMenus();
    const a = byPid(pid);
    if (!a) return;
    const w = a.where || {};
    sourceAction('coding', 'focus', { pid }).then(r => r?.here && openHere(pid));
  }
  // a multiplexer pane, opened in DevDock's own terminal
  function openHere(pid) {
    closeAllMenus();
    const w = byPid(String(pid))?.where;
    if (w?.mux) openSession({ mux: w.mux, id: w.id, target: w.target }, `${muxLabel(w.mux)} · ${w.name}`);
  }

  async function stopMany(list, force) {
    const what = list.length === 1 ? `${list[0].agent} "${list[0].name}"` : `${list.length} agents`;
    const busy = list.filter(a => a.state?.status === 'working').length;
    if (!await confirmDialog(`${force ? 'Force stop' : 'Stop'} ${what}?`, (busy ? `${busy} of them ${busy > 1 ? 'are' : 'is'} working right now. ` : '') + 'Claude Code sessions can be resumed later with claude --resume.', force ? 'Force stop' : 'Stop')) return false;
    let n = 0;
    for (const a of list) if (await sourceAction('coding', 'stop', { pid: a.pid, force })) n++;
    showToast(`Stopped ${n} agent${n === 1 ? '' : 's'}`);
    return true;
  }

  DevDockViews.coding = {
    render, jump, openHere,
    canJump: pid => { const a = byPid(String(pid)) || byPid(+pid); return !!a && canJump(a); },
    sort(k, num) {
      sort = k === 'state' ? null : { k, dir: sort?.k === k ? -sort.dir : num ? -1 : 1 };
      try { localStorage.setItem('devdock:coding-sort', JSON.stringify(sort)); } catch {}
      render();
    },
    setFilter(k) { filter = k; try { localStorage.setItem('devdock:coding-filter', k); } catch {} render(); },
    stop(pid, force) { closeAllMenus(); const a = byPid(pid); if (a) stopMany([a], force); },
    // selection (js/selection.js)
    pick(key) {
      const a = byPid(key.slice(2));
      return a && { kind: 'agent', name: `${a.agent} ${a.name}`, ref: a.where?.mux === 'tmux' ? a.where.id : '', mux: a.where?.mux, cwd: a.cwd, raw: a, facts: {
        agent: a.agent, pid: a.pid, state: a.state ? `${a.state.status}${a.state.since ? ' since ' + timeAgo(a.state.since) : ''}` : 'unknown',
        folder: a.cwd, 'git branch': a.branch, where: whereText(a), ports: a.ports.join(', '),
        memory: formatMem(a.memMB), processes: a.processes, started: a.startedAt ? timeAgo(a.startedAt) : '', 'claude session id': a.sessionId,
      } };
    },
    bulk(items) {
      return [{ label: `Stop ${items.length}`, danger: true, run: () => stopMany(items.map(i => i.raw), false) }];
    },
  };
})();

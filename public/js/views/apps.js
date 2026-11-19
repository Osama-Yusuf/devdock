// Apps tab: every running Mac app, menu bar app and background agent, from sources/apps.js.
// A row opens to show what it is and every process it's responsible for, each killable.
(function () {
  const view = document.getElementById('appsView');
  const svg = (d, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    quit: svg('<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
    force: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    restart: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>'),
    show: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
    finder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    chev: svg('<polyline points="9 6 15 12 9 18"/>', 12),
  };
  const ks = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const KIND_SVG = {
    all: ks('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    app: ks('<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M7 21h10"/>'),
    menu: ks('<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 8h20"/><path d="M16 5.5h2"/>'),
    background: ks('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    system: ks('<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/>'),
  };
  const FILTERS = [['all', 'All', 'Your apps, menu bar apps and background agents'], ['app', 'Apps', 'Apps with a Dock icon'], ['menu', 'Menu bar', 'Menu bar apps and agents without a Dock icon'], ['background', 'Background', 'Background-only processes macOS tracks as apps'], ['system', 'System', "macOS's own"]];
  const KIND_LABEL = { app: 'app', menu: 'menu bar', background: 'background' };
  let state = { filter: 'all', sort: 'mem', allPids: false };
  try { state = { ...state, ...JSON.parse(localStorage.getItem('devdock:apps')) }; } catch {}
  const save = () => { try { localStorage.setItem('devdock:apps', JSON.stringify(state)); } catch {} };
  const open = new Set(); // pids of expanded rows
  const noIcon = new Set();

  const data = () => DevDock.sourceData.apps || { apps: [] };
  const hit = (q, a) => !q || q.split(/\s+/).every(w => [a.name, a.bundleId, a.path, KIND_LABEL[a.kind], ...a.processes.map(p => p.name + ' ' + p.pid), ...a.ports].join(' ').toLowerCase().includes(w));
  const inFilter = (a, f) => f === 'system' ? a.system : !a.system && (f === 'all' || a.kind === f);
  const vendor = id => id?.split('.').slice(0, 2).join('.');
  const SORTS = { mem: (a, b) => b.memMB - a.memMB, cpu: (a, b) => b.cpu - a.cpu, name: (a, b) => a.name.localeCompare(b.name) };

  // Pattern chips (DevDockPatterns in js/selection.js)
  const PATTERNS = [
    a => a.kind === 'background' && { id: `name:${a.name}`, label: a.name.length > 28 ? a.name.slice(0, 27) + '…' : a.name, title: `Background processes named ${a.name}` },
    a => a.bundleId && !a.bundleId.startsWith('com.apple.') && { id: `vendor:${vendor(a.bundleId)}`, label: vendor(a.bundleId), title: `Apps from ${vendor(a.bundleId)}` },
    a => a.electron && { id: 'electron', label: 'Electron', title: 'Apps built on Electron (each ships its own Chromium)' },
    a => a.memMB >= 1024 && { id: 'big', label: 'over 1 GB', title: 'Using more than 1 GB of memory' },
    a => a.ports.length && { id: 'ports', label: 'listening', title: 'Listening on a port' },
  ];

  function iconHTML(a) {
    return a.hasIcon && !noIcon.has(a.pid)
      ? `<img class="app-icon" src="/api/app-icon/${a.pid}" alt="" onerror="DevDockViews.apps.noIcon('${a.pid}')">`
      : `<span class="app-icon app-letter">${esc(a.name.replace(/^npm exec /, '')[0] || '?')}</span>`;
  }

  const btn = (act, pid, icon, text, cls = '') => `<button class="${cls}" onclick="DevDockViews.apps.act('${act}', '${pid}')">${icon}${text}</button>`;

  function rowHTML(a) {
    const isOpen = open.has(a.pid) || state.allPids;
    const menu = [
      a.kind !== 'background' && btn('show', a.pid, ICON.show, 'Show'),
      a.path?.endsWith('.app') && btn('reveal', a.pid, ICON.finder, 'Show in Finder'),
      a.bundleId && `<button onclick="copyText(this.dataset.v, 'Bundle ID')" data-v="${esc(a.bundleId)}">${ICON.copy}Copy bundle ID</button>`,
      a.bundleId && btn('restart', a.pid, ICON.restart, 'Restart'),
      '<div class="actions-divider"></div>',
      btn('quit', a.pid, ICON.quit, 'Quit', 'danger'),
      btn('forceQuit', a.pid, ICON.force, 'Force quit', 'danger'),
    ].filter(Boolean).join('');
    const extra = a.processes.length - 1;
    return `<tr data-key="a:${a.pid}" class="${isOpen ? 'is-open' : ''}">
      <td class="col-name"><span class="path-cell">
        <button class="app-twisty" onclick="DevDockViews.apps.toggle('${a.pid}')" title="${isOpen ? 'Hide' : 'Show'} details and processes">${ICON.chev}</button>
        ${iconHTML(a)}<span class="trunc" title="${esc(a.path || a.name)}">${esc(a.name)}</span>
        ${a.front ? '<span class="chip chip-live" title="The app in front">front</span>' : ''}
        ${a.kind !== 'app' ? `<span class="chip" title="${a.kind === 'menu' ? 'No Dock icon: lives in the menu bar or runs as an agent' : 'Background only'}">${KIND_LABEL[a.kind]}</span>` : ''}
        ${a.electron ? '<span class="chip chip-agent" title="Built on Electron">Electron</span>' : ''}
      </span></td>
      <td class="code col-user">${esc(a.version || '—')}</td>
      <td><button class="link-btn code" onclick="DevDockViews.apps.toggle('${a.pid}')" title="${a.processes.filter(p => p.own).length} of its own${extra ? `, ${a.processes.filter(p => !p.own).length} it started` : ''}">${a.processes.length}</button></td>
      <td>${a.ports.map(p => `<a href="http://localhost:${p}" target="_blank" class="code port-link">${p}</a>`).join(' ') || '<span class="code">—</span>'}</td>
      <td class="code ${a.cpu >= 30 ? 'hot' : ''}">${a.cpu.toFixed(1)}%</td>
      <td class="code ${a.memMB >= 1024 ? 'hot' : ''}">${formatMem(a.memMB)}</td>
      <td class="col-user">${a.launchedAt ? `<span title="${new Date(a.launchedAt).toLocaleString()}">${timeAgo(a.launchedAt)}</span>` : '<span class="code">—</span>'}</td>
      <td class="actions-cell" style="text-align:right;"><button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('app-${a.pid}',this)">⋯</button><div class="actions-menu" id="menu-app-${a.pid}">${menu}</div></td>
    </tr>${isOpen ? detailHTML(a) : ''}`;
  }

  function detailHTML(a) {
    const facts = [
      ['Bundle ID', a.bundleId], ['Path', a.path], ['Version', a.version], ['Main PID', a.pid],
      ['Architecture', a.arch === 'ARM64' ? 'Apple silicon' : a.arch === 'x86_64' ? 'Intel (Rosetta)' : a.arch],
      ['Launched', a.launchedAt && new Date(a.launchedAt).toLocaleString()],
    ].filter(([, v]) => v);
    return `<tr class="app-detail group-row"><td colspan="8">
      <div class="app-facts">${facts.map(([k, v]) => `<div><span>${k}</span><code title="Click to copy" onclick="copyText(this.textContent, '${k}')">${esc(v)}</code></div>`).join('')}</div>
      <table class="app-procs"><thead><tr><th>PID</th><th>Process</th><th>CPU</th><th>Memory</th><th>Started</th><th></th></tr></thead><tbody>
      ${a.processes.map(p => `<tr class="${p.own ? '' : 'not-own'}">
        <td class="code">${p.pid}</td>
        <td><span class="trunc">${esc(p.name)}</span>${p.pid === a.pid ? '<span class="chip">main</span>' : p.own ? '' : '<span class="chip" title="Not part of the app: something it started, like a terminal\'s shell">started by it</span>'}</td>
        <td class="code">${p.cpu.toFixed(1)}%</td><td class="code">${formatMem(p.memMB)}</td>
        <td>${p.startedAt ? timeAgo(p.startedAt) : '—'}</td>
        <td class="app-proc-acts"><button onclick="DevDockViews.apps.killPid('${p.pid}', false)" title="SIGTERM: ask it to stop">Kill</button><button class="danger" onclick="DevDockViews.apps.killPid('${p.pid}', true)" title="SIGKILL: stop it now">Force</button></td>
      </tr>`).join('')}
      </tbody></table>
    </td></tr>`;
  }

  function render() {
    const d = data();
    const q = searchInput.value.trim().toLowerCase();
    const mine = d.apps.filter(a => !a.system);
    document.getElementById('viewStats').innerHTML = `
      <div class="stat"><span class="stat-value">${mine.filter(a => a.kind === 'app').length}</span><span class="stat-label">apps</span></div>
      <div class="stat"><span class="stat-value">${mine.filter(a => a.kind === 'menu').length}</span><span class="stat-label">menu bar</span></div>
      <div class="stat"><span class="stat-value">${formatMem(mine.reduce((n, a) => n + a.memMB, 0))}</span><span class="stat-label">memory</span></div>`;
    document.getElementById('viewTools').innerHTML = '';
    const f = FILTERS.some(([k]) => k === state.filter) ? state.filter : 'all';
    const base = d.apps.filter(a => inFilter(a, f));
    const patterns = DevDockPatterns.find('apps', base, a => `a:${a.pid}`, PATTERNS);
    const list = DevDockPatterns.filter('apps', base.filter(a => hit(q, a)), a => `a:${a.pid}`).sort(SORTS[state.sort] || SORTS.mem);
    setViewResult(list.length, base.length);
    const th = (k, label, cls = '') => `<th class="${cls} sortable ${state.sort === k ? 'sorted' : ''}" onclick="DevDockViews.apps.sort('${k}')">${label}</th>`;
    view.innerHTML = `
      <div class="subbar">
        <div class="subtabs" role="tablist">${FILTERS.map(([k, label, tip], i) => `<button role="tab" aria-selected="${k === f}" aria-label="${label}" title="${label} \u00B7 ${tip}  \u2325${i + 1}" onclick="DevDockViews.apps.setFilter('${k}')">${KIND_SVG[k]}</button>`).join('')}</div>
        ${patterns.length ? `<div class="patterns">${DevDockPatterns.html('apps', patterns)}</div>` : ''}
        <button class="pattern subbar-action ${state.allPids ? 'active' : ''}" onclick="DevDockViews.apps.allPids()" title="Open every row to its processes">${state.allPids ? 'Hide' : 'Show'} all PIDs</button>
      </div>
      ${list.length ? `<div class="scroll"><table class="apps-table">
        <thead><tr>${th('name', 'Name')}<th class="col-user">Version</th><th>PIDs</th><th>Ports</th>${th('cpu', 'CPU')}${th('mem', 'Memory')}<th class="col-user">Launched</th><th></th></tr></thead>
        <tbody>${list.map(rowHTML).join('')}</tbody>
      </table></div>` : `<div class="empty-view">${DevDock.sourceData.apps ? 'No apps match.' : 'Looking for apps…'}</div>`}`;
  }

  const byPid = pid => data().apps.find(a => a.pid === pid);

  async function act(action, pid) {
    closeAllMenus();
    const a = byPid(pid);
    if (!a) return;
    const ASK = {
      quit: [`Quit ${a.name}?`, 'It can ask to save first, like quitting from the Dock.', 'Quit'],
      forceQuit: [`Force quit ${a.name}?`, `Stops ${a.processes.filter(p => p.own).length} process${a.processes.filter(p => p.own).length > 1 ? 'es' : ''} right away. Anything unsaved is lost.`, 'Force quit'],
      restart: [`Restart ${a.name}?`, 'Quits it, then opens it again.', 'Restart'],
    };
    if (ASK[action] && !await confirmDialog(...ASK[action])) return;
    if (await sourceAction('apps', action, { pid }) && ASK[action]) showToast(`${{ quit: 'Quit', forceQuit: 'Force quit', restart: 'Restarted' }[action]} ${a.name}`);
  }

  async function killPid(pid, force) {
    const a = data().apps.find(x => x.processes.some(p => p.pid === pid));
    const p = a?.processes.find(x => x.pid === pid);
    if (!p) return;
    if (!await confirmDialog(`${force ? 'Force kill' : 'Kill'} ${p.name} (${pid})?`, pid === a.pid ? `It's ${a.name}'s main process: the app goes with it.` : `Part of ${a.name}.`, force ? 'Force kill' : 'Kill')) return;
    if (await sourceAction('apps', 'kill', { pid, force })) showToast(`${force ? 'Force killed' : 'Killed'} ${p.name}`);
  }

  async function quitMany(items, force) {
    if (!await confirmDialog(`${force ? 'Force quit' : 'Quit'} ${items.length} app${items.length > 1 ? 's' : ''}?`, items.map(i => i.name).join(', ') + (force ? '\nAnything unsaved is lost.' : ''), force ? 'Force quit' : 'Quit')) return false;
    let n = 0;
    for (const i of items) if (await sourceAction('apps', force ? 'forceQuit' : 'quit', { pid: i.raw.pid })) n++;
    showToast(`${force ? 'Force quit' : 'Quit'} ${n} app${n === 1 ? '' : 's'}`);
    return true;
  }

  DevDockViews.apps = {
    render, act, killPid,
    toggle(pid) { open.has(pid) ? open.delete(pid) : open.add(pid); render(); },
    allPids() { state.allPids = !state.allPids; open.clear(); save(); render(); },
    setFilter(f) { state.filter = f; save(); render(); },
    sort(k) { state.sort = k; save(); render(); },
    noIcon(pid) { if (!noIcon.has(pid)) { noIcon.add(pid); render(); } },
    // selection (js/selection.js)
    pick(key) {
      const a = byPid(key.slice(2));
      return a && { kind: 'app', name: a.name, ref: a.pid, raw: a, facts: {
        'bundle id': a.bundleId, path: a.path, version: a.version, kind: KIND_LABEL[a.kind], pid: a.pid,
        cpu: `${a.cpu.toFixed(1)}%`, memory: formatMem(a.memMB), processes: a.processes.length,
        'its processes': a.processes.slice(0, 12).map(p => `${p.pid} ${p.name} ${p.cpu.toFixed(1)}% ${formatMem(p.memMB)}`).join('; '),
        ports: a.ports.join(', '), launched: a.launchedAt ? timeAgo(a.launchedAt) : '', electron: a.electron ? 'yes' : '',
      } };
    },
    bulk(items) {
      return [
        { label: `Quit ${items.length}`, run: () => quitMany(items, false) },
        { label: 'Force quit', danger: true, run: () => quitMany(items, true) },
      ];
    },
  };
})();

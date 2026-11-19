// Containers tab: Docker containers, images, volumes and build cache, with cleanup.
// Nothing in use is ever removed: Docker refuses it, and the prunes only take unused items.
// Volumes hold data, so they are never part of "everything unused".
(function () {
  const view = document.getElementById('containersView');
  const svg = (d, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
    stop: svg('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    broom: svg('<path d="M19 3 9.5 12.5"/><path d="M9.5 12.5 4 18l2 2 5.5-5.5"/><path d="M7.5 14.5 3 21"/><path d="m14 8 2 2"/>', 15),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    chevron: svg('<polyline points="6 9 12 15 18 9"/>', 12),
  };

  // Sub-tabs and their filters; the choice survives refresh (per-window, so localStorage)
  const TABS = {
    containers: { label: 'Containers', icon: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M6 7V4h12v3"/><line x1="7" y1="11" x2="7" y2="16"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="17" y1="11" x2="17" y2="16"/>', filters: [['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped'], ['k8s', 'Kubernetes']] },
    images: { label: 'Images', icon: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>', filters: [['all', 'All'], ['used', 'In use'], ['unused', 'Unused'], ['dangling', 'Dangling']] },
    volumes: { label: 'Volumes', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>', filters: [['all', 'All'], ['used', 'In use'], ['unused', 'Unused']] },
    build: { label: 'Build cache', icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>', filters: [] },
  };
  let state = { tab: 'containers', filter: {} };
  try { state = { ...state, ...JSON.parse(localStorage.getItem('devdock:containers')) }; } catch {}
  const save = () => { try { localStorage.setItem('devdock:containers', JSON.stringify(state)); } catch {} };
  let cleanupOpen = false;

  // The common `docker … prune` commands, in the order people reach for them
  const CLEANUPS = [
    { kinds: ['containers'], label: 'Stopped containers', cli: 'docker container prune' },
    { kinds: ['dangling'], label: 'Dangling images', cli: 'docker image prune' },
    { kinds: ['images'], label: 'Unused images', cli: 'docker image prune -a' },
    { kinds: ['build'], label: 'Build cache', cli: 'docker builder prune -a' },
    { kinds: ['containers', 'images', 'build'], label: 'Everything unused', cli: 'docker system prune -a', strong: true },
    { kinds: ['volumes'], label: 'Unused volumes', cli: 'docker volume prune -a', danger: true },
  ];
  // The one purge that fits the sub-tab you're looking at
  const CONTEXT = { containers: 0, images: 2, volumes: 5, build: 3 };

  function bytes(n) {
    if (n == null || n < 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; } // decimal units, like Docker
    return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }
  const short = id => id.replace(/^sha256:/, '').slice(0, 12);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const when = (running, ts) => running ? '<span class="chip chip-live">running</span>'
    : ts ? `<span title="${new Date(ts).toLocaleString()}">${timeAgo(ts)}</span>` : '<span class="code" title="Never ran">never</span>';
  const used = n => n ? `<span class="chip chip-agent" title="${plural(n, 'container')} use it">${n} using</span>` : '<span class="chip chip-orphan">unused</span>';
  const hit = (q, ...fields) => !q || q.split(/\s+/).every(w => fields.join(' ').toLowerCase().includes(w));
  const total = (kinds, r) => kinds.reduce((a, k) => ({ count: a.count + r[k].count, size: a.size + r[k].size }), { count: 0, size: 0 });
 const k8sStopped = () => DevDock.sourceData.containers.containers.filter(c => c.k8s && stopped(c)).length;
  const stopped = c => !['running', 'paused', 'restarting'].includes(c.state);

  function menu(id, items) {
    items = items.filter(Boolean).join('');
    return items ? `<button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('${id}',this)">⋯</button><div class="actions-menu" id="menu-${id}">${items}</div>` : '';
  }
  const item = (action, value, icon, text, cls = '') =>
    `<button class="${cls}" onclick="DevDockViews.containers.act('${action}', this.dataset.v)" data-v="${esc(value)}">${icon}${text}</button>`;
  const table = (cls, head, rows, none) => rows.length
    ? `<div class="scroll"><table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="empty-view">${none}</div>`;

  // ── rows per sub-tab ───────────────────────────────────────────────
  const LISTS = {
    // a pod's pause container only holds its network; it's noise next to the real ones
    containers: (d, f, q) => d.containers
      .filter(c => !c.k8s?.sandbox)
      .filter(c => f === 'all' || (f === 'k8s' ? c.k8s : f === 'running' ? !stopped(c) : stopped(c)))
      .filter(c => hit(q, c.name, c.image, c.project, c.state, c.ports.join(' '), c.k8s ? `k8s kubernetes ${c.k8s.pod} ${c.k8s.namespace}` : ''))
      .sort((a, b) => stopped(a) - stopped(b) || (b.lastUsed || 0) - (a.lastUsed || 0)),
    images: (d, f, q) => d.images
      .filter(i => f === 'all' || (f === 'used' ? i.containers : f === 'unused' ? !i.containers : !i.containers && !i.tags.length))
      .filter(i => hit(q, i.tags.join(' '), short(i.id)))
      .sort((a, b) => b.size - a.size),
    volumes: (d, f, q) => d.volumes
      .filter(v => f === 'all' || (f === 'used' ? v.containers : !v.containers))
      .filter(v => hit(q, v.name, v.project))
      .sort((a, b) => b.size - a.size),
  };

  const BODIES = {
    containers: (list, k8sCtx) => table('ctr-table', '<th>Name</th><th>Image</th><th>Ports</th><th class="col-user">Last ran</th><th class="col-user">Disk</th><th></th>',
      list.map((c, i) => `<tr>
        <td class="col-name"><span class="path-cell">${c.k8s
          ? `<span class="trunc" title="Pod ${esc(c.k8s.pod)}\nContainer ${esc(c.k8s.container)}\n${esc(c.status)}">${esc(c.k8s.pod)}</span><span class="chip chip-k8s" title="Kubernetes namespace ${esc(c.k8s.namespace)}">k8s \u00B7 ${esc(c.k8s.namespace)}</span>`
          : `<span class="trunc" title="${esc(c.status)}">${esc(c.name)}</span>`}${c.project ? `<span class="chip" title="Compose project">${esc(c.project)}</span>` : ''}</span></td>
        <td><span class="code trunc" title="${esc(c.image)}">${esc(c.image.startsWith('sha256:') ? short(c.image) : c.image)}</span></td>
        <td>${c.ports.map(p => `<a href="http://localhost:${p}" target="_blank" class="code port-link">${p}</a>`).join(' ') || '<span class="code">—</span>'}</td>
        <td class="col-user">${stopped(c) ? `<span title="${esc(c.status)}">${when(false, c.lastUsed)}</span>` : when(true)}</td>
        <td class="col-user code">${bytes(c.size)}</td>
        <td class="actions-cell" style="text-align:right;">${menu(`ctr-${i}`, [
          // Kubernetes owns its containers: hand over the kubectl command instead
          c.k8s ? k8sCtx && `<button onclick="copyText(this.dataset.cmd, 'kubectl command')" data-cmd="${esc(`kubectl --context ${k8sCtx} -n ${c.k8s.namespace} logs ${c.k8s.pod} -c ${c.k8s.container}`)}">${ICON.copy}Copy kubectl logs command</button>`
            : stopped(c) ? item('start', c.id, ICON.play, 'Start') : item('stop', c.id, ICON.stop, 'Stop'),
          !c.k8s && stopped(c) && `<div class="actions-divider"></div>${item('removeContainer', c.id, ICON.trash, 'Remove', 'danger')}`,
        ])}</td></tr>`), 'No containers here.'),
    images: list => table('img-table', '<th>Tag</th><th>Used by</th><th class="col-user">Last used</th><th class="col-user">Created</th><th class="col-user">Size</th><th></th>',
      list.map((im, i) => `<tr>
        <td class="col-name"><span class="path-cell"><span class="trunc" title="${esc(im.id)}">${esc(im.tags[0] || `<none> ${short(im.id)}`)}</span>${im.tags.length > 1 ? `<span class="chip" title="${esc(im.tags.join('\n'))}">+${im.tags.length - 1}</span>` : ''}${!im.tags.length ? '<span class="chip" title="Untagged, usually left over from an old build">dangling</span>' : ''}</span></td>
        <td>${used(im.containers)}</td>
        <td class="col-user">${when(im.running, im.lastUsed)}</td>
        <td class="col-user"><span title="${new Date(im.createdAt).toLocaleString()}">${timeAgo(im.createdAt)}</span></td>
        <td class="col-user code" title="${bytes(im.unique)} not shared with other images">${bytes(im.size)}</td>
        <td class="actions-cell" style="text-align:right;">${menu(`img-${i}`, [!im.containers && item('removeImage', im.id, ICON.trash, 'Remove', 'danger')])}</td></tr>`), 'No images here.'),
    volumes: list => table('img-table', '<th>Name</th><th>Used by</th><th class="col-user">Last used</th><th class="col-user">Created</th><th class="col-user">Size</th><th></th>',
      list.map((v, i) => `<tr>
        <td class="col-name"><span class="path-cell"><span class="trunc code" title="${esc(v.name)}">${esc(v.anonymous ? short(v.name) : v.name)}</span>${v.anonymous ? '<span class="chip" title="Created by a container, no name given">anonymous</span>' : ''}${v.project ? `<span class="chip" title="Compose project">${esc(v.project)}</span>` : ''}</span></td>
        <td>${used(v.containers)}</td>
        <td class="col-user">${when(v.running, v.lastUsed)}</td>
        <td class="col-user">${v.createdAt ? timeAgo(v.createdAt) : '—'}</td>
        <td class="col-user code">${bytes(v.size)}</td>
        <td class="actions-cell" style="text-align:right;">${menu(`vol-${i}`, [!v.containers && item('removeVolume', v.name, ICON.trash, 'Remove', 'danger')])}</td></tr>`), 'No volumes here.'),
    build: d => `<div class="cache-card">
        <div><span class="stat-value">${bytes(d.buildCache.size)}</span> <span class="stat-label">in ${plural(d.buildCache.count, 'entry', 'entries')}</span></div>
        <div class="stat-label">${bytes(d.buildCache.reclaimable)} not in use${d.buildCache.lastUsed ? ` · last used ${timeAgo(d.buildCache.lastUsed)}` : ''}</div>
        <div class="stat-label">Layers <span class="code">docker build</span> keeps to make the next build faster. Safe to clear; the next build is just slower.</div>
      </div>`,
  };

  function cleanupMenuHTML(r) {
    return `<div class="cleanup-wrapper">
      <button class="cleanup-btn ${cleanupOpen ? 'open' : ''}" onclick="event.stopPropagation();DevDockViews.containers.toggleCleanup()" aria-haspopup="menu" aria-expanded="${cleanupOpen}">${ICON.broom}Clean up${ICON.chevron}</button>
      <div class="export-menu cleanup-menu ${cleanupOpen ? 'open' : ''}" role="menu">
        ${CLEANUPS.map((c, i) => {
          const t = total(c.kinds, r);
          return `${c.strong || c.danger ? '<div class="actions-divider"></div>' : ''}<button role="menuitem" class="${c.danger ? 'danger' : ''} ${c.strong ? 'strong' : ''}" ${t.count ? '' : 'disabled'} onclick="DevDockViews.containers.prune(${i})">
            <span class="cleanup-text"><span>${c.label}</span><span class="cleanup-cli">${c.cli}</span></span>
            <span class="cleanup-size">${t.count ? bytes(t.size) : 'none'}</span>
          </button>`;
        }).join('')}
        <div class="cleanup-note">Anything in use stays. Volumes are never part of "everything unused".</div>
      </div>
    </div>`;
  }

  function render() {
    const d = DevDock.sourceData.containers;
    const stats = document.getElementById('viewStats'), tools = document.getElementById('viewTools');
    if (!d?.available) {
      stats.innerHTML = tools.innerHTML = '';
      view.innerHTML = `<div class="empty-view">${esc(d ? d.reason : 'Looking for Docker…')}</div>`;
      return;
    }
    const r = d.reclaimable;
    stats.innerHTML = `
      <div class="stat"><span class="stat-value">${d.containers.filter(c => !stopped(c)).length}/${d.containers.length}</span><span class="stat-label">running</span></div>
      <div class="stat"><span class="stat-value">${bytes(total(['containers', 'images', 'build', 'volumes'], r).size)}</span><span class="stat-label">reclaimable</span></div>`;
    tools.innerHTML = cleanupMenuHTML(r);

    const tab = TABS[state.tab] ? state.tab : 'containers';
    const filters = TABS[tab].filters;
    const f = filters.some(([k]) => k === state.filter[tab]) ? state.filter[tab] : 'all';
    const q = searchInput.value.trim().toLowerCase();
    const meta = {
      containers: `${d.containers.length} · ${bytes(d.containers.reduce((n, c) => n + c.size, 0))}`,
      images: `${d.images.length} · ${bytes(d.images.reduce((n, i) => n + i.size, 0))}`,
      volumes: `${d.volumes.length} · ${bytes(d.volumes.reduce((n, v) => n + Math.max(0, v.size), 0))}`,
      build: bytes(d.buildCache.size),
    };
    const ctx = CLEANUPS[CONTEXT[tab]], ctxTotal = total(ctx.kinds, r);
    const list = LISTS[tab]?.(d, f, q);
    const all = { containers: d.containers.filter(c => !c.k8s?.sandbox), images: d.images, volumes: d.volumes }[tab];
    if (list) setViewResult(list.length, all.length);
    // Searching: act on the matches you could remove anyway, like Servers' "Kill N matching"
    const matching = q && list ? list.filter(REMOVABLE[tab]) : null;

    view.innerHTML = `
      <div class="subbar">
        <div class="subtabs" role="tablist">${Object.entries(TABS).map(([k, t], i) => `
        <button role="tab" aria-selected="${k === tab}" onclick="DevDockViews.containers.setTab('${k}')" aria-label="${t.label}" title="${t.label} \u00B7 ${meta[k]}  \u2325${i + 1}">${svg(t.icon, 16)}</button>`).join('')}
        </div>
        ${filters.length ? `<div class="seg">${filters.map(([k, label]) => `<button class="${k === f ? 'active' : ''}" onclick="DevDockViews.containers.setFilter('${k}')">${label}</button>`).join('')}</div>` : ''}
        ${list && !q && f !== 'all' ? `<span class="subbar-count">${list.length} of ${all.length}</span>` : ''}
        ${matching ? `<button class="kill-all-btn subbar-action" ${matching.length ? '' : 'disabled'} onclick="DevDockViews.containers.removeMatching()" title="Only items nothing uses">
          ${ICON.trash}${matching.length ? `Remove ${matching.length} matching` : 'Nothing matching to remove'}</button>` : `<button class="${ctx.danger ? 'orphan-btn' : 'kill-all-btn'} subbar-action" ${ctxTotal.count ? '' : 'disabled'} onclick="DevDockViews.containers.prune(${CONTEXT[tab]})" title="Same as: ${ctx.cli}">
          ${ICON.trash}${!ctxTotal.count ? `No ${ctx.label.toLowerCase()}`
            : tab === 'build' ? `Clear build cache · ${bytes(ctxTotal.size)}`
            : `Remove ${plural(ctxTotal.count, ctx.label.toLowerCase().replace(/s$/, ''), ctx.label.toLowerCase())} · ${bytes(ctxTotal.size)}`}
        </button>`}
      </div>
      ${tab === 'build' ? BODIES.build(d) : BODIES[tab](list, d.k8sContext)}`;
  }

  // What a single remove would accept: stopped plain containers, anything nothing uses
  const REMOVABLE = {
    containers: c => stopped(c) && !c.k8s,
    images: i => !i.containers,
    volumes: v => !v.containers,
  };
  const REMOVE = {
    containers: c => ['removeContainer', { id: c.id }, c.name],
    images: i => ['removeImage', { id: i.id }, i.tags[0] || short(i.id)],
    volumes: v => ['removeVolume', { name: v.name }, v.anonymous ? short(v.name) : v.name],
  };

  async function removeMatching() {
    const d = DevDock.sourceData.containers;
    const tab = state.tab, f = state.filter[tab] || 'all';
    const items = LISTS[tab](d, f, searchInput.value.trim().toLowerCase()).filter(REMOVABLE[tab]).map(REMOVE[tab]);
    if (!items.length) return;
    const kind = { containers: 'container', images: 'image', volumes: 'volume' }[tab];
    const ok = await confirmDialog(`Remove ${plural(items.length, kind)} matching "${searchInput.value.trim()}"?`,
      items.map(x => x[2]).join(', ') + (tab === 'volumes' ? '\nVolume data cannot be recovered.' : ''), 'Remove');
    if (!ok) return;
    let done = 0;
    for (const [action, params] of items) if (await sourceAction('containers', action, params)) done++;
    showToast(`Removed ${plural(done, kind)}`);
  }

  // Single-item actions; removals ask first and name exactly what goes
  async function act(action, value) {
    closeAllMenus();
    const d = DevDock.sourceData.containers;
    const params = action === 'removeVolume' ? { name: value } : { id: value };
    const name = action === 'removeVolume' ? value
      : action === 'removeImage' ? (d.images.find(i => i.id === value)?.tags[0] || short(value))
      : d.containers.find(c => c.id === value)?.name || short(value);
    if (action.startsWith('remove')) {
      const kind = { removeContainer: 'container', removeImage: 'image', removeVolume: 'volume' }[action];
      const detail = kind === 'volume' ? 'Its data is deleted for good.' : 'This cannot be undone.';
      if (!await confirmDialog(`Remove ${kind} ${name}?`, detail, 'Remove')) return;
    }
    if (await sourceAction('containers', action, params)) showToast(`${action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Removed'} ${name}`);
  }

  async function prune(i) {
    const c = CLEANUPS[i];
    const r = DevDock.sourceData.containers?.reclaimable;
    cleanupOpen = false;
    render();
    if (!c || !r) return;
    const t = total(c.kinds, r);
    if (!t.count) return;
    const parts = {
      containers: r.containers.count && plural(r.containers.count, 'stopped container')
        + (k8sStopped() ? ` (${k8sStopped()} are old Kubernetes restarts the cluster no longer needs)` : ''),
      dangling: r.dangling.count && plural(r.dangling.count, 'dangling image'),
      images: r.images.count && plural(r.images.count, 'unused image'),
      build: r.build.count && `build cache (${bytes(r.build.size)})`,
      volumes: r.volumes.count && `${plural(r.volumes.count, 'unused volume')} and their data`,
    };
    const ok = await confirmDialog(`Remove ${c.label.toLowerCase()}?`,
      `${c.kinds.map(k => parts[k]).filter(Boolean).join(', ')}. About ${bytes(t.size)}. Anything in use stays.${c.danger ? ' Volume data cannot be recovered.' : ''}\nSame as: ${c.cli}`, 'Remove');
    if (!ok) return;
    showToast('Cleaning up…', 'info', 'prune');
    const res = await sourceAction('containers', 'prune', { kinds: c.kinds });
    if (res) showToast(`Freed ${bytes(res.reclaimed)}`, 'success', 'prune');
  }

  function toggleCleanup(open = !cleanupOpen) { cleanupOpen = open; render(); }
  document.addEventListener('click', e => { if (cleanupOpen && !e.target.closest('.cleanup-wrapper')) toggleCleanup(false); });
  document.addEventListener('keydown', e => { if (cleanupOpen && e.key === 'Escape') toggleCleanup(false); });
  // ⌥1–⌥4 switch sub-tabs; e.code because ⌥1 types "¡" on a Mac keyboard
  document.addEventListener('keydown', e => {
    if (DevDock.tab !== 'containers' || !e.altKey || e.metaKey || e.ctrlKey) return;
    const t = Object.keys(TABS)[+(e.code.match(/^Digit([1-4])$/)?.[1]) - 1];
    if (t) { e.preventDefault(); DevDockViews.containers.setTab(t); }
  });

  DevDockViews.containers = {
    render, act, prune, toggleCleanup, removeMatching,
    setTab(t) { state.tab = t; save(); render(); },
    setFilter(f) { state.filter[state.tab] = f; save(); render(); },
  };
})();

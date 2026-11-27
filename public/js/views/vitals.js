// Home's CPU, Memory, Disk and Network panels: what's using each, grouped by dev server, coding
// agent or app (home source action "top"), refreshed every 2 s while open and Home is in view. Rows
// slide to their new rank instead of jumping, and hold still while the pointer is over the list.
// A period other than Live ranks by the average over it, from the usage history (action "usage").
(function () {
  const EVERY = 2000, EVERY_PAST = 30000, SHOWN = 10;
  const PERIODS = [['live', 'Live'], [5, '5 min'], [60, '1 hour'], [1440, '24 hours'], [10080, '7 days']];
  let period = 'live';
  try { period = JSON.parse(localStorage.getItem('devdock:vitals-period')) ?? 'live'; } catch {}
  const live = () => period === 'live';
  const rate = n => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1000 && i < 3) { n /= 1000; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}/s`; };
  const METRIC = {
    cpu: { label: 'CPU', of: g => g.cpu, show: v => `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`, color: 'var(--accent)' },
    mem: { label: 'Memory', of: g => g.mem, show: v => formatMem(v), color: 'var(--accent)' },
    disk: { label: 'Disk', of: g => g.diskR + g.diskW, show: v => rate(v), color: 'var(--yellow)', io: ['diskR', 'diskW', 'read', 'written'] },
    net: { label: 'Network', of: g => g.rx + g.tx, show: v => rate(v), color: 'var(--green)', io: ['rx', 'tx', 'received', 'sent'] },
  };
  const svg = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const GLYPH = {
    process: svg('<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/>'),
    system: svg('<path d="M12 3 4 7v6c0 4 3.5 7 8 8 4.5-1 8-4 8-8V7z"/>'),
    rest: svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
    chev: svg('<path d="m9 6 6 6-6 6"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  };

  let open = null, data = null, timer = null, inflight = false, hover = false, all = false;
  const expanded = new Set(), hist = {}, widths = {};
  let order = [];
  const el = document.createElement('section');
  el.className = 'hpanel';
  el.addEventListener('pointerenter', () => { hover = true; });
  el.addEventListener('pointerleave', () => { hover = false; });

  // a string for an inline handler: JSON quoting, then HTML escaping for the attribute
  const js = v => esc(JSON.stringify(String(v)));
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const homeShown = () => DevDock.tab === 'home' && !document.hidden;
  const value = g => METRIC[open].of(g);

  async function poll() {
    clearTimeout(timer);
    if (!open) return;
    if (homeShown() && !inflight) {
      inflight = true;
      const by = open, at = period;
      const r = await fetch(`/api/sources/home/${live() ? 'top' : 'usage'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by, mins: period }) })
        .then(x => x.ok ? x.json() : null).catch(() => null);
      inflight = false;
      if (r && open === by && period === at) { data = r; if (live()) remember(); render(); }
    }
    timer = setTimeout(poll, live() ? EVERY : EVERY_PAST);
  }
  // the last minute of each group, for its sparkline
  function remember() {
    const seen = new Set();
    for (const g of data.groups) { seen.add(g.key); (hist[g.key] ||= []).push(value(g)); if (hist[g.key].length > 30) hist[g.key].shift(); }
    for (const k in hist) if (!seen.has(k)) delete hist[k];
  }

  function icon(g) {
    // a period's app may not run now: its icon comes from the running copy, if any
    const pid = g.pid ?? (DevDock.sourceData.apps?.apps || []).find(a => a.path === g.path)?.pid;
    if (g.kind === 'app' && g.hasIcon && pid) return `<img class="tp-icon" src="/api/app-icon/${esc(pid)}" alt="">`;
    if (g.kind === 'server') return `<span class="tp-icon">${runtimeIconHTML(g.runtime, g.runtimeColor, '', 18)}</span>`;
    if (g.kind === 'agent') return `<span class="tp-icon">${agentHTML(g.agent, g.agent)}</span>`;
    return `<span class="tp-icon tp-glyph">${GLYPH[g.kind === 'process' && macOS(g.path) ? 'system' : g.kind] || GLYPH.process}</span>`;
  }
  // Apple's own services that run as you (exchangenotesd, linkd): macOS restarts them anyway
  const macOS = p => /^\/(System|usr|bin|sbin|Library\/Apple)\/|^\/private\/var\/run\/com\.apple\./.test(p || '');
  function sub(g) {
    const n = g.count > 1 ? `${g.count} processes` : '';
    const parts = {
      server: [g.ports?.map(p => ':' + p).join(' '), g.cwd ? tildify(g.cwd) : 'dev server'],
      agent: [g.agent, g.cwd && tildify(g.cwd)],
      app: ['app'],
      process: [macOS(g.path) ? 'macOS, running as you' : g.path?.startsWith('/') ? tildify(g.path.replace(/\/[^/]*$/, '')) : ''],
      system: ['macOS'],
      rest: ['the kernel, and processes that started and ended between two readings'],
    }[g.kind] || [];
    // the busiest minute, so a short burst isn't hidden by the average
    const peak = !live() && g.peak > value(g) * 1.2 ? `busiest minute ${METRIC[open].show(g.peak)}` : '';
    return [...parts, live() ? n : '', peak].filter(Boolean).join(' · ');
  }

  const item = (label, onclick, cls = '') => `<button class="${cls}" onclick="${onclick}">${label}</button>`;
  function menu(g) {
    if (!live()) return '<span></span>'; // a period's groups are who, not which processes now
    const name = js(g.name), key = js(g.key);
    const V = 'DevDockViews.vitals';
    const list = {
      app: [item('Show', `${V}.app('show','${g.pid}')`), g.path && item('Show in Finder', `${V}.app('reveal','${g.pid}')`),
        '<div class="actions-divider"></div>', item('Quit', `${V}.app('quit','${g.pid}')`, 'danger'), item('Force quit', `${V}.app('forceQuit','${g.pid}',${name})`, 'danger')],
      server: [g.ports?.length && item('Open in browser', `window.open('http://localhost:${g.ports[0]}')`),
        item('Show in Ports', `revealRow('servers','${g.pid}:',${name})`),
        '<div class="actions-divider"></div>', item('Stop', `${V}.kill('${g.pid}',false,${name})`, 'danger')],
      agent: [DevDockViews.coding?.canJump(g.pid) && item('Jump to it', `DevDockViews.coding.jump('${g.pid}')`),
        item('Show in Coding agents', `revealRow('coding','g:${g.pid}',${name})`),
        '<div class="actions-divider"></div>', item('Stop', `${V}.stopAgent('${g.pid}',${name})`, 'danger')],
      process: [g.path?.startsWith('/') && item('Show in Finder', `${V}.reveal('${g.pid}')`),
        item(`Copy PID${g.count > 1 ? 's' : ''}`, `copyText('${g.pids.join(' ')}','PID')`),
        '<div class="actions-divider"></div>', item(g.count > 1 ? `Quit all ${g.count}` : 'Quit', `${V}.killGroup(${key},false)`, 'danger'),
        item('Force quit', `${V}.killGroup(${key},true)`, 'danger')],
      system: [item('Copy name', `copyText(${name},'Name')`), item('Copy PID', `copyText('${g.pid}','PID')`)],
    }[g.kind];
    const items = (list || []).filter(Boolean).join('');
    const id = 'tp-' + g.key.replace(/[^\w-]/g, '_');
    return items ? `<button class="actions-trigger" aria-label="Actions" onclick="event.stopPropagation();toggleActionsMenu('${id}',this)">⋯</button><div class="actions-menu" id="menu-${id}">${items}</div>` : '<span></span>';
  }

  // a group's processes hold their order under the pointer too, so Quit stays on its row
  const procOrder = {};
  const held = (prev, list, id) => { if (!hover || !prev) return list; const at = x => { const i = prev.indexOf(id(x)); return i < 0 ? 1e9 : i; }; return [...list].sort((a, b) => at(a) - at(b)); };
  function procs(g) {
    const m = METRIC[open];
    const list = held(procOrder[g.key], g.procs, p => p.pid);
    procOrder[g.key] = list.map(p => p.pid);
    return `<div class="tp-procs">${list.map(p => `<div class="tp-proc"><code>${esc(p.pid)}</code><span class="trunc">${esc(p.name)}</span>
      <em>${m.show(m.of(p))}</em><span>${p.mine && g.kind !== 'system' ? `<button onclick="DevDockViews.vitals.kill('${p.pid}',false,${js(p.name)},${p.started ?? 'null'})" title="SIGTERM: ask it to stop">Quit</button><button class="danger" onclick="DevDockViews.vitals.kill('${p.pid}',true,${js(p.name)},${p.started ?? 'null'})" title="SIGKILL: stop it now">Force</button>` : ''}</span></div>`).join('')}
      ${g.count > g.procs.length ? `<div class="tp-more">and ${g.count - g.procs.length} more</div>` : ''}</div>`;
  }

  function summary() {
    const v = DevDock.sourceData.home?.vitals || {}, mc = v.machine || {};
    if (!live()) {
      const t = data?.total || {};
      if (!data?.groups?.length) return '';
      if (open === 'cpu') return `<b>${Math.round(t.cpu / (v.cores || 1))}%</b> of ${v.cores} cores busy on average`;
      if (open === 'mem') return 'Average of each minute';
      if (open === 'disk') return `<b>${rate(t.diskR + t.diskW)}</b> on average · read ${rate(t.diskR)} · write ${rate(t.diskW)}`;
      return `<b>↓ ${rate(t.rx)}</b> · <b>↑ ${rate(t.tx)}</b> whole Mac, on average`;
    }
    // the list's own window (kernel included), so the header and the rows add up
    const cpu = data?.total ? data.total.cpu / (v.cores || 1) : mc.cpu;
    if (open === 'cpu') return cpu == null ? '' : `<b>${Math.round(cpu)}%</b> of ${v.cores} cores busy`;
    if (open === 'mem') return mc.mem == null ? '' : `<b>${formatMem(mc.mem)}</b> of ${formatMem(v.totalMem || 0)} in use`;
    // every process, not just the groups listed
    const [a, b] = METRIC[open].io, r = data?.total?.[a] || 0, w = data?.total?.[b] || 0;
    return open === 'net' ? `<b>↓ ${rate(r)}</b> · <b>↑ ${rate(w)}</b>` : `<b>${rate(r + w)}</b> · read ${rate(r)} · write ${rate(w)}`;
  }
  const NOTE = {
    cpu: '% of one core, like Activity Monitor. Grouped by what started it: a dev server or agent owns everything it launched.',
    mem: 'Memory like Activity Monitor. macOS processes show resident memory: macOS doesn\'t share their exact footprint.',
    disk: 'Reads and writes by your processes. macOS doesn\'t share other users\' disk use, so its own services aren\'t listed.',
    net: 'Traffic on every interface but loopback, so not DevDock talking to your dev servers. From macOS\'s nettop, which runs only while this is open.',
  };

  // how much of the period is recorded, said plainly
  const span = s => s >= 5400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`;
  function coverage() {
    if (live() || !data?.groups?.length) return '';
    const of = PERIODS.find(p => p[0] === period)[1];
    const gap = data.covered < period * 60 * 0.9 ? `Recorded ${span(data.covered)} of the last ${of}: DevDock records only while it runs. ` : '';
    const net = open === 'net' ? `Per-app traffic covers ${span(data.netCovered)}, the time this view was open; the total above is the whole Mac. ` : '';
    return gap + net;
  }
  function empty(m) {
    if (!data || data.by !== open) return 'Measuring…';
    if (live()) return `Nothing is using the ${m.label.toLowerCase()} right now.`;
    if (!data.on) return 'App usage isn\'t being recorded. <button class="link-btn" onclick="DevDockViews.vitals.settings()">Turn it on in Settings</button>';
    if (open === 'net' && !data.netCovered) return 'No per-app traffic recorded yet: it\'s measured only while the Network view is open.';
    return data.covered ? `Nothing used the ${m.label.toLowerCase()} in this period.` : 'Nothing recorded yet. DevDock records once a minute: check back in a couple of minutes.';
  }

  function render() {
    if (!open) return;
    const m = METRIC[open];
    let gs = (data?.by === open ? data.groups : []).filter(g => value(g) > 0);
    // hold the order under the pointer: values move, rows don't
    gs = held(order, gs, g => g.key);
    order = gs.map(g => g.key);
    const max = Math.max(...gs.map(value), 1e-9);
    const list = all ? gs : gs.slice(0, SHOWN);
    el.className = `hpanel by-${open}`;
    const before = new Map([...el.querySelectorAll('.tp-row')].map(r => [r.dataset.key, r.getBoundingClientRect().top]));
    el.innerHTML = `
      <header class="tp-head">
        <div class="subtabs" role="tablist">${Object.entries(METRIC).map(([k, x]) => `<button role="tab" aria-selected="${k === open}" onclick="DevDockViews.vitals.show('${k}')">${x.label}</button>`).join('')}</div>
        <span class="tp-sum">${summary()}</span>
        <span class="tp-periods" role="radiogroup" aria-label="Period">${PERIODS.filter(([p]) => p !== 10080 || data?.days === 7 || period === 10080)
          .map(([p, label]) => `<button role="radio" aria-checked="${p === period}" onclick="DevDockViews.vitals.period(${JSON.stringify(p).replace(/"/g, "'")})" title="${p === 'live' ? 'The last 2 seconds, refreshed every 2' : `Average over the last ${label}, from the usage history`}">${p === 'live' ? '<i></i>' : ''}${label}</button>`).join('')}</span>
        <button class="tp-x" title="Close (Esc)" onclick="DevDockViews.vitals.close()">${GLYPH.close}</button>
      </header>
      ${!data || data.by !== open || !gs.length ? `<div class="tp-empty">${empty(m)}</div>` : `
      <div class="tp-list">${list.map(g => {
        const v = value(g), w = (v / max * 100).toFixed(1), was = widths[g.key] ?? 0, isOpen = expanded.has(g.key);
        widths[g.key] = w;
        return `<div class="tp-row kind-${g.kind}${isOpen ? ' is-open' : ''}" data-key="${esc(g.key)}">
          <button class="tp-main" ${live() ? `onclick="DevDockViews.vitals.toggle(${js(g.key)})" title="${isOpen ? 'Hide' : 'Show'} its processes"` : 'tabindex="-1"'}>
            <span class="tp-chev">${live() && (g.count > 1 || g.kind !== 'rest') ? GLYPH.chev : ''}</span>${icon(g)}
            <span class="tp-name"><b class="trunc">${esc(g.name)}</b><small class="trunc">${esc(sub(g))}</small></span>
          </button>
          <span class="tp-bar"><i style="width:${was}%" data-w="${w}"></i></span>
          <span class="tp-spark">${sparkline(live() ? hist[g.key] : g.spark, { color: m.color, w: 72, h: 22 })}</span>
          <span class="tp-val">${m.io ? `<span title="${m.io[2]}">↓ ${rate(g[m.io[0]])}</span> <span title="${m.io[3]}">↑ ${rate(g[m.io[1]])}</span>` : m.show(v)}</span>
          ${menu(g)}
        </div>${live() && isOpen && g.kind !== 'rest' ? procs(g) : ''}`;
      }).join('')}</div>
      ${gs.length > SHOWN ? `<button class="link-btn tp-all" onclick="DevDockViews.vitals.all()">${all ? 'Show fewer' : data.count > gs.length ? `Show top ${gs.length} of ${data.count}` : `Show all ${gs.length}`}</button>` : ''}`}
      <p class="tp-note">${coverage()}${NOTE[open]}</p>`;
    // slide rows from where they were (FLIP), then grow the bars to their new size
    for (const r of el.querySelectorAll('.tp-row')) {
      const top = before.get(r.dataset.key);
      if (top == null) continue;
      const dy = top - r.getBoundingClientRect().top;
      if (dy && !still.matches) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    requestAnimationFrame(() => el.querySelectorAll('.tp-bar i').forEach(i => { i.style.width = i.dataset.w + '%'; }));
    lit();
  }
  const lit = () => document.querySelectorAll('.hvital[data-metric]').forEach(t => t.classList.toggle('is-open', t.dataset.metric === open));

  function show(metric) {
    if (open === metric) return;
    open = metric; data = null; all = false;
    for (const k in hist) delete hist[k];
    for (const k in widths) delete widths[k];
    expanded.clear();
    el.innerHTML = '';
    DevDockViews.home.render();
    render();
    poll();
  }
  function close() {
    open = null; data = null; clearTimeout(timer);
    el.remove();
    document.querySelectorAll('.hvital.is-open').forEach(t => t.classList.remove('is-open'));
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open && !document.querySelector('.actions-menu.open, #floatingMenu.open')) close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && open) poll(); });

  const after = async ok => { if (ok) setTimeout(poll, 400); };
  DevDockViews.vitals = {
    show, close,
    period(p) {
      if (p === period) return;
      period = p; data = null; all = false; order = [];
      try { localStorage.setItem('devdock:vitals-period', JSON.stringify(p)); } catch {}
      render(); poll();
    },
    settings() { document.getElementById('settingsBtn').click(); document.querySelector('#settingsNav [data-pane=history]')?.click(); },
    toggle: key => { expanded.has(key) ? expanded.delete(key) : expanded.add(key); render(); },
    tile: metric => open === metric ? close() : show(metric),
    all: () => { all = !all; render(); },
    // Home re-renders its whole view: put the same panel back, as it was
    mount() {
      const slot = document.getElementById('hpanelSlot');
      if (!slot || !open) return;
      slot.replaceWith(el);
      lit();
    },
    async app(action, pid, name) {
      closeAllMenus();
      if (action === 'forceQuit' && !await confirmDialog(`Force quit ${name}?`, 'Unsaved work is lost.', 'Force quit')) return;
      after(await sourceAction('apps', action, { pid }));
    },
    async reveal(pid) { closeAllMenus(); await sourceAction('home', 'reveal', { pid }); },
    async kill(pid, force, name, started) {
      closeAllMenus();
      if (!await confirmDialog(`${force ? 'Force quit' : 'Quit'} ${name}?`, `PID ${pid}`, force ? 'Force quit' : 'Quit')) return;
      after(await sourceAction('home', 'kill', { pid, force, started }));
    },
    async killGroup(key, force) {
      closeAllMenus();
      const g = data?.groups.find(x => x.key === key);
      if (!g) return;
      const pids = g.pids;
      if (!await confirmDialog(`${force ? 'Force quit' : 'Quit'} ${g.count > 1 ? `${g.count} ${g.name} processes` : g.name}?`, `PID${pids.length > 1 ? 's' : ''} ${pids.join(', ')}`, force ? 'Force quit' : 'Quit')) return;
      let ok = 0;
      for (const [i, pid] of pids.entries()) if (await sourceAction('home', 'kill', { pid, force, started: g.starts[i] })) ok++;
      showToast(ok === pids.length ? `Stopped ${g.name}` : `Stopped ${ok} of ${pids.length}`, ok === pids.length ? undefined : 'warn');
      after(ok);
    },
    async stopAgent(pid, name) {
      closeAllMenus();
      if (!await confirmDialog(`Stop ${name}?`, `PID ${pid}`, 'Stop')) return;
      after(await sourceAction('coding', 'stop', { pid }));
    },
  };
})();

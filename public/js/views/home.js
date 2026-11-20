// Home tab: only what needs you, from sources/home.js. Critical first (runaway CPU, memory
// leaks, crash loops), then agents waiting on you, agents that just finished, and things to
// tidy up. Every card has its fix next to it and can be snoozed for an hour.
(function () {
  const view = document.getElementById('homeView');
  const svg = (d, s = 16, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICON = {
    cpu: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3"/>'),
    mem: svg('<path d="M3 17l5-5 4 4 8-8"/><path d="M14 8h6v6"/>'),
    crash: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
    'needs-you': svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    finished: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
    forgotten: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>'),
    duplicate: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    snooze: svg('<path d="M12 6v6l3 2"/><circle cx="12" cy="12" r="9"/>', 13),
    jump: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 13),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 13),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 30, 'stroke-width="2.4"'),
  };
  const SECTIONS = [
    ['critical', 'Critical', 'Hurting your Mac right now'],
    ['needs-you', 'Waiting on you', 'Agents stopped until you answer'],
    ['done', 'Just finished', 'Agents that wrapped up a turn'],
    ['tidy', 'Tidy up', 'Left behind, safe to stop'],
  ];

  // Snoozed card ids -> until (ms). Per viewer, so localStorage.
  let snoozed = {};
  try { snoozed = JSON.parse(localStorage.getItem('devdock:home-snooze') || '{}'); } catch {}
  const isSnoozed = it => snoozed[it.id] > Date.now();
  function snooze(id, ms) {
    snoozed[id] = Date.now() + ms;
    for (const [k, t] of Object.entries(snoozed)) if (t < Date.now()) delete snoozed[k];
    try { localStorage.setItem('devdock:home-snooze', JSON.stringify(snoozed)); } catch {}
    render(); badge();
  }

  const data = () => DevDock.sourceData.home;
  const visibleItems = () => (data()?.items || []).filter(it => !isSnoozed(it));
  const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
  const cores = pct => `${(pct / 100).toFixed(1)} cores`;
  const ports = s => (s.ports || []).map(p => ':' + p).join(' ');
  const where = s => s.kind === 'server' ? `${s.name}${s.ports?.length ? ' ' + ports(s) : ''}` : s.name;

  // Sparkline with a soft area under it, and a dashed line where the alarm starts
  function spark(values, { color, limit, w = 148, h = 42 } = {}) {
    if (!values?.length) return '';
    const max = Math.max(...values, limit || 0) * 1.08 || 1, min = limit ? 0 : Math.min(...values) * 0.92;
    const x = i => (i / Math.max(1, values.length - 1)) * w, y = v => h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
    const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const id = 'g' + Math.random().toString(36).slice(2, 8);
    return `<svg class="hspark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${limit ? `<line x1="0" x2="${w}" y1="${y(limit)}" y2="${y(limit)}" stroke="${color}" stroke-opacity=".45" stroke-dasharray="3 3"/>` : ''}
      <path d="${line}L${w},${h}L0,${h}Z" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.6" fill="${color}"/>
    </svg>`;
  }

  const subjectIcon = s => s.kind === 'agent' ? agentHTML(s.agent, s.agent)
    : s.kind === 'server' ? runtimeIconHTML(s.runtime, s.runtimeColor, '', 14) : '';
  const metaLine = s => [
    s.cwd && `<span class="trunc" title="${esc(s.cwd)}">${esc(tildify(s.cwd))}</span>`,
    s.branch && `<span class="branch trunc">⎇ ${esc(s.branch)}</span>`,
  ].filter(Boolean).join('');
  const btn = (label, onclick, icon = '', cls = '') => `<button class="hbtn ${cls}" onclick="${onclick}">${icon}${label}</button>`;
  const snoozeBtn = (it, ms = 3600000, label = 'Snooze 1h') => `<button class="hbtn ghost" title="Hide this for ${label === 'Dismiss' ? 'good' : 'an hour'}" onclick="DevDockViews.home.snooze('${esc(it.id)}', ${ms})">${label === 'Dismiss' ? '' : ICON.snooze}${label}</button>`;
  const jumpBtn = s => (s.where?.mux || s.where?.app) ? btn('Jump to it', `DevDockViews.coding.jump('${s.pid}')`, ICON.jump, 'primary') : '';
  const stopBtn = (subjects, label = 'Stop', cls = 'danger') => btn(label, `DevDockViews.home.stop('${subjects.map(s => `${s.kind[0]}${s.pid}`).join(',')}')`, ICON.stop, cls);

  function card(it) {
    const s = it.subject;
    const kicker = (text, extra = '') => `<div class="hcard-kicker">${ICON[it.type]}<span>${text}</span>${extra}</div>`;
    switch (it.type) {
      case 'cpu': return `
        <article class="hcard sev-critical">
          <div class="hcard-main">
            ${kicker('Runaway CPU', `<em>for ${dur(Date.now() - it.since)}</em>`)}
            <div class="hcard-title">${subjectIcon(s)}<b>${esc(where(s))}</b> is pinning ${cores(it.value)}</div>
            <div class="hcard-meta">${metaLine(s)}</div>
            <div class="hcard-actions">${stopBtn([s])}${snoozeBtn(it)}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${Math.round(it.value)}<small>%</small></div>${spark(it.spark, { color: 'var(--red)', limit: 200 })}<div class="hcap">last 15 min · line at 2 cores</div></div>
        </article>`;
      case 'mem': return `
        <article class="hcard sev-critical">
          <div class="hcard-main">
            ${kicker('Memory leak', `<em>climbing for ${dur(Date.now() - it.since)}</em>`)}
            <div class="hcard-title">${subjectIcon(s)}<b>${esc(where(s))}</b> keeps growing, +${formatMem(it.rate)} a minute</div>
            <div class="hcard-meta">${metaLine(s)}</div>
            <div class="hcard-actions">${stopBtn([s], 'Stop')}${snoozeBtn(it)}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${formatMem(it.value)}</div>${spark(it.spark, { color: 'var(--red)' })}<div class="hcap">${formatMem(it.from)} → ${formatMem(it.value)}</div></div>
        </article>`;
      case 'crash': return `
        <article class="hcard sev-critical">
          <div class="hcard-main">
            ${kicker('Crash loop')}
            <div class="hcard-title"><b>${esc(s.name)}</b> keeps crashing and restarting</div>
            <div class="hcard-meta"><span class="trunc">${esc(s.pod ? `pod ${s.pod} · ${s.namespace}` : s.image)}</span><span class="trunc">${esc(s.status)}</span></div>
            <div class="hcard-actions">${btn('Show in Containers', `DevDockViews.home.showContainer('${esc(s.name)}')`, ICON.jump, 'primary')}${s.pod ? '' : btn('Stop', `DevDockViews.home.stopContainer('${s.id}', '${esc(s.name)}')`, ICON.stop, 'danger')}${snoozeBtn(it)}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${it.value || '?'}<small> restarts</small></div>
            <div class="hdots">${Array.from({ length: Math.min(12, it.value || 1) }, (_, i) => `<i style="animation-delay:${i * 90}ms"></i>`).join('')}</div></div>
        </article>`;
      case 'needs-you': return `
        <article class="hcard sev-needs-you">
          <div class="hcard-main">
            ${kicker('Needs you', `<em>waiting ${dur(Date.now() - it.since)}</em>`)}
            <div class="hcard-title">${subjectIcon(s)}<b>${esc(s.name)}</b> is stuck until you answer</div>
            <div class="hcard-meta">${metaLine(s)}</div>
          </div>
          <div class="hcard-side">${jumpBtn(s)}${snoozeBtn(it)}</div>
        </article>`;
      case 'finished': return `
        <div class="hrow sev-done">
          ${ICON.finished}${subjectIcon(s)}<b>${esc(s.name)}</b><span class="hrow-text">finished ${dur(Date.now() - it.since)} ago</span>
          <span class="hrow-meta">${metaLine(s)}</span>
          <span class="hrow-actions">${jumpBtn(s)}${snoozeBtn(it, 7 * 86400000, 'Dismiss')}</span>
        </div>`;
      case 'forgotten': return `
        <article class="hcard sev-tidy">
          <div class="hcard-main">
            ${kicker('Forgotten', `<em>nothing owns ${it.subjects.length > 1 ? 'them' : 'it'}</em>`)}
            <div class="hcard-title">${it.subjects.length} ${it.subjects.length > 1 ? 'things' : 'thing'} idle for hours with no terminal</div>
            <ul class="hlist">${it.subjects.map(f => `<li>${subjectIcon(f)}<b>${esc(where(f))}</b><span class="trunc">${esc(tildify(f.cwd || ''))}</span><em>idle ${dur(Date.now() - f.idleSince)} · ${formatMem(f.memMB)}</em></li>`).join('')}</ul>
            <div class="hcard-actions">${stopBtn(it.subjects, `Stop ${it.subjects.length > 1 ? 'all' : 'it'} · frees ${formatMem(it.value)}`)}${snoozeBtn(it)}</div>
          </div>
        </article>`;
      case 'duplicate': {
        const newest = it.subjects[it.subjects.length - 1];
        return `
        <article class="hcard sev-tidy">
          <div class="hcard-main">
            ${kicker('Running twice')}
            <div class="hcard-title"><b>${esc(it.name)}</b> is running ${it.subjects.length} times from the same folder</div>
            <div class="hcard-meta">${metaLine({ cwd: it.cwd, branch: it.subjects[0].branch })}</div>
            <div class="hdup">${it.subjects.map(s => `<span>${subjectIcon(s)}${esc(ports(s) || s.pid)}</span>`).join('<i>=</i>')}</div>
            <div class="hcard-actions">${stopBtn([newest], `Stop ${ports(newest) || 'the newer one'}`)}${snoozeBtn(it)}</div>
          </div>
        </article>`;
      }
    }
    return '';
  }

  function hero(items) {
    const v = data()?.vitals || {};
    const crit = items.filter(i => i.severity === 'critical').length, wait = items.filter(i => i.severity === 'needs-you').length;
    const tidy = items.filter(i => i.severity === 'tidy').length;
    const sev = crit ? 'critical' : wait ? 'needs-you' : tidy ? 'tidy' : 'clear';
    const n = crit + wait;
    const headline = crit || wait ? `${n} ${n > 1 ? 'things need' : 'thing needs'} you` : tidy ? 'Nothing urgent' : 'All clear';
    const parts = [
      ...['cpu', 'mem', 'crash'].map(t => [t, items.filter(i => i.type === t).length]).filter(([, c]) => c)
        .map(([t, c]) => `${c} ${{ cpu: 'runaway', mem: 'leaking', crash: 'crash-looping' }[t]}`),
      wait && `${wait} agent${wait > 1 ? 's' : ''} waiting`,
      !crit && !wait && tidy && `${tidy} thing${tidy > 1 ? 's' : ''} to tidy up`,
    ].filter(Boolean);
    const sub = parts.length ? parts.join(' · ') : `Watching ${v.servers || 0} servers and ${v.agents || 0} agents. Nothing needs you.`;
    const cpuPct = Math.min(100, (v.cpu || 0) / ((v.cores || 1) * 100) * 100), memPct = Math.min(100, (v.mem || 0) / (v.totalMem || 1) * 100);
    const meter = pct => `<div class="hmeter"><i style="width:${pct.toFixed(1)}%"></i></div>`;
    return `
      <section class="hhero sev-${sev}">
        <div class="horb">${sev === 'clear' ? ICON.check : `<span>${n || tidy}</span>`}</div>
        <div class="hhead"><h2>${headline}</h2><p>${esc(sub)}</p></div>
        <div class="hvitals">
          <div class="hvital"><label>Dev CPU</label><div class="hv">${((v.cpu || 0) / 100).toFixed(1)}<small> / ${v.cores || '?'} cores</small></div>${meter(cpuPct)}${spark(v.cpuSpark, { color: 'var(--accent)', w: 120, h: 26 })}</div>
          <div class="hvital"><label>Dev memory</label><div class="hv">${formatMem(v.mem || 0)}<small> / ${formatMem(v.totalMem || 0)}</small></div>${meter(memPct)}${spark(v.memSpark, { color: 'var(--accent)', w: 120, h: 26 })}</div>
          <div class="hvital"><label>Agents</label><div class="hv">${v.agents || 0}</div>
            <div class="hagents">${v.working ? `<span class="ast-working">${STATE_ICON.working}${v.working} working</span>` : ''}${v.needsYou ? `<span class="ast-needs-you">${STATE_ICON['needs-you']}${v.needsYou} waiting</span>` : ''}${!v.working && !v.needsYou ? '<span>all idle</span>' : ''}</div></div>
          <div class="hvital"><label>Servers</label><div class="hv">${v.servers || 0}</div><div class="hagents"><span>project servers</span></div></div>
        </div>
      </section>`;
  }

  function render() {
    const d = data();
    document.getElementById('viewStats').innerHTML = '';
    document.getElementById('viewTools').innerHTML = '';
    if (!d) { view.innerHTML = '<div class="empty-view">Taking a first look…</div>'; return; }
    const q = searchInput.value.trim().toLowerCase();
    const all = visibleItems();
    const items = q ? all.filter(it => q.split(/\s+/).every(w => JSON.stringify([it.type, it.subject, it.subjects, it.name]).toLowerCase().includes(w))) : all;
    setViewResult(items.length, all.length);
    const snoozedCount = (d.items || []).length - all.length;
    view.innerHTML = `<div class="home">
      ${hero(all)}
      ${SECTIONS.map(([sev, title, hint]) => {
        const list = items.filter(it => it.severity === sev);
        return list.length ? `<section class="hsec sev-${sev}"><header><h3>${title}</h3><span>${hint}</span></header>
          <div class="${sev === 'done' ? 'hrows' : 'hgrid'}">${list.map(card).join('')}</div></section>` : '';
      }).join('')}
      ${snoozedCount ? `<div class="hfoot">${snoozedCount} snoozed · <button class="link-btn" onclick="DevDockViews.home.unsnooze()">show them</button></div>` : ''}
    </div>`;
  }

  // The Home tab's dot: red for critical, amber for waiting, nothing otherwise
  function badge() {
    const tab = document.querySelector('#tabs [data-tab="home"]');
    if (!tab) return;
    const items = visibleItems();
    const crit = items.filter(i => i.severity === 'critical').length, wait = items.filter(i => i.severity === 'needs-you').length;
    tab.dataset.alert = crit ? 'critical' : wait ? 'needs-you' : '';
    tab.title = `Home${crit + wait ? ` · ${crit + wait} need${crit + wait > 1 ? '' : 's'} you` : ''}  ⌘6`;
  }
  document.addEventListener('devdock:source', e => { if (e.detail === 'home') badge(); });

  async function stop(refs) {
    closeAllMenus();
    const list = refs.split(',').map(r => ({ kind: r[0] === 'a' ? 'agent' : 'server', pid: r.slice(1) }));
    const what = list.length === 1 ? `${list[0].kind} ${list[0].pid}` : `${list.length} processes`;
    if (!await confirmDialog(`Stop ${what}?`, `PID${list.length > 1 ? 's' : ''} ${list.map(s => s.pid).join(', ')}`, 'Stop')) return;
    let ok = 0;
    for (const s of list) {
      if (s.kind === 'agent' ? await sourceAction('coding', 'stop', { pid: s.pid }) : await fetch(`/api/kill/${s.pid}`, { method: 'POST' }).then(r => r.ok).catch(() => false)) ok++;
    }
    showToast(ok === list.length ? `Stopped ${what}` : `Stopped ${ok} of ${list.length}`, ok === list.length ? undefined : 'warn');
  }

  DevDockViews.home = {
    render, snooze, stop,
    unsnooze() { snoozed = {}; try { localStorage.removeItem('devdock:home-snooze'); } catch {} render(); badge(); },
    showContainer(name) { setTab('containers'); searchInput.value = name; searchInput.dispatchEvent(new Event('input')); },
    async stopContainer(id, name) {
      if (!await confirmDialog(`Stop container ${name}?`, 'It stays on disk; start it again from Containers.', 'Stop')) return;
      if (await sourceAction('containers', 'stop', { id })) showToast(`Stopped ${name}`);
    },
  };
})();

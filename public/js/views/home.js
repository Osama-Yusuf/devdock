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
    limit: svg('<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
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
    ['limit', 'Plan limits', 'Running low on a coding plan'],
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

  const subjectIcon = s => s.kind === 'agent' ? agentHTML(s.agent, s.agent)
    : s.kind === 'server' ? runtimeIconHTML(s.runtime, s.runtimeColor, '', 14) : '';
  const metaLine = s => [
    s.cwd && `<span class="trunc" title="${esc(s.cwd)}">${esc(tildify(s.cwd))}</span>`,
    s.branch && `<span class="branch trunc">⎇ ${esc(s.branch)}</span>`,
  ].filter(Boolean).join('');
  const btn = (label, onclick, icon = '', cls = '') => `<button class="hbtn ${cls}" onclick="${onclick}">${icon}${label}</button>`;
  const snoozeBtn = (it, ms = 3600000, label = 'Snooze 1h') => `<button class="hbtn ghost" title="Hide this for ${label === 'Dismiss' ? 'good' : 'an hour'}" onclick="DevDockViews.home.snooze('${esc(it.id)}', ${ms})">${label === 'Dismiss' ? '' : ICON.snooze}${label}</button>`;
  const jumpBtn = s => DevDockViews.coding?.canJump(s.pid) ? btn('Jump to it', `DevDockViews.coding.jump('${s.pid}')`, ICON.jump, 'primary') : '';
  // an agent's way to its row: a quiet link under Jump, not a second button
  const agentLink = s => `${s.where?.mux ? `<button class="link-btn hgo" onclick="DevDockViews.coding.openHere('${s.pid}')">Open here</button>` : ''}<button class="link-btn hgo" data-key="g:${s.pid}" data-name="${esc(s.name || '')}" onclick="revealRow('coding', this.dataset.key, this.dataset.name)">Go to agents</button>`;
  // where the alert comes from, and a way there with the row lit up
  const SRC = { server: ['servers', 'Ports', s => `${s.pid}:`], agent: ['coding', 'Coding agents', s => `g:${s.pid}`], container: ['containers', 'Containers', s => `c:${s.id}`] };
  const showBtn = s => { const src = SRC[s?.kind]; return src ? `<button class="hbtn" data-tab="${src[0]}" data-key="${esc(src[2](s))}" data-name="${esc(s.name || '')}"
    onclick="revealRow(this.dataset.tab, this.dataset.key, this.dataset.name)">${ICON.jump}Show in ${src[1]}</button>` : ''; };
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
            <div class="hcard-actions">${showBtn(s)}${stopBtn([s])}${snoozeBtn(it)}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${Math.round(it.value)}<small>%</small></div>${sparkline(it.spark, { color: 'var(--red)', limit: 200 })}<div class="hcap">last 15 min · line at 2 cores</div></div>
        </article>`;
      case 'mem': return `
        <article class="hcard sev-critical">
          <div class="hcard-main">
            ${kicker('Memory leak', `<em>climbing for ${dur(Date.now() - it.since)}</em>`)}
            <div class="hcard-title">${subjectIcon(s)}<b>${esc(where(s))}</b> keeps growing, +${formatMem(it.rate)} a minute</div>
            <div class="hcard-meta">${metaLine(s)}</div>
            <div class="hcard-actions">${showBtn(s)}${stopBtn([s], 'Stop')}${snoozeBtn(it)}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${formatMem(it.value)}</div>${sparkline(it.spark, { color: 'var(--red)' })}<div class="hcap">${formatMem(it.from)} → ${formatMem(it.value)}</div></div>
        </article>`;
      case 'crash': return `
        <article class="hcard sev-critical">
          <div class="hcard-main">
            ${kicker('Crash loop')}
            <div class="hcard-title"><b>${esc(s.name)}</b> keeps crashing and restarting</div>
            <div class="hcard-meta"><span class="trunc">${esc(s.pod ? `pod ${s.pod} · ${s.namespace}` : s.image)}</span><span class="trunc">${esc(s.status)}</span></div>
            <div class="hcard-actions">${showBtn(s)}${s.pod ? '' : btn('Stop', `DevDockViews.home.stopContainer('${s.id}', '${esc(s.name)}')`, ICON.stop, 'danger')}${snoozeBtn(it)}</div>
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
          <div class="hcard-side">${jumpBtn(s)}${agentLink(s)}${snoozeBtn(it)}</div>
        </article>`;
      case 'limit': {
        const left = Math.max(0, Math.round(100 - it.used)), until = it.resetsAt ? it.resetsAt - Date.now() : 0;
        return `
        <article class="hcard sev-limit">
          <div class="hcard-main">
            ${kicker('Plan limit', until > 0 ? `<em>resets in ${dur(until)}</em>` : '')}
            <div class="hcard-title">${agentHTML(it.tool, it.tool)}<b>${esc(it.tool)}</b> has ${left}% of its ${esc(it.label.toLowerCase())} limit left</div>
            <div class="hcard-meta">${it.plan ? `<span>${esc(it.plan)} plan</span>` : ''}${it.resetsAt ? `<span>resets ${esc(new Date(it.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</span>` : ''}</div>
            <div class="hcard-actions"><button class="link-btn hgo" onclick="setTab('coding')">See all limits</button>${snoozeBtn(it, Math.max(3600000, until), 'Dismiss')}</div>
          </div>
          <div class="hcard-viz"><div class="hval">${left}<small>% left</small></div><div class="hmeter"><i style="width:${Math.min(100, it.used).toFixed(1)}%"></i></div><div class="hcap">${Math.round(it.used)}% used</div></div>
        </article>`;
      }
      case 'finished': return `
        <div class="hrow sev-done">
          ${ICON.finished}${subjectIcon(s)}<b>${esc(s.name)}</b><span class="hrow-text">finished ${dur(Date.now() - it.since)} ago</span>
          <span class="hrow-meta">${metaLine(s)}</span>
          <span class="hrow-actions">${jumpBtn(s)}${agentLink(s)}${snoozeBtn(it, 7 * 86400000, 'Dismiss')}</span>
        </div>`;
      case 'forgotten': return `
        <article class="hcard sev-tidy">
          <div class="hcard-main">
            ${kicker('Forgotten', `<em>nothing owns ${it.subjects.length > 1 ? 'them' : 'it'}</em>`)}
            <div class="hcard-title">${it.subjects.length} ${it.subjects.length > 1 ? 'things' : 'thing'} idle for hours with no terminal</div>
            <ul class="hlist">${it.subjects.map(f => `<li>${subjectIcon(f)}<b>${esc(where(f))}</b>${showBtn(f).replace('class="hbtn"', 'class="hbtn ghost hshow"').replace(/Show in [^<]*/, 'Show')}<span class="trunc">${esc(tildify(f.cwd || ''))}</span><em>idle ${dur(Date.now() - f.idleSince)} · ${formatMem(f.memMB)}</em></li>`).join('')}</ul>
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
            <div class="hcard-actions">${showBtn(newest)}${stopBtn([newest], `Stop ${ports(newest) || 'the newer one'}`)}${snoozeBtn(it)}</div>
          </div>
        </article>`;
      }
    }
    return '';
  }

  // The startup disk, sizes decimal like Finder
  const gb = mb => { const b = mb * 1048576; return b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${Math.round(b / 1e9)} GB`; };
  function diskTile(d) {
    if (!d) return '<div class="hvital"><label>Disk</label><div class="hv">—</div></div>';
    const used = d.total - d.free, pct = used / d.total * 100, low = d.free * 1048576 < 15e9 || pct > 95;
    return `<div class="hvital${low ? ' hlow' : ''}" title="Startup disk. Finder may show a little more free: it counts space macOS can purge"><label>Disk</label>
      <div class="hv">${gb(used)}<small> / ${gb(d.total)}</small></div><div class="hmeter"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="hvital-foot">${gb(d.free)} free</div></div>`;
  }
  // Speeds in bytes per second, decimal like Activity Monitor
  const rate = n => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1000 && i < 3) { n /= 1000; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}/s`; };
  function netTile(n) {
    if (!n) return '<div class="hvital"><label>Network</label><div class="hv">—</div></div>';
    const ips = [n.lan && `LAN ${n.lan}`, n.tailscale && `Tailscale ${n.tailscale}`].filter(Boolean).join(' · ');
    return `<div class="hvital hnet"><label>Network · ${esc(n.iface)}</label>
      <div class="hv"><span class="down">↓ ${rate(n.rx)}</span><small> ↑ ${rate(n.tx)}</small></div>
      <div class="hnet-foot"><span class="trunc" title="${esc(ips)}">${esc(ips)}</span><button class="link-btn" onclick="DevDockViews.home.talkers()">Who's using it</button></div>
      ${sparkline(n.rxSpark, { color: 'var(--green)', w: 120, h: 26 })}</div>`;
  }
  // One nettop sample, on demand (see sources/home.js talkers)
  let talk = null, talkBusy = false;
  function talkersHTML() {
    if (!talk && !talkBusy) return '';
    if (!talk) return '<section class="htalk"><header><h3>Who\'s using the network</h3><span>Measuring for a second…</span></header></section>';
    const max = Math.max(1, ...talk.apps.map(a => a.rx + a.tx));
    return `<section class="htalk"><header><h3>Who's using the network</h3><span>right now · ${talkBusy ? 'measuring…' : `<button class="link-btn" onclick="DevDockViews.home.talkers()">measure again</button>`} · <button class="link-btn" onclick="DevDockViews.home.talkers(false)">close</button></span></header>
      ${talk.apps.length ? `<ul>${talk.apps.map(a => `<li><b class="trunc" title="PID ${esc(a.pids.join(', '))}">${esc(a.name)}</b>
        <span class="hbar"><i class="rx" style="width:${(a.rx / max * 100).toFixed(1)}%"></i><i class="tx" style="width:${(a.tx / max * 100).toFixed(1)}%"></i></span>
        <em><span class="down">↓ ${rate(a.rx)}</span> ↑ ${rate(a.tx)}</em></li>`).join('')}</ul>` : '<p class="hcap">Nothing is using the network right now.</p>'}</section>`;
  }

  function hero(items) {
    const v = data()?.vitals || {};
    const crit = items.filter(i => i.severity === 'critical').length, agentsWait = items.filter(i => i.severity === 'needs-you').length;
    const low = items.filter(i => i.severity === 'limit').length, wait = agentsWait + low;
    const tidy = items.filter(i => i.severity === 'tidy').length;
    const sev = crit ? 'critical' : wait ? 'needs-you' : tidy ? 'tidy' : 'clear';
    const n = crit + wait;
    const headline = crit || wait ? `${n} ${n > 1 ? 'things need' : 'thing needs'} you` : tidy ? 'Nothing urgent' : 'All clear';
    const parts = [
      ...['cpu', 'mem', 'crash'].map(t => [t, items.filter(i => i.type === t).length]).filter(([, c]) => c)
        .map(([t, c]) => `${c} ${{ cpu: 'runaway', mem: 'leaking', crash: 'crash-looping' }[t]}`),
      agentsWait && `${agentsWait} agent${agentsWait > 1 ? 's' : ''} waiting`,
      low && `${low} plan limit${low > 1 ? 's' : ''} running low`,
      !crit && !wait && tidy && `${tidy} thing${tidy > 1 ? 's' : ''} to tidy up`,
    ].filter(Boolean);
    const sub = parts.length ? parts.join(' · ') : `Watching ${v.servers || 0} servers and ${v.agents || 0} agents. Nothing needs you.`;
    const mc = v.machine || {}, memPct = Math.min(100, (mc.mem || 0) / (v.totalMem || 1) * 100);
    const meter = pct => `<div class="hmeter"><i style="width:${pct.toFixed(1)}%"></i></div>`;
    return `
      <section class="hhero sev-${sev}">
        <div class="horb">${sev === 'clear' ? ICON.check : `<span>${n || tidy}</span>`}</div>
        <div class="hhead"><h2>${headline}</h2><p>${esc(sub)}</p></div>
        <div class="hvitals">
          <div class="hvital" title="The whole Mac, like Activity Monitor's CPU load"><label>CPU</label><div class="hv">${mc.cpu == null ? '—' : `${Math.round(mc.cpu)}<small>% of ${v.cores || '?'} cores</small>`}</div>${meter(mc.cpu || 0)}${sparkline(mc.cpuSpark, { color: 'var(--accent)', w: 120, h: 26 })}
            <div class="hvital-foot" title="Your servers and coding agents, including what they started">servers + agents: ${((v.cpu || 0) / 100).toFixed(1)} cores</div></div>
          <div class="hvital" title="The whole Mac: Activity Monitor's app memory + wired + compressed. Cached files aren't counted: macOS frees them on demand"><label>Memory</label><div class="hv">${mc.mem == null ? '—' : `${formatMem(mc.mem)}<small> / ${formatMem(v.totalMem || 0)}</small>`}</div>${meter(memPct)}${sparkline(mc.memSpark, { color: 'var(--accent)', w: 120, h: 26 })}
            <div class="hvital-foot" title="Your servers and coding agents, including what they started">servers + agents: ${formatMem(v.mem || 0)}</div></div>
          ${diskTile(mc.disk)}
          <div class="hvital"><label>Agents · servers</label><div class="hv">${v.agents || 0}<small> agents · ${v.servers || 0} servers</small></div>
            <div class="hagents">${v.working ? `<span class="ast-working">${STATE_ICON.working}${v.working} working</span>` : ''}${v.needsYou ? `<span class="ast-needs-you">${STATE_ICON['needs-you']}${v.needsYou} waiting</span>` : ''}${v.unknown ? `<span title="Only Claude Code reports whether it's working">${v.unknown} state unknown</span>` : ''}${!v.working && !v.needsYou && !v.unknown ? '<span>all idle</span>' : ''}</div></div>
          ${netTile(v.net)}
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
      ${talkersHTML()}
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
    const crit = items.filter(i => i.severity === 'critical').length, wait = items.filter(i => i.severity === 'needs-you' || i.severity === 'limit').length;
    tab.dataset.alert = crit ? 'critical' : wait ? 'needs-you' : '';
    tab.title = `Home${crit + wait ? ` · ${crit + wait} need${crit + wait > 1 ? '' : 's'} you` : ''}  ⌘1`;
  }
  // One notification per plan window running low (the item id carries the window's reset time)
  let told = {};
  try { told = JSON.parse(localStorage.getItem('devdock:limit-told') || '{}'); } catch {}
  function tellLimits() {
    if (!currentSettings?.notifications) return;
    for (const it of (data()?.items || []).filter(i => i.type === 'limit' && !told[i.id])) {
      told[it.id] = it.resetsAt || Date.now() + 7 * 864e5;
      notify(`${it.tool}: ${Math.max(0, Math.round(100 - it.used))}% of the ${it.label.toLowerCase()} limit left`, it.resetsAt ? `Resets in ${dur(it.resetsAt - Date.now())}` : 'Running low');
    }
    for (const k in told) if (told[k] < Date.now()) delete told[k];
    try { localStorage.setItem('devdock:limit-told', JSON.stringify(told)); } catch {}
  }
  document.addEventListener('devdock:source', e => { if (e.detail === 'home') { badge(); tellLimits(); } });

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
    async talkers(open = true) {
      if (!open) { talk = null; return render(); }
      talkBusy = true; render();
      const r = await sourceAction('home', 'talkers');
      talkBusy = false; if (r) talk = r; render();
    },
    unsnooze() { snoozed = {}; try { localStorage.removeItem('devdock:home-snooze'); } catch {} render(); badge(); },
    async stopContainer(id, name) {
      if (!await confirmDialog(`Stop container ${name}?`, 'It stays on disk; start it again from Containers.', 'Stop')) return;
      if (await sourceAction('containers', 'stop', { id })) showToast(`Stopped ${name}`);
    },
  };
})();

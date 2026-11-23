// Machines tab: servers running devdock-agent, from sources/machines.js.
// A card per machine (your name, emoji or picture, colour), a sheet to add one with the
// scope you choose, and a page per machine with the same tabs as DevDock: Overview (what
// needs you, like Home), Processes, Ports, Containers, Terminal and Settings.
(function () {
  const view = document.getElementById('machinesView');
  const svg = (d, s = 16, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICON = {
    plus: svg('<path d="M12 5v14M5 12h14"/>', 14),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 13),
    term: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', 13),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 14),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 13, 'stroke-width="2.6"'),
    warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 13),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 13),
    key: svg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>', 13),
    net: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 13),
    eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 13),
    finger: svg('<path d="M12 11v3a7 7 0 0 1-1.5 4.3"/><path d="M8.5 7.5A4.5 4.5 0 0 1 16.5 10v2.5a11 11 0 0 1-.8 4.1"/><path d="M5.5 9a7 7 0 0 1 13.4-1.5"/><path d="M8 12v1a10 10 0 0 1-1.4 5.2"/><path d="M19.8 13a15 15 0 0 1-.9 4.3"/>', 12),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 11),
    play: svg('<path d="M7 5v14l11-7z"/>', 11),
    redo: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', 11),
    hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>', 13),
    back: svg('<path d="m15 18-6-6 6-6"/>', 16, 'stroke-width="2.4"'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 11),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', 13),
    server: svg('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>', 28),
  };
  const COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#22d3ee', '#fb7185', '#94a3b8'];
  const SCOPES = [
    ['system', 'System', 'CPU, memory, disks, network speed, and host details like OS and model', true],
    ['processes', 'Processes', 'The 20 busiest processes and who runs them', true],
    ['ports', 'Listening ports', 'Which ports are open and what holds them', true],
    ['containers', 'Containers', 'Docker containers and their usage. Needs Docker access, which is root-level on most machines', false],
    ['actions', 'Actions', 'Stop processes; start, stop and restart containers. Each one asks for Touch ID on this Mac, and the machine checks it', false],
  ];
  const DISTRO = { ubuntu: '#e95420', debian: '#a80030', fedora: '#51a2da', alpine: '#0d597f', arch: '#1793d1', macos: '#a3a3a3', centos: '#932279', rocky: '#10b981', raspbian: '#c51a4a', nixos: '#7ebae4' };

  const data = () => DevDock.sourceData.machines || { machines: [] };
  const byId = id => data().machines.find(m => m.id === id);
  let openId = null;     // the machine page
  const muxes = {};      // id -> { loading, sessions, error } over SSH
  let adding = null;     // add sheet state: { step, id, command }

  const pct = (a, b) => b ? Math.min(100, a / b * 100) : 0;
  const bytes = n => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`; };
  const rate = n => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1000 && i < 3) { n /= 1000; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}/s`; };
  const dur = s => { const m = Math.floor(s / 60); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };

  function avatar(m, size = 40) {
    const inner = m.picture ? `<img src="/api/machines/${m.id}/picture?v=${m.picture}" alt="">`
      : m.emoji ? `<span class="memoji">${esc(m.emoji)}</span>` : ICON.server.replace(/width="28" height="28"/, `width="${size * .5}" height="${size * .5}"`);
    return `<span class="mavatar" style="--mc:${m.color};width:${size}px;height:${size}px">${inner}</span>`;
  }
  // a ring meter: value 0-100
  function ring(v, label, color, size = 54) {
    const r = size / 2 - 5, c = 2 * Math.PI * r, warn = v >= 90 ? 'var(--red)' : v >= 75 ? 'var(--yellow)' : color;
    return `<div class="mring" title="${label} ${Math.round(v)}%"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border-row)" stroke-width="5"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${warn}" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="${(v / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
      <b>${Math.round(v)}<small>%</small></b><span>${label}</span></div>`;
  }
  const rootDisk = s => (s?.disks || []).find(d => d.mount === '/') || s?.disks?.[0];
  const netTotal = s => (s?.net || []).reduce((n, i) => ({ rx: n.rx + i.rx, tx: n.tx + i.tx }), { rx: 0, tx: 0 });
  const statusPill = m => ({
    online: '<span class="mstatus on"><i></i>Online</span>',
    offline: `<span class="mstatus off" title="${esc(m.error || '')}"><i></i>Offline${m.lastSeen ? ` · ${timeAgo(m.lastSeen)}` : ''}</span>`,
    pending: '<span class="mstatus wait"><i></i>Waiting</span>',
    confirm: '<span class="mstatus wait"><i></i>Check its key</span>',
    untrusted: `<span class="mstatus bad" title="${esc(m.error || '')}"><i></i>Key changed</span>`,
  })[m.status] || '';
  const layersOn = m => [true, true, m.networks !== 'any', true, true].filter(Boolean).length;

  function card(m) {
    const s = m.snap, h = s?.host;
    if (m.status === 'pending') return `
      <article class="mcard pending" style="--mc:${m.color}" onclick="DevDockViews.machines.openAdd('${m.id}')">
        <header>${avatar(m)}<div class="mtitle"><b>${esc(m.name)}</b><span>${esc(m.host)}:${m.port}</span></div>${statusPill(m)}</header>
        <div class="mradar"><i></i><i></i><i></i><span>${esc(m.note || 'Waiting for the agent…')}</span></div>
        <footer><span>Run the install command on ${esc(m.host)}</span><span class="link">Show command →</span></footer>
      </article>`;
    if (m.status === 'confirm') return `
      <article class="mcard pending" style="--mc:${m.color}" onclick="DevDockViews.machines.openAdd('${m.id}')">
        <header>${avatar(m)}<div class="mtitle"><b>${esc(m.name)}</b><span>${esc(m.host)}:${m.port}</span></div>${statusPill(m)}</header>
        <div class="mkey">${esc(m.keyCode)}</div>
        <footer><span>Does the install show this key?</span><span class="link">Check →</span></footer>
      </article>`;
    const d = rootDisk(s), n = netTotal(s);
    return `
      <article class="mcard ${m.status}" style="--mc:${m.color}" onclick="DevDockViews.machines.open('${m.id}')">
        <header>${avatar(m)}<div class="mtitle"><b>${esc(m.name)}</b><span>${esc(h ? h.hostname : m.host)}${h?.distro ? ` · ${esc(h.distro)}` : ''}</span></div>${statusPill(m)}</header>
        ${(m.items || []).filter(i => i.type !== 'offline').length ? `<div class="missues sev-${m.items.some(i => i.severity === 'critical') ? 'critical' : 'tidy'}">${ICON.warn}${m.items.filter(i => i.type !== 'offline').map(i => ({ cpu: 'Runaway CPU', mem: 'Memory leak', crash: 'Crash loop', disk: 'Disk filling', pressure: 'Out of memory', busy: 'CPU saturated' })[i.type]).join(' · ')}</div>` : ''}
        ${s ? `<div class="mrings">${ring(s.cpu?.usage || 0, 'CPU', 'var(--accent)')}${ring(s.mem ? pct(s.mem.used, s.mem.total) : 0, 'Memory', '#a78bfa')}${ring(d ? pct(d.used, d.total) : 0, 'Disk', '#34d399')}
          <div class="mnet"><span class="down">↓ ${rate(n.rx)}</span><span>↑ ${rate(n.tx)}</span>${sparkline(m.spark?.cpu, { color: 'var(--accent)', w: 96, h: 28 })}</div></div>`
        : `<div class="mempty">${m.status === 'untrusted' ? 'DevDock stopped talking to it: its key isn\'t the one you paired.' : esc(m.error || 'No data yet')}</div>`}
        <footer>
          <span>${h ? `${h.cores} cores · ${bytes(h.memTotal)} · up ${dur(s.uptime)}` : ''}</span>
          <span class="mshield" title="${layersOn(m)} of 5 security layers on">${ICON.shield}${s?.version ? `v${esc(s.version)}` : ''}</span>
        </footer>
      </article>`;
  }

  function render() {
    const d = data();
    const list = d.machines;
    const on = list.filter(m => m.status === 'online').length;
    document.getElementById('viewStats').innerHTML = list.length
      ? `<div class="stat"><span class="stat-value">${on}/${list.length}</span><span class="stat-label">online</span></div>` : '';
    document.getElementById('viewTools').innerHTML = `<button class="btn-primary madd" onclick="DevDockViews.machines.openAdd()">${ICON.plus}Add machine</button>`;
    if (adding) renderAdd();
    const m = openId && byId(openId);
    if (openId && !m) openId = null;
    if (m) {
      // typing in a field: don't redraw under the cursor; the next scan catches up
      if (view.contains(document.activeElement) && document.activeElement.matches('input')) return;
      document.getElementById('viewStats').innerHTML = '';
      document.getElementById('viewTools').innerHTML = '';
      setViewResult(0, 0);
      view.innerHTML = page(m);
      return;
    }
    const q = searchInput.value.trim().toLowerCase();
    const shown = list.filter(m => !q || [m.name, m.host, m.snap?.host?.distro, m.snap?.host?.hostname].join(' ').toLowerCase().includes(q));
    setViewResult(shown.length, list.length);
    view.innerHTML = !DevDock.sourceData.machines ? '<div class="empty-view">Loading…</div>'
      : list.length ? `<div class="mgrid">${shown.map(card).join('')}</div>` : emptyHTML();
  }

  function emptyHTML() {
    return `<section class="mhero">
      <div class="mhero-art">${ICON.server}</div>
      <h2>Bring your servers into DevDock</h2>
      <p>A 7 MB agent with no UI shares what you choose from each machine: vitals, processes, ports, containers.</p>
      <ol class="msteps"><li><b>1</b>Pick what it may share</li><li><b>2</b>Run one command there</li><li><b>3</b>It appears here, paired</li></ol>
      <div class="mchips"><span>${ICON.key}Paired to this Mac only</span><span>${ICON.lock}Encrypted both ways</span><span>${ICON.net}Private networks only</span><span>${ICON.eye}Read-only</span></div>
      <button class="btn-primary madd big" onclick="DevDockViews.machines.openAdd()">${ICON.plus}Add your first machine</button>
    </section>`;
  }

  // ── Add a machine ──────────────────────────────────────────────────
  function sheet(id, body) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'modal-overlay msheet-overlay';
      el.addEventListener('mousedown', e => { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    // keep what the user typed across live re-renders
    const keep = [...el.querySelectorAll('input[name]')].map(i => [i.name, i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value, i.value]);
    el.innerHTML = `<div class="modal msheet">${body}</div>`;
    for (const [name, v, val] of keep) {
      const i = el.querySelector(`input[name="${name}"]${typeof v === 'boolean' ? `[value="${val}"]` : ''}`);
      if (i) typeof v === 'boolean' ? (i.checked = v) : (i.value = v);
    }
    return el;
  }
  function close() {
    adding = null;
    document.querySelectorAll('.msheet-overlay').forEach(e => e.remove());
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || DevDock.tab !== 'machines' || document.querySelector('.modal-overlay[style*="flex"]:not(.msheet-overlay)')) return;
    if (adding) close();
    else if (openId && !e.target.matches('input')) DevDockViews.machines.back();
  });

  function renderAdd() {
    const m = adding.id && byId(adding.id);
    if (adding.id && !m) return close();
    if (m?.status === 'confirm') return sheet('maddSheet', `
      <div class="modal-header"><div class="modal-title">Check ${esc(m.name)}'s key</div><button class="modal-close" onclick="DevDockViews.machines.close()">&times;</button></div>
      <p class="msub">An agent answered with the pairing code. The install on ${esc(m.host)} printed its key as it finished: pair only if it's this one.</p>
      <div class="mkey big">${esc(m.keyCode)}</div>
      <p class="msub">If it differs, something else on the network or on that machine answered first. DevDock forgets it, and you can start over.</p>
      <div class="modal-footer"><button class="hbtn danger" onclick="DevDockViews.machines.confirm('${m.id}', false)">It doesn't match</button>
        <button class="btn-primary" onclick="DevDockViews.machines.confirm('${m.id}', true)">${ICON.check}It matches</button></div>`);
    if (m && m.status !== 'pending') { // paired while the sheet was open
      return sheet('maddSheet', `<div class="mdone">${avatar(m, 64)}<div class="mdone-check">${ICON.check}</div>
        <h2>${esc(m.name)} is paired</h2><p>Only this Mac can talk to it, over an encrypted link, and it shares only what you picked.</p>
        <button class="btn-primary" onclick="DevDockViews.machines.close();DevDockViews.machines.open('${m.id}')">Open ${esc(m.name)}</button></div>`);
    }
    if (m) return sheet('maddSheet', `
      <div class="modal-header"><div class="modal-title">Install on ${esc(m.host)}</div><button class="modal-close" onclick="DevDockViews.machines.close()">&times;</button></div>
      <p class="msub">Run this on ${esc(m.host)}. It downloads the agent, sets it up as a locked-down service, and DevDock pairs with it on its own.</p>
      <div class="mcmd"><code>${esc(m.command)}</code></div>
      <div class="mrow">
        <button class="btn-primary" onclick="copyText(DevDockViews.machines.cmd('${m.id}'), 'Install command')">${ICON.copy}Copy command</button>
        <button class="hbtn" onclick="DevDockViews.machines.ssh('${m.id}')" title="Opens ssh ${esc(m.host)} in DevDock and runs it there; sudo asks for your password">${ICON.term}Run over SSH</button>
      </div>
      <div class="mwait"><div class="mradar small"><i></i><i></i><i></i></div><div><b>${esc(m.note || 'Waiting for the agent…')}</b><span>Checking ${esc(m.host)}:${m.port} every few seconds. The code in this command works once, for an hour.</span></div></div>
      <details class="mwhy"><summary>${ICON.shield}What this command does</summary><ul>
        <li><b>--master</b> is this Mac's key fingerprint. The agent will accept nobody else.</li>
        <li><b>t</b> is a one-time code. It goes to the installer on its input, never on a command line other users could read. The agent proves it has it when pairing.</li>
        <li>The installer must match the one inside this DevDock, and it only installs an agent signed with DevDock's release key.</li>
        <li>When it's done it prints the agent's key. DevDock shows you the same key before it trusts the machine.</li>
        <li><b>--scope</b> is what it may share. Only root on that machine can widen it later, never DevDock.</li>
        <li>It runs as its own user, with no privileges and a 64 MB memory cap.</li></ul></details>
      <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.remove('${m.id}')">Cancel and forget it</button></div>`);
    sheet('maddSheet', `
      <div class="modal-header"><div class="modal-title">Add a machine</div><button class="modal-close" onclick="DevDockViews.machines.close()">&times;</button></div>
      <label class="mfield"><span>Where is it?</span><input name="host" placeholder="nas.local, 192.168.1.20 or a Tailscale name" autocomplete="off" spellcheck="false" autofocus></label>
      <div class="mfields2"><label class="mfield"><span>Name</span><input name="name" placeholder="optional" maxlength="40"></label>
        <label class="mfield"><span>Port</span><input name="port" value="7337" inputmode="numeric"></label></div>
      <h4 class="mh">What it may share <em>recommended choices are ticked</em></h4>
      <div class="mscopes">${SCOPES.map(([k, label, hint, rec]) => `<label class="mscope"><input type="checkbox" name="scope-${k}" value="1" ${rec ? 'checked' : ''}><span><b>${label}${k === 'containers' ? ` <i class="mwarn">${ICON.warn}root-level</i>` : k === 'actions' ? ` <i class="mtid">${ICON.finger}Touch ID</i>` : ''}</b><small>${hint}</small></span></label>`).join('')}
        <label class="mscope off"><input type="checkbox" disabled><span><b>Terminal</b><small>A shell on the machine, opened with Touch ID. Coming soon.</small></span></label></div>
      <h4 class="mh">Who may connect</h4>
      <div class="mscopes two"><label class="mscope"><input type="radio" name="networks" value="private" checked><span><b>Private networks</b><small>Your LAN and Tailscale. Recommended.</small></span></label>
        <label class="mscope"><input type="radio" name="networks" value="any"><span><b>Any network</b><small>Still only this Mac's key gets in, but the port is reachable from anywhere.</small></span></label></div>
      <div class="mlayers">${ICON.key}Paired to this Mac ${ICON.lock}TLS 1.3 both ways ${ICON.eye}Read-only ${ICON.hand}Root decides the scope</div>
      <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.close()">Cancel</button><button class="btn-primary" onclick="DevDockViews.machines.create()">Create install command</button></div>`);
  }

  // ── One machine: a page with the same tabs as DevDock itself ───────
  const TABS = [
    ['overview', 'Overview'], ['processes', 'Processes', 'processes'], ['ports', 'Ports', 'ports'],
    ['containers', 'Containers', 'containers'], ['sessions', 'Terminal'], ['settings', 'Settings'],
  ];
  let mtab = 'overview';
  try { mtab = localStorage.getItem('devdock:machine-tab') || mtab; } catch {}
  const tabsOf = m => TABS.filter(([, , need]) => !need || m.scope?.[need]);

  const SEV = { critical: 'critical', warning: 'tidy' }; // reuse Home's colours
  function issue(m, it) {
    const s = it.subject || {};
    const card = (kicker, title, viz, actions = '') => `<article class="hcard sev-${SEV[it.severity]}"><div class="hcard-main">
      <div class="hcard-kicker">${ICON.warn}<span>${kicker}</span>${it.since ? `<em>for ${dur((Date.now() - it.since) / 1000)}</em>` : ''}</div>
      <div class="hcard-title">${title}</div>${actions ? `<div class="hcard-actions">${actions}</div>` : ''}</div>${viz ? `<div class="hcard-viz">${viz}</div>` : ''}</article>`;
    const stop = m.scope?.actions ? actBtn(m, 'process-stop', s.pid, s.name, 'hbtn danger', `${ICON.stop}Stop`) : '';
    const line = (v, color, cap) => `<div class="hval">${v}</div>${sparkline(it.spark, { color })}<div class="hcap">${cap}</div>`;
    switch (it.type) {
      case 'offline': return card('Not answering', `<b>${esc(m.name)}</b> last answered ${timeAgo(it.since)}`, '', `<span class="hcap">${esc(it.error || '')}</span>`);
      case 'cpu': return card('Runaway CPU', `<b>${esc(s.name)}</b> (${esc(s.user)}) is pinning ${(it.value / 100).toFixed(1)} cores`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--red)', 'last 15 min'), stop);
      case 'mem': return card('Memory leak', `<b>${esc(s.name)}</b> keeps growing, +${formatMem(it.rate)} a minute`, line(formatMem(it.value), 'var(--red)', `${formatMem(it.from)} → ${formatMem(it.value)}`), stop);
      case 'crash': return card('Crash loop', `Container <b>${esc(s.name)}</b> keeps restarting`, '', m.scope?.actions ? actBtn(m, 'container-stop', s.id, s.name, 'hbtn danger', `${ICON.stop}Stop it`) : '');
      case 'disk': return card(it.severity === 'critical' ? 'Disk almost full' : 'Disk filling up', `<b>${esc(s.mount)}</b> is ${Math.round(it.value)}% full, ${bytes(it.free)} left`, `<div class="hval">${Math.round(it.value)}<small>%</small></div>`);
      case 'pressure': return card('Out of memory', `Memory has been over 90% for 5 minutes`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--red)', 'last 5 min'));
      case 'busy': return card('CPU saturated', `All cores have been over 90% busy for 5 minutes`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--yellow)', 'last 5 min'));
    }
    return '';
  }

  function overview(m) {
    const s = m.snap, h = s?.host || {}, items = m.items || [];
    const crit = items.filter(i => i.severity === 'critical').length;
    const sev = crit ? 'critical' : items.length ? 'tidy' : 'clear';
    const headline = items.length ? `${items.length} ${items.length > 1 ? 'things need' : 'thing needs'} you` : m.status === 'online' ? 'All clear' : 'Not answering';
    const sub = items.length ? items.map(i => ({ offline: 'offline', cpu: 'runaway CPU', mem: 'memory leak', crash: 'crash loop', disk: 'disk filling', pressure: 'out of memory', busy: 'CPU saturated' })[i.type]).join(' · ')
      : s ? `Watching ${s.processes?.length || 0} processes${s.containers ? `, ${s.containers.length} containers` : ''} and ${s.disks?.length || 0} disk${s.disks?.length === 1 ? '' : 's'}.` : esc(m.error || '');
    const meter = p => `<div class="hmeter"><i style="width:${p.toFixed(1)}%;${p >= 90 ? 'background:var(--red)' : ''}"></i></div>`;
    const d = rootDisk(s), n = netTotal(s);
    const vitals = s ? `<div class="hvitals">
      <div class="hvital"><label>CPU</label><div class="hv">${Math.round(s.cpu?.usage || 0)}<small>% of ${h.cores} cores</small></div>${meter(s.cpu?.usage || 0)}${sparkline(m.spark?.cpu, { color: 'var(--accent)', w: 120, h: 26 })}</div>
      <div class="hvital"><label>Memory</label><div class="hv">${bytes(s.mem?.used || 0)}<small> / ${bytes(s.mem?.total || 0)}</small></div>${meter(pct(s.mem?.used, s.mem?.total))}${sparkline(m.spark?.mem, { color: '#a78bfa', w: 120, h: 26 })}</div>
      <div class="hvital"><label>Disk ${d ? esc(d.mount) : ''}</label><div class="hv">${d ? bytes(d.used) : '–'}<small>${d ? ` / ${bytes(d.total)}` : ''}</small></div>${meter(d ? pct(d.used, d.total) : 0)}<div class="hcap">${d ? `${bytes(d.total - d.used)} free` : ''}</div></div>
      <div class="hvital"><label>Network</label><div class="hv"><span class="down">↓ ${rate(n.rx)}</span></div><div class="hcap">↑ ${rate(n.tx)}</div>${sparkline(m.spark?.rx, { color: 'var(--green)', w: 120, h: 26 })}</div>
    </div>` : '';
    const ips = (s?.net || []).flatMap(i => (i.addrs || []).filter(a => !a.startsWith('fe80')).map(a => `${esc(a.split('/')[0])} <em>${esc(i.name)}</em>`));
    const about = [['System', h.distro], ['Kernel', h.kernel && `${h.kernel} · ${h.arch}`], ['Processor', h.cpuModel && `${h.cpuModel} · ${h.cores} cores`],
      ['Memory', h.memTotal && bytes(h.memTotal)], ['Runs on', { bare: 'Hardware', vm: 'Virtual machine', container: 'Container' }[h.virt]], ['Model', h.model],
      ['Up for', s && dur(s.uptime)], ['Agent', s?.version && `v${s.version}`]].filter(([, v]) => v);
    return `<section class="hhero sev-${sev}">
        <div class="horb">${sev === 'clear' ? ICON.check.replace('width="13" height="13"', 'width="30" height="30"') : `<span>${items.length || '!'}</span>`}</div>
        <div class="hhead"><h2>${headline}</h2><p>${sub}</p></div>${vitals}</section>
      ${items.length ? `<div class="hgrid">${items.map(it => issue(m, it)).join('')}</div>` : ''}
      <div class="mcols2">
        ${about.length ? `<section class="mgroup"><h4>About</h4><dl class="mfacts">${about.map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join('')}${ips.length ? `<dt>Addresses</dt><dd>${ips.join('<br>')}</dd>` : ''}</dl></section>` : ''}
        ${s?.disks?.length ? `<section class="mgroup"><h4>Storage</h4>${s.disks.map(d => `<div class="mdisk"><span class="trunc">${esc(d.mount)}</span><span class="hbar"><i style="width:${pct(d.used, d.total).toFixed(1)}%;background:${pct(d.used, d.total) > 90 ? 'var(--red)' : '#34d399'}"></i></span><em>${bytes(d.total - d.used)} free</em></div>`).join('')}</section>` : ''}
      </div>
      ${s?.errors?.length ? `<p class="hcap">Couldn't read: ${esc(s.errors.join('; '))}</p>` : ''}`;
  }

  // row buttons for a signed action; nothing when the machine is read-only
  // Machine data never goes inside inline JS: a process on a server can be named x');evil();('
  // and esc() quotes come back as quotes before an onclick runs. Values ride in data-*.
  const actBtn = (m, action, target, label, cls, content, title = '') => `<button class="${cls}" title="${esc(title)}" data-id="${m.id}" data-a="${action}"
    data-t="${esc(String(target ?? ''))}" data-l="${esc(String(label ?? ''))}" onclick="DevDockViews.machines.act(this)">${content}</button>`;
  const act = (m, list, target, label) => !m.scope?.actions || m.status !== 'online' ? '<td></td>'
    : `<td class="macts">${list.map(([a, ic, t]) => actBtn(m, a, target, label, 'micon', ic, `${t} ${label} (Touch ID)`)).join('')}</td>`;
  const matches = (q, ...f) => !q || q.split(/\s+/).every(w => f.join(' ').toLowerCase().includes(w));
  // Click a header to sort by it; again to flip. Numbers start biggest first.
  const msort = {};
  const val = (o, k) => k === 'net' ? (o.rx || 0) + (o.tx || 0) : o[k] ?? '';
  const sorted = list => {
    const st = msort[mtab];
    if (!st) return list;
    return [...list].sort((a, b) => {
      const x = val(a, st.k), y = val(b, st.k);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * st.dir;
    });
  };
  const th = h => {
    if (!h[2]) return `<th class="${h[1] || ''}">${h[0]}</th>`;
    const st = msort[mtab], on = st?.k === h[2];
    return `<th class="${h[1] || ''} sortable ${on ? `sorted ${st.dir > 0 ? 'asc' : 'desc'}` : ''}" onclick="DevDockViews.machines.sort('${h[2]}', ${h[1] === 'num'})">${h[0]}</th>`;
  };
  const table = (head, rows, empty) => rows.length ? `<div class="mtable-wrap"><table class="mtable"><thead><tr>${head.map(th).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="empty-view">${empty}</div>`;

  // Pattern chips, the same ones the desktop tabs use: groups worth looking at together
  const stem = n => (String(n || '').toLowerCase().match(/^[a-z0-9]+/) || [''])[0];
  const MPAT = {
    processes: [p => p.name && { id: `n:${p.name}`, label: p.name, title: `${p.name} processes` },
      p => p.user && { id: `u:${p.user}`, label: `user ${p.user}`, title: `Run by ${p.user}`, min: 3 }],
    ports: [p => p.name && { id: `n:${p.name}`, label: p.name, title: `Ports ${p.name} listens on` }],
    containers: [c => c.project && { id: `p:${c.project}`, label: c.project, title: `Compose project ${c.project}` },
      c => stem(c.name).length >= 3 && { id: `s:${stem(c.name)}`, label: `${stem(c.name)}…`, title: `Containers named ${stem(c.name)}…`, min: 3 },
      c => c.image && { id: `i:${c.image}`, label: c.image.replace(/:[^:/]*$/, '').split('/').pop(), title: `Containers from ${c.image}`, min: 3 },
      c => c.state !== 'running' && { id: 'stopped', label: 'not running', title: 'Stopped or exited containers' }],
  };
  const MKEY = { processes: p => `p:${p.pid}`, ports: p => `${p.port}/${p.proto}`, containers: c => c.id };
  function chips(all) {
    const scope = `machines:${mtab}`, seen = new Set();
    // "book" as a project and as a name stem is one group, not two chips
    const groups = DevDockPatterns.find(scope, all, MKEY[mtab], MPAT[mtab]).filter(g => !seen.has(g.keys.join()) && seen.add(g.keys.join()));
    const pick = list => DevDockPatterns.filter(scope, list, MKEY[mtab]);
    return { pick, html: groups.length ? `<div class="patterns mpatterns">${DevDockPatterns.html(scope, groups)}${DevDockPatterns.on(scope) ? `<span class="subbar-count">${pick(all).length} of ${all.length}</span>` : ''}</div>` : '' };
  }

  function tabBody(m, q) {
    const s = m.snap;
    if (mtab === 'overview') return overview(m);
    if (mtab === 'settings') return settingsHTML(m);
    if (mtab === 'sessions') return termHTML(m);
    if (!s) return `<div class="empty-view">${esc(m.error || 'No data yet')}</div>`;
    if (mtab === 'processes') {
      const max = Math.max(100, ...s.processes.map(p => p.cpu));
      const ch = chips(s.processes);
      const rows = sorted(ch.pick(s.processes)).filter(p => matches(q, p.name, p.user, p.pid)).map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.user)}</td><td class="num dim">${p.pid}</td>
        <td class="num"><span class="mcpu"><span class="mcpubar"><i style="width:${(p.cpu / max * 100).toFixed(1)}%"></i></span>${p.cpu.toFixed(1)}%</span></td>
        <td class="mspark">${sparkline(m.procSpark?.[p.pid], { color: 'var(--accent)', w: 80, h: 20 })}</td><td class="num">${bytes(p.mem)}</td>${act(m, [['process-stop', ICON.stop, 'Stop'], ['process-kill', ICON.close, 'Force quit']], p.pid, p.name)}</tr>`);
      return ch.html + table([['Process', '', 'name'], ['User', '', 'user'], ['PID', 'num', 'pid'], ['CPU', 'num', 'cpu'], ['Last 15 min'], ['Memory', 'num', 'mem'], ['']], rows, 'No processes match') + '<p class="hcap mnote">The 20 busiest processes, refreshed every 3 seconds.</p>';
    }
    if (mtab === 'ports') {
      const ch = chips(s.ports);
      const rows = sorted(ch.pick([...s.ports].sort((a, b) => a.port - b.port))).filter(p => matches(q, p.port, p.name, p.pid))
        .map(p => `<tr><td class="num mono"><b>${p.port}</b></td><td>${esc(p.name || '–')}</td><td class="num dim">${p.pid || ''}</td><td class="dim">${esc(p.proto)}</td></tr>`);
      return ch.html + table([['Port', 'num', 'port'], ['Process', '', 'name'], ['PID', 'num', 'pid'], ['Protocol', '', 'proto']], rows, 'Nothing listening matches');
    }
    if (mtab === 'containers') {
      if (!s.containers) return `<div class="empty-view">${esc((s.errors || []).find(e => /docker/i.test(e)) || 'No Docker here')}</div>`;
      const ch = chips(s.containers);
      const rows = sorted(ch.pick(s.containers)).filter(c => matches(q, c.name, c.image, c.state, c.project)).map(c => {
        const on = c.state === 'running';
        return `<tr><td><b>${esc(c.name)}</b>${c.project ? `<div class="dim small">${esc(c.project)}</div>` : ''}</td><td class="dim"><span class="mimg" title="${esc(c.image)}">${esc(c.image)}</span></td>
          <td><span class="mstate ${esc(c.state)}">${esc(c.state)}</span><div class="dim small">${esc(c.status)}</div></td>
          <td class="num">${on ? c.cpu.toFixed(1) + '%' : ''}</td><td class="num">${on ? bytes(c.mem) : ''}</td><td class="num dim">${on ? `↓ ${rate(c.rx)}<br>↑ ${rate(c.tx)}` : ''}</td>
          ${act(m, on ? [['container-restart', ICON.redo, 'Restart'], ['container-stop', ICON.stop, 'Stop']] : [['container-start', ICON.play, 'Start']], c.id, c.name)}</tr>`;
      });
      return ch.html + table([['Container', '', 'name'], ['Image', '', 'image'], ['State', '', 'state'], ['CPU', 'num', 'cpu'], ['Memory', 'num', 'mem'], ['Network', 'num', 'net'], ['']], rows, 'No containers match');
    }
    return '';
  }

  // Terminal: your own SSH from this Mac, in DevDock's terminal. The agent plays no part.
  function termHTML(m) {
    const x = muxes[m.id] || {};
    const rows = (x.sessions || []).map(t => `<button class="mrowbtn" data-id="${m.id}" data-mux="${esc(t.mux)}" data-s="${esc(t.name)}" onclick="DevDockViews.machines.attach(this.dataset.id, this.dataset.mux, this.dataset.s)">
      <span class="mmux">${esc(t.mux)}</span><b>${esc(t.name)}</b><em>${t.windows} window${t.windows > 1 ? 's' : ''}${t.attached ? ' · attached elsewhere' : ''}</em><span class="link">Attach ›</span></button>`).join('');
    return `<section class="mgroup"><h4>Sessions <button class="link-btn" onclick="DevDockViews.machines.sessions('${m.id}')">Refresh</button></h4>
        <div class="mlist">${x.loading ? '<div class="mlistrow hcap">Looking for tmux and zellij sessions…</div>' : x.error ? `<div class="mlistrow hcap">${esc(x.error)}</div>`
          : rows || (x.sessions ? '<div class="mlistrow hcap">No tmux or zellij sessions</div>' : '')}
          <button class="mrowbtn" onclick="DevDockViews.machines.shell('${m.id}')"><span class="mmux">ssh</span><b>New shell</b><em>${esc(m.ssh || m.host)}</em><span class="link">Open ›</span></button></div></section>
      <section class="mgroup"><h4>Connect as</h4><div class="mlist"><label class="mlistrow"><input name="ssh" class="minline" value="${esc(m.ssh || '')}" placeholder="${esc(m.host)}" spellcheck="false"
        onchange="DevDockViews.machines.customize('${m.id}', {ssh: this.value.trim()}).then(() => DevDockViews.machines.sessions('${m.id}'))"></label></div>
        <p class="hcap mnote">Your own SSH from this Mac: user@host or a name from ~/.ssh/config. The agent can't open shells, so it can't be turned into one.</p></section>`;
  }

  function securityHTML(m) {
    const s = m.scope || {};
    const shared = SCOPES.filter(([k]) => s[k] && k !== 'actions').map(([, l]) => l).join(', ') || 'nothing';
    const layers = [
      [ICON.key, 'Paired to this Mac only', 'Its key and this Mac\'s are pinned to each other', true],
      [ICON.lock, 'Encrypted both ways', 'TLS 1.3, both sides prove who they are', true],
      [ICON.net, m.networks === 'any' ? 'Reachable from any network' : 'Private networks only', m.networks === 'any' ? 'Only this Mac\'s key gets in, but the port is open everywhere' : 'LAN and Tailscale; others dropped before TLS', m.networks !== 'any'],
      [ICON.eye, 'Shares ' + shared, 'Only root on the machine can change this', true],
      s.actions ? [ICON.finger, 'Actions need Touch ID', 'Signed in this Mac\'s Secure Enclave, checked by the machine', true] : [ICON.hand, 'Read-only', 'It can\'t stop anything', true],
    ];
    const lit = layers.filter(l => l[3]).length;
    return `<section class="mgroup"><h4>Security</h4><div class="mlist msec">
      <div class="mshield-big">${[0, 1, 2, 3, 4].map(i => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}${ICON.shield.replace(/width="14" height="14"/, 'width="30" height="30"')}<b>${lit}/5</b></div>
      <ul>${layers.map(([ic, t, d, ok]) => `<li class="${ok ? 'ok' : 'warn'}">${ok ? ICON.check : ICON.warn}<div><b>${esc(t)}</b><span>${esc(d)}</span></div></li>`).join('')}</ul></div></section>`;
  }

  function settingsHTML(m) {
    return `<div class="mcols2"><div>
      <section class="mgroup"><h4>Appearance</h4><div class="mlist">
        <div class="mlistrow mlook"><label class="mdpic" title="Change picture">${avatar(m, 56)}<input type="file" accept="image/png,image/jpeg,image/webp" onchange="DevDockViews.machines.pic('${m.id}', this.files[0])"></label>
          <div><input name="mname" class="minline big" value="${esc(m.name)}" maxlength="40" onchange="DevDockViews.machines.customize('${m.id}', {name: this.value})">
          <span class="hcap">${m.picture ? `<button class="link-btn" onclick="DevDockViews.machines.pic('${m.id}', null)">Remove picture</button>` : 'Click the icon to use a picture'}</span></div></div>
        <label class="mlistrow"><span>Emoji</span><input name="memoji" class="minline right" value="${esc(m.emoji || '')}" placeholder="None" maxlength="4" onchange="DevDockViews.machines.customize('${m.id}', {emoji: this.value})"></label>
        <div class="mlistrow"><span>Colour</span><span class="mswatches">${COLORS.map(c => `<button class="mswatch${c === m.color ? ' on' : ''}" style="background:${c}" aria-label="${c}" onclick="DevDockViews.machines.customize('${m.id}', {color: '${c}'})"></button>`).join('')}</span></div>
      </div></section>
      <section class="mgroup"><h4>Connection</h4><div class="mlist">
        <div class="mlistrow"><span>Address</span><span class="dim mono">${esc(m.host)}:${m.port}</span></div>
        <div class="mlistrow"><span>Paired</span><span class="dim">${m.pairedAt ? new Date(m.pairedAt).toLocaleDateString() : '–'}</span></div>
        <label class="mlistrow"><span>Pair again</span><input name="repair" class="minline right mono" placeholder="code from sudo devdock-agent pair" spellcheck="false"><button class="link-btn" onclick="DevDockViews.machines.repair('${m.id}')">Pair</button></label>
      </div></section>
      <section class="mgroup"><div class="mlist"><button class="mrowbtn danger" onclick="DevDockViews.machines.remove('${m.id}')">${ICON.trash}<b>Remove from DevDock</b></button></div></section>
    </div><div>${securityHTML(m)}</div></div>`;
  }

  function page(m) {
    const s = m.snap, h = s?.host, q = searchInput.value.trim().toLowerCase();
    const tabs = tabsOf(m);
    if (!tabs.some(([k]) => k === mtab)) mtab = 'overview';
    const count = { overview: (m.items || []).length || '', processes: s?.processes?.length, ports: s?.ports?.length, containers: s?.containers?.length };
    return `<div class="mpage" style="--mc:${m.color}">
      <header class="mphead">
        <button class="mback" onclick="DevDockViews.machines.back()" title="All machines  Esc">${ICON.back}Machines</button>
        <div class="mpid">${avatar(m, 44)}<div class="mtitle"><b>${esc(m.name)}</b><span>${esc(h?.hostname || m.host)}${h?.distro ? ` · ${esc(h.distro)}` : ''}${s ? ` · up ${dur(s.uptime)}` : ''}</span></div>${statusPill(m)}</div>
        <button class="hbtn" onclick="DevDockViews.machines.shell('${m.id}')">${ICON.term}Shell</button>
      </header>
      ${m.status === 'untrusted' ? `<div class="malert">${ICON.warn}<div><b>This machine's key changed.</b> DevDock stopped talking to it. If you reinstalled the agent, run <code>sudo devdock-agent pair</code> there and paste the code in Settings. If you didn't, someone may be posing as it.</div></div>` : ''}
      <nav class="mseg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === mtab}" onclick="DevDockViews.machines.tab('${k}')">${l}${count[k] ? `<span class="${k === 'overview' ? 'malertn' : ''}">${count[k]}</span>` : ''}</button>`).join('')}</nav>
      <div class="mpbody">${tabBody(m, q)}</div>
    </div>`;
  }

  // pictures are resized here to 256 px, so the agent data never carries big images
  function resize(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'), k = Math.min(1, 256 / Math.max(img.width, img.height));
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  DevDockViews.machines = {
    render, close,
    sort(k, num) { const st = msort[mtab]; msort[mtab] = { k, dir: st?.k === k ? -st.dir : num ? -1 : 1 }; render(); },
    open(id) { openId = id; searchInput.value = ''; window.scrollTo(0, 0); render(); if (mtab === 'sessions') this.sessions(id); },
    back() { openId = null; searchInput.value = ''; render(); },
    tab(k) {
      mtab = k;
      try { localStorage.setItem('devdock:machine-tab', k); } catch {}
      render();
      if (k === 'sessions' && !muxes[openId]) this.sessions(openId);
    },
    async sessions(id) {
      muxes[id] = { ...muxes[id], loading: true };
      render();
      const r = await sourceAction('machines', 'sessions', { id });
      muxes[id] = r ? { sessions: r.sessions, error: r.error } : { error: 'Couldn\'t list sessions' };
      render();
    },
    shell(id) { const m = byId(id); if (m) openSession({ id }, `${m.name} shell`, 'machines'); },
    attach(id, mux, session) { const m = byId(id); if (m) openSession({ id, mux, session }, `${session} on ${m.name}`, 'machines'); },
    openAdd(id) { adding = { id: id || null }; renderAdd(); },
    cmd: id => byId(id)?.command || '',
    async create() {
      const el = document.getElementById('maddSheet');
      const v = n => el.querySelector(`[name="${n}"]`);
      const scope = Object.fromEntries(SCOPES.map(([k]) => [k, v('scope-' + k).checked]));
      const r = await sourceAction('machines', 'add', { host: v('host').value, name: v('name').value, port: v('port').value, scope, networks: el.querySelector('[name="networks"]:checked').value });
      if (!r) return;
      adding = { id: r.id };
      // show the command right away; the next scan fills in the waiting state
      DevDock.sourceData.machines.machines.push({ id: r.id, name: v('name').value || v('host').value.split('.')[0], host: v('host').value, port: +v('port').value, color: COLORS[0], status: 'pending', command: r.command, scope, networks: 'private' });
      el.remove();
      renderAdd();
    },
    async confirm(id, matches) {
      if (!await sourceAction('machines', 'confirm', { id, matches })) return;
      if (!matches) { close(); showToast('Forgot it. Add the machine again to start over.'); }
      else { const m = byId(id); if (m) m.status = 'online'; renderAdd(); }
      render();
    },
    ssh(id) {
      const m = byId(id);
      if (m) openSession({ id }, `ssh ${m.host}`, 'machines');
    },
    async act(btn) {
      const { id, a: action, t: target, l: label } = btn.dataset;
      btn.classList.add('busy');
      const r = await sourceAction('machines', 'act', { id, action, target, label });
      btn.classList.remove('busy');
      if (r) showToast(`Done: ${label}`, 'success');
    },
    async customize(id, patch) { if (await sourceAction('machines', 'customize', { id, ...patch })) { Object.assign(byId(id), patch); render(); } },
    async pic(id, file) {
      const dataUrl = file ? await resize(file).catch(() => null) : null;
      if (file && !dataUrl) return showToast('That picture couldn\'t be read', 'warn');
      if (await sourceAction('machines', 'picture', { id, dataUrl })) byId(id).picture = dataUrl ? Date.now() : null, render();
    },
    async repair(id) {
      const token = view.querySelector('[name="repair"]')?.value || '';
      if (await sourceAction('machines', 'repair', { id, token })) showToast('Pairing again: DevDock will check in a few seconds');
    },
    async remove(id) {
      const m = byId(id);
      if (!m || !await confirmDialog(`Remove ${m.name}?`, 'DevDock forgets it and its key. The agent keeps running there until you run sudo devdock-agent uninstall on it.', 'Remove')) return;
      if (await sourceAction('machines', 'remove', { id })) { close(); openId = null; render(); showToast(`Removed ${m.name}`); }
    },
  };
})();

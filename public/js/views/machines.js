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
    jump: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 13),
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
    update: svg('<path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/>', 11),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 11),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 14),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>', 26),
    redo: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', 11),
    hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>', 13),
    back: svg('<path d="m15 18-6-6 6-6"/>', 16, 'stroke-width="2.4"'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 11),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', 13),
    server: svg('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>', 22),
    monitor: svg('<rect x="2" y="3" width="20" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>', 30),
    laptop: svg('<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>', 22),
    box: svg('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>', 18),
    pulse: svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>', 18),
    sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', 18),
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

  // A Simple Icons logo in its brand colour; near-black brands use the text colour so they show on dark
  const lum = hex => { const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return .2126 * r + .7152 * g + .0722 * b; };
  const brand = (hex, d, px) => `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true"><path fill="${lum(hex) < .22 || lum(hex) > .92 ? 'var(--text)' : '#' + hex}" d="${d}"/></svg>`;
  function avatar(m, size = 40) {
    const inner = m.picture ? `<img src="/api/machines/${m.id}/picture?v=${m.picture}" alt="">`
      : m.icon ? brand(m.icon.hex, m.icon.path, size * .52)
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
        ${(() => { const l = live(m).filter(i => i.type !== 'offline' && i.severity !== 'done'); return l.length ? `<div class="missues sev-${l.some(i => i.severity === 'critical') ? 'critical' : 'tidy'}">${ICON.warn}${[...new Set(l.map(i => LABEL[i.type]))].join(' · ')}</div>` : ''; })()}
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
    document.getElementById('viewTools').innerHTML = `<button class="btn-primary madd-icon" title="Add machine" aria-label="Add machine" onclick="DevDockViews.machines.openAdd()">${ICON.plus}</button>`;
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
      <div class="mhero-art">${ICON.monitor}</div>
      <h2>No machines yet</h2>
      <p>See your servers, VMs and Raspberry Pis next to this Mac: vitals, processes, ports and containers.</p>
      <div class="mlink" aria-hidden="true">
        <div class="mlink-node">${ICON.laptop}<span>This Mac</span></div>
        <div class="mlink-wire"><i></i><b>${ICON.lock}</b></div>
        <div class="mlink-node">${ICON.server}<span>Your machine</span></div>
      </div>
      <ol class="msteps">
        <li><b>1</b><span>Tell DevDock where it is</span></li>
        <li><b>2</b><span>Run one command on it</span></li>
        <li><b>3</b><span>Check the key, and it's paired</span></li>
      </ol>
      <button class="btn-primary madd" onclick="DevDockViews.machines.openAdd()">${ICON.plus}Add Machine…</button>
      <p class="mfine">${ICON.key}Only this Mac's key gets in, and every action asks for Touch ID.</p>
    </section>`;
  }

  // ── Add a machine ──────────────────────────────────────────────────
  function sheet(id, body, fresh) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'modal-overlay msheet-overlay';
      el.addEventListener('mousedown', e => { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    if (el.dataset.body === body) return el; // same content: leave it, so animations and focus keep running
    el.dataset.body = body;
    // keep what the user typed across live re-renders
    const focus = el.contains(document.activeElement) && document.activeElement.name;
    const keep = fresh ? [] : [...el.querySelectorAll('input[name]')].map(i => [i.name, i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value, i.value]);
    el.innerHTML = `<div class="modal msheet">${body}</div>`;
    for (const [name, v, val] of keep) {
      const i = el.querySelector(`input[name="${name}"]${typeof v === 'boolean' ? `[value="${val}"]` : ''}`);
      if (i) typeof v === 'boolean' ? (i.checked = v) : (i.value = v);
    }
    if (focus) { const i = el.querySelector(`input[name="${focus}"]`); if (i?.setSelectionRange) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    return el;
  }
  function close() {
    adding = null; look = null;
    document.querySelectorAll('.msheet-overlay').forEach(e => e.remove());
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || DevDock.tab !== 'machines' || document.querySelector('.modal-overlay[style*="flex"]:not(.msheet-overlay)')) return;
    if (adding || look) close();
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
    if (m) return installStep(m);
    wizard();
  }

  // ── Step 3: run the command, and a short tour of what it does ─────
  // Each stop lights up its part of the command and plays a small loop that shows the idea.
  const TOUR = [
    ['download', 'It fetches the installer and checks it', 'The download must match the installer inside this DevDock, byte for byte. The installer then only accepts an agent signed with DevDock\'s release key.',
      [/curl -fsSLo "\$d\/i\.sh" \S+/, /grep -q "\^[0-9a-f]+ "/]],
    ['master', 'It trusts only this Mac', 'This Mac\'s key fingerprint is baked in. Anything else that knocks on the agent\'s port is turned away, even on your own network.', [/--master \S+/]],
    ['token', 'A one-time code proves it\'s yours', 'The code works once, within an hour. It goes to the installer on its input, so it never shows up in a command line other users could read.', [/t=[^;]+;/, /IFS= read -r t/]],
    ['scope', 'It shares only what you picked', 'The list is written into the agent\'s settings. Only root on that machine can widen it later, never DevDock.', [/--scope \S+/, /--action-key \S+/]],
    ['sandbox', 'It runs locked down', 'sudo is only for setting up the service. The agent itself runs as its own user, with no privileges and a 64 MB memory cap.', [/sudo sh "\$d\/i\.sh"/]],
    ['key', 'You check its key', 'When it finishes it prints the agent\'s key. DevDock shows you the same key before it trusts the machine.', []],
  ];
  function marked(cmd, res) {
    const hits = [];
    for (const re of res) { const x = re.exec(cmd); if (x) hits.push([x.index, x.index + x[0].length]); }
    hits.sort((a, b) => a[0] - b[0]);
    let out = '', at = 0;
    for (const [a, b] of hits) if (a >= at) { out += esc(cmd.slice(at, a)) + `<mark>${esc(cmd.slice(a, b))}</mark>`; at = b; }
    return out + esc(cmd.slice(at));
  }
  function tourArt(k, m) {
    const scopes = SCOPES.map(([id, label]) => `<span class="${m.scope?.[id] ? 'on' : ''}">${label}</span>`).join('');
    return {
      download: `<div class="ta-dl"><span class="ta-cloud">${ICON.net}</span><span class="ta-file">${ICON.copy}</span><span class="ta-seal">${ICON.check}</span></div>`,
      master: `<div class="ta-master"><span class="ta-mac">${ICON.laptop}<i>${ICON.key}</i></span><span class="ta-x x1">${ICON.laptop}</span><span class="ta-x x2">${ICON.laptop}</span><span class="ta-srv">${ICON.server}</span><b class="ta-beam"></b></div>`,
      token: `<div class="ta-code">${[0, 1, 2, 3, 4, 5].map(i => `<span style="--i:${i}"></span>`).join('')}<em>used</em></div>`,
      scope: `<div class="ta-scope">${scopes}</div>`,
      sandbox: `<div class="ta-box"><span class="ta-agent">${ICON.shield}</span><div class="ta-mem"><i></i><b>64 MB</b></div><small>user: devdock · no sudo</small></div>`,
      key: `<div class="ta-keys"><code>${esc((m.keyCode || '7F3A 91C2 E04B').slice(0, 14))}</code><span>${ICON.check}</span><code>${esc((m.keyCode || '7F3A 91C2 E04B').slice(0, 14))}</code></div>`,
    }[k];
  }
  function installStep(m) {
    const f = adding, steps = `<ol class="mwz-steps">${STEPS.map((t, i) => `<li class="${i < 2 ? 'done' : 'on'}"><b>${i < 2 ? ICON.check : 3}</b>${t}</li>`).join('<i></i>')}</ol>`;
    const head = `<div class="modal-header"><div class="modal-title">Install on ${esc(m.name)}</div><button class="modal-close" aria-label="Close" onclick="DevDockViews.machines.close()">&times;</button></div>${steps}`;
    if (f.tour != null) {
      const [k, title, text, res] = TOUR[f.tour], last = f.tour === TOUR.length - 1;
      return sheet('maddSheet', `${head}
        <div class="mtour" data-k="${k}">
          <div class="mtour-art" aria-hidden="true">${tourArt(k, m)}</div>
          <div class="mtour-n">${f.tour + 1} of ${TOUR.length}</div>
          <h3 class="mwz-q">${title}</h3><p class="mtour-p">${text}</p>
          <pre class="mtour-cmd">${marked(m.command, res)}</pre>
          <div class="mtour-dots">${TOUR.map((_, i) => `<button aria-label="Step ${i + 1}" class="${i === f.tour ? 'on' : ''}" onclick="DevDockViews.machines.tourGo(${i})"></button>`).join('')}</div>
        </div>
        <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.tourGo(${f.tour ? f.tour - 1 : null})">${f.tour ? 'Back' : 'Done'}</button>
          <button class="btn-primary" onclick="DevDockViews.machines.tourGo(${last ? null : f.tour + 1})">${last ? 'Got It' : 'Next'}</button></div>`, true);
    }
    const how = f.how || 'ssh', orb = /\.orb\.local$/.test(m.host) && m.host.replace(/\.orb\.local$/, '');
    return sheet('maddSheet', `${head}
      <h3 class="mwz-q">How do you want to run it?</h3>
      <div class="mpresets">
        <label class="mpreset"><input type="radio" name="how" value="ssh" ${how === 'ssh' ? 'checked' : ''} onchange="DevDockViews.machines.set('how', 'ssh')">
          <span class="mpreset-ic">${ICON.term}</span><span><b>Run it for me<em>Recommended</em></b><small>DevDock connects with ssh ${esc(m.ssh || m.host)} and runs it. sudo may ask for your password.</small></span></label>
        <label class="mpreset"><input type="radio" name="how" value="paste" ${how === 'paste' ? 'checked' : ''} onchange="DevDockViews.machines.set('how', 'paste')">
          <span class="mpreset-ic">${ICON.copy}</span><span><b>I'll paste it myself</b><small>Copy one command and run it in any terminal on ${esc(m.name)}.</small></span></label>
      </div>
      ${how === 'ssh' ? `<div class="mrun"><button class="btn-primary" onclick="DevDockViews.machines.ssh('${m.id}')">${ICON.play}Run on ${esc(m.name)}</button>
          <span>Uses your SSH keys and ~/.ssh/config. Different user? Add a machine as <code>me@${esc(m.host)}</code>.</span></div>`
        : `<ol class="mpaste">
          <li><b>1</b><span>Open a terminal on ${esc(m.name)}: <code>${orb ? `orb -m ${esc(orb)}` : `ssh ${esc(m.host)}`}</code>${orb ? ' (an OrbStack machine)' : ', or its own console'}</span></li>
          <li><b>2</b><span>Paste this and press Return</span></li></ol>
          <div class="mcmd"><code>${esc(m.command)}</code><button class="hbtn" onclick="copyText(DevDockViews.machines.cmd('${m.id}'), 'Install command')">${ICON.copy}Copy</button></div>`}
      <div class="mwait"><div class="mradar small"><i></i><i></i><i></i></div><div><b>${esc(m.note || 'Waiting for the agent…')}</b><span>Checking ${esc(m.host)}:${m.port} every few seconds. The code in the command works once, for an hour.</span></div></div>
      <button class="mtour-open" onclick="DevDockViews.machines.tourGo(0)">${ICON.shield}<span><b>What does the command do?</b><small>Six short steps, about a minute</small></span>${ICON.back}</button>
      <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.remove('${m.id}')">Cancel and Forget It</button></div>`, true);
  }

  // ── The add flow: three short steps, choices instead of forms ─────
  const PRESETS = [
    ['watch', ICON.pulse, 'Watch it', 'Vitals, the busiest processes and open ports. Nothing can change on it.', { system: true, processes: true, ports: true }],
    ['docker', ICON.box, 'Watch it and its containers', 'Adds Docker containers and compose stacks. Docker access is root-level on most machines.', { system: true, processes: true, ports: true, containers: true }],
    ['control', ICON.hand, 'Watch and act', 'Also stop processes and run containers and stacks. Each action asks for Touch ID here, and the machine checks it.', { system: true, processes: true, ports: true, containers: true, actions: true }],
    ['custom', ICON.sliders, 'Choose myself', 'Pick exactly what it may share.', null],
  ];
  const STEPS = ['Where', 'Access', 'Install'];
  let found = null; // machines DevDock spotted on this Mac's network, fetched once per open
  function wizard() {
    const f = adding;
    const steps = `<ol class="mwz-steps">${STEPS.map((t, i) => `<li class="${i < f.step ? 'done' : i === f.step ? 'on' : ''}"><b>${i < f.step ? ICON.check : i + 1}</b>${t}</li>`).join('<i></i>')}</ol>`;
    const head = `<div class="modal-header"><div class="modal-title">Add Machine</div><button class="modal-close" aria-label="Close" onclick="DevDockViews.machines.close()">&times;</button></div>${steps}`;
    if (f.step === 0) {
      const sugg = (found || []).filter(x => !data().machines.some(m => m.host === x.host));
      return sheet('maddSheet', `${head}
      <h3 class="mwz-q">Where is it?</h3>
      <label class="mfield"><input name="host" value="${esc(f.host)}" placeholder="nas.local, 192.168.1.20 or a Tailscale name" autocomplete="off" spellcheck="false" autofocus
        oninput="DevDockViews.machines.set('host', this.value)" onkeydown="if(event.key==='Enter')DevDockViews.machines.next()"></label>
      ${found === null ? `<div class="mwz-found dim">Looking for machines nearby…</div>` : sugg.length ? `<div class="mwz-found"><span>Found on this Mac</span>${sugg.map(x => `<button class="mpick ${f.host === x.host ? 'on' : ''}" data-h="${esc(x.host)}" data-n="${esc(x.name)}" onclick="DevDockViews.machines.pickHost(this.dataset.h, this.dataset.n)" title="${esc(x.host)}">${ICON.server}<b>${esc(x.name)}</b><small>${esc(x.from)}</small></button>`).join('')}</div>` : ''}
      <details class="mwz-more" ${f.name || f.port !== '7337' ? 'open' : ''}><summary>Name and port</summary>
        <div class="mfields2"><label class="mfield"><span>Name</span><input name="name" value="${esc(f.name)}" placeholder="${esc(f.host.split('.')[0] || 'optional')}" maxlength="40" oninput="DevDockViews.machines.set('name', this.value)"></label>
          <label class="mfield"><span>Port</span><input name="port" value="${esc(f.port)}" inputmode="numeric" oninput="DevDockViews.machines.set('port', this.value)"></label></div></details>
      <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.close()">Cancel</button><button class="btn-primary" ${f.host.trim() ? '' : 'disabled'} onclick="DevDockViews.machines.next()">Continue</button></div>`, true);
    }
    const custom = f.preset === 'custom';
    sheet('maddSheet', `${head}
      <h3 class="mwz-q">What may DevDock do on ${esc(f.name || f.host)}?</h3>
      <div class="mpresets">${PRESETS.map(([k, ic, t, d]) => `<label class="mpreset"><input type="radio" name="preset" value="${k}" ${f.preset === k ? 'checked' : ''} onchange="DevDockViews.machines.set('preset', this.value)">
        <span class="mpreset-ic">${ic}</span><span><b>${t}${k === 'watch' ? '<em>Recommended</em>' : ''}</b><small>${d}</small></span></label>`).join('')}</div>
      ${custom ? `<div class="mscopes mcompact">${SCOPES.map(([k, label, hint]) => `<label class="mscope" title="${esc(hint)}"><input type="checkbox" ${f.scope[k] ? 'checked' : ''} onchange="DevDockViews.machines.scope('${k}', this.checked)"><span><b>${label}</b></span></label>`).join('')}</div>` : ''}
      <div class="mwz-net"><span>Reachable from</span><div class="mseg" role="radiogroup">${[['private', 'Private networks'], ['any', 'Any network']].map(([v, t]) => `<button role="radio" aria-checked="${f.networks === v}" class="${f.networks === v ? 'on' : ''}" onclick="DevDockViews.machines.set('networks', '${v}')">${t}</button>`).join('')}</div>
        <small>${f.networks === 'private' ? 'Your LAN and Tailscale. Recommended.' : "Still only this Mac's key gets in, but the port answers from anywhere."}</small></div>
      <div class="modal-footer"><button class="hbtn ghost" onclick="DevDockViews.machines.back1()">Back</button><button class="btn-primary" ${Object.values(f.scope).some(Boolean) ? '' : 'disabled'} onclick="DevDockViews.machines.create()">Create Install Command</button></div>`, true);
  }

  // ── The icon picker: brand icons, emoji, or your own picture ──────
  // Brand icons are Simple Icons (CC0), bundled, so it works offline. Search covers all of them.
  const PICKS = ('ubuntu debian fedora redhat rockylinux almalinux archlinux alpinelinux nixos linux apple raspberrypi '
    + 'docker kubernetes podman proxmox truenas synology unraid homeassistant nginx caddy traefikproxy cloudflare '
    + 'googlecloud digitalocean hetzner vercel nodedotjs python go rust php ruby openjdk dotnet deno bun '
    + 'mongodb postgresql mysql mariadb redis sqlite elasticsearch rabbitmq apachekafka grafana prometheus '
    + 'jenkins gitlab github gitea plex jellyfin nextcloud pihole wireguard tailscale ollama nvidia minecraft').split(' ');
  let look = null, ICONS = null, EMOJI = null;
  const loadJSON = async u => (await fetch(u)).json();
  function lookHTML() {
    const m = byId(look.id);
    if (!m) return close();
    const tabs = [['icons', 'Icons'], ['emoji', 'Emoji'], ['upload', 'Upload']];
    const q = look.q.trim().toLowerCase();
    let body = '';
    if (look.tab === 'icons') {
      if (!ICONS) body = '<div class="lk-empty">Loading icons…</div>';
      else {
        const hit = q ? ICONS.filter(i => i[0].includes(q.replace(/[^a-z0-9]/g, '')) || i[1].toLowerCase().includes(q) || i[4].toLowerCase().includes(q))
          .sort((a, b) => (b[1].toLowerCase().startsWith(q) - a[1].toLowerCase().startsWith(q)) || a[1].length - b[1].length).slice(0, 120)
          : PICKS.map(k => ICONS.find(i => i[0] === k)).filter(Boolean);
        body = (q ? '' : '<div class="lk-cap">Popular on servers</div>') + (hit.length ? `<div class="lk-grid">${hit.map(i => `<button class="lk-tile${m.icon?.slug === i[0] ? ' on' : ''}" data-s="${i[0]}" title="${esc(i[1])}" onclick="DevDockViews.machines.useIcon(this.dataset.s)">${brand(i[2], i[3], 26)}<span>${esc(i[1])}</span></button>`).join('')}</div>`
          : `<div class="lk-empty">No icon called “${esc(look.q)}”. Try Emoji, or upload a picture.</div>`);
      }
    } else if (look.tab === 'emoji') {
      if (!EMOJI) body = '<div class="lk-empty">Loading emoji…</div>';
      else {
        const list = q ? EMOJI.filter(e => e[1].includes(q)) : EMOJI;
        const groups = [...new Set(list.map(e => e[2]))];
        body = list.length ? groups.map(g => `${q ? '' : `<div class="lk-cap">${esc(g)}</div>`}<div class="lk-emoji">${list.filter(e => e[2] === g).map(e => `<button title="${esc(e[1])}" data-e="${esc(e[0])}" onclick="DevDockViews.machines.useEmoji(this.dataset.e)">${e[0]}</button>`).join('')}</div>`).join('')
          : `<div class="lk-empty">No emoji for “${esc(look.q)}”.</div>`;
      }
    } else {
      body = `<label class="lk-drop" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')"
          ondrop="event.preventDefault();DevDockViews.machines.usePicture(event.dataTransfer.files[0])">
        ${m.picture ? avatar(m, 72) : ICON.image}<b>Drop a picture here</b><span>or click to choose one. PNG, JPEG or WebP; it's resized to 256 px.</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" onchange="DevDockViews.machines.usePicture(this.files[0])"></label>`;
    }
    sheet('mlookSheet', `<div class="modal-header"><div class="modal-title">Icon for ${esc(m.name)}</div><button class="modal-close" aria-label="Close" onclick="DevDockViews.machines.close()">&times;</button></div>
      <div class="lk-top"><div class="mseg" role="tablist">${tabs.map(([k, t]) => `<button role="tab" aria-selected="${look.tab === k}" class="${look.tab === k ? 'on' : ''}" onclick="DevDockViews.machines.lookTab('${k}')">${t}</button>`).join('')}</div>
        ${look.tab === 'upload' ? '' : `<label class="lk-search">${ICON.search}<input name="lq" value="${esc(look.q)}" placeholder="${look.tab === 'icons' ? 'Search 3,400 brands: mongo, postgres, node…' : 'Search emoji: rocket, fire, cloud…'}" autocomplete="off" spellcheck="false" autofocus oninput="DevDockViews.machines.lookFind(this.value)"></label>`}</div>
      <div class="lk-body">${body}</div>
      <div class="modal-footer lk-foot"><span class="dim small">${look.tab === 'icons' ? 'Brand icons from Simple Icons' : ''}</span><button class="hbtn ghost" onclick="DevDockViews.machines.lookReset('${m.id}')">Use Default</button></div>`, true).classList.add('lk-overlay');
  }
  async function lookLoad() {
    if (look?.tab === 'icons' && !ICONS) ICONS = await loadJSON('/vendor/icons.json').catch(() => []);
    if (look?.tab === 'emoji' && !EMOJI) EMOJI = await loadJSON('/vendor/emoji.json').catch(() => []);
    if (look) lookHTML();
  }

  // ── One machine: a page with the same tabs as DevDock itself ───────
  const TABS = [
    ['overview', 'Home'], ['ports', 'Ports', 'ports'], ['sessions', 'Sessions'], ['containers', 'Containers', 'containers'],
    ['agents', 'Agents', 'processes'], ['processes', 'Processes', 'processes'], ['settings', 'Settings'],
  ];
  const navIcon = sel => document.querySelector(sel)?.outerHTML || '';
  const TAB_ICON = {
    overview: () => navIcon('#tabs [data-tab="home"] svg'), ports: () => navIcon('#tabs [data-tab="servers"] svg'),
    containers: () => navIcon('#tabs [data-tab="containers"] svg'), agents: () => navIcon('#tabs [data-tab="coding"] svg'), sessions: () => navIcon('#tabs [data-tab="sessions"] svg'),
    settings: () => navIcon('#settingsBtn svg'), processes: () => svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  };
  let mtab = 'overview';
  try { mtab = localStorage.getItem('devdock:machine-tab') || mtab; } catch {}
  const tabsOf = m => TABS.filter(([, , need]) => !need || m.scope?.[need]);

  const SEV = { critical: 'critical', warning: 'tidy', tidy: 'tidy', done: 'done' }; // reuse Home's colours and sections
  const SECTIONS = [['critical', 'Critical', 'Hurting this machine right now'], ['done', 'Just finished', 'Agents that wrapped up a turn'], ['tidy', 'Tidy up', 'Worth a look, nothing urgent']];
  const LABEL = { offline: 'offline', cpu: 'runaway CPU', mem: 'memory leak', crash: 'crash loop', disk: 'disk filling', pressure: 'out of memory', busy: 'CPU saturated', finished: 'agent finished', 'idle-agent': 'idle agent', stopped: 'stopped containers' };
  // Snoozed card ids -> until (ms), per viewer like Home's
  let snoozed = {};
  try { snoozed = JSON.parse(localStorage.getItem('devdock:machine-snooze')) || {}; } catch {}
  const live = m => (m.items || []).filter(i => !(snoozed[i.id] > Date.now()));
  const snoozeBtn = (it, ms = 3600000, label = 'Snooze 1h') => `<button class="hbtn ghost" data-sid="${esc(it.id)}" onclick="DevDockViews.machines.snooze(this.dataset.sid, ${ms})">${label}</button>`;
  function issue(m, it) {
    const s = it.subject || {};
    const card = (kicker, title, viz, actions = '') => `<article class="hcard sev-${SEV[it.severity]}"><div class="hcard-main">
      <div class="hcard-kicker">${ICON.warn}<span>${kicker}</span>${it.since ? `<em>for ${dur((Date.now() - it.since) / 1000)}</em>` : ''}</div>
      <div class="hcard-title">${title}</div><div class="hcard-actions">${actions}${it.type === 'offline' ? '' : snoozeBtn(it)}</div></div>${viz ? `<div class="hcard-viz">${viz}</div>` : ''}</article>`;
    const show = (mt, key) => `<button class="hbtn" data-mt="${mt}" data-key="${esc(key)}" onclick="revealRow('machines', this.dataset.key, '', () => DevDockViews.machines.tab(this.dataset.mt))">${ICON.jump}Show in ${mt === 'processes' ? 'Processes' : 'Containers'}</button>`;
    const stop = (s.pid ? show('processes', `p:${s.pid}`) : '') + (m.scope?.actions ? actBtn(m, 'process-stop', s.pid, s.name, 'hbtn danger', `${ICON.stop}Stop`) : '');
    const line = (v, color, cap) => `<div class="hval">${v}</div>${sparkline(it.spark, { color })}<div class="hcap">${cap}</div>`;
    switch (it.type) {
      case 'offline': return card('Not answering', `<b>${esc(m.name)}</b> last answered ${timeAgo(it.since)}`, '', `<span class="hcap">${esc(it.error || '')}</span>`);
      case 'cpu': return card('Runaway CPU', `<b>${esc(s.name)}</b> (${esc(s.user)}) is pinning ${(it.value / 100).toFixed(1)} cores`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--red)', 'last 15 min'), stop);
      case 'mem': return card('Memory leak', `<b>${esc(s.name)}</b> keeps growing, +${formatMem(it.rate)} a minute`, line(formatMem(it.value), 'var(--red)', `${formatMem(it.from)} → ${formatMem(it.value)}`), stop);
      case 'crash': return card('Crash loop', `Container <b>${esc(s.name)}</b> keeps restarting`, '', show('containers', `c:${s.id}`) + (m.scope?.actions ? actBtn(m, 'container-stop', s.id, s.name, 'hbtn danger', `${ICON.stop}Stop it`) : ''));
      case 'disk': return card(it.severity === 'critical' ? 'Disk almost full' : 'Disk filling up', `<b>${esc(s.mount)}</b> is ${Math.round(it.value)}% full, ${bytes(it.free)} left`, `<div class="hval">${Math.round(it.value)}<small>%</small></div>`);
      case 'pressure': return card('Out of memory', `Memory has been over 90% for 5 minutes`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--red)', 'last 5 min'));
      case 'finished': return `<div class="hrow sev-done">${ICON.check}<b>${esc(s.name)}</b><span class="hrow-text">finished ${timeAgo(it.since)}</span>
        <span class="hrow-meta">${esc(s.user)} · pid ${s.pid}</span><span class="hrow-actions">${show('processes', `p:${s.pid}`)}<button class="hbtn" onclick="DevDockViews.machines.tab('sessions')">${ICON.term || ''}Open a shell</button>${snoozeBtn(it, 7 * 86400000, 'Dismiss')}</span></div>`;
      case 'idle-agent': return card('Idle agent', `<b>${esc(s.name)}</b> (${esc(s.user)}) has done nothing for ${dur((Date.now() - it.since) / 1000)}, holding ${bytes(s.mem)}`, '', stop);
      case 'stopped': return card('Stopped containers', `${it.subjects.length} container${it.subjects.length > 1 ? 's are' : ' is'} not running: ${it.subjects.slice(0, 4).map(c => `<b>${esc(c.name)}</b>`).join(', ')}${it.subjects.length > 4 ? '…' : ''}`, '',
        `<button class="hbtn" onclick="DevDockViews.machines.tab('containers')">Show them</button>`);
      case 'busy': return card('CPU saturated', `All cores have been over 90% busy for 5 minutes`, line(`${Math.round(it.value)}<small>%</small>`, 'var(--yellow)', 'last 5 min'));
    }
    return '';
  }

  function overview(m) {
    const s = m.snap, h = s?.host || {}, all = live(m), items = all.filter(i => i.severity !== 'done');
    const crit = items.filter(i => i.severity === 'critical').length;
    const sev = crit ? 'critical' : items.length ? 'tidy' : 'clear';
    const headline = crit ? `${crit} ${crit > 1 ? 'things need' : 'thing needs'} you` : items.length ? 'Nothing urgent' : m.status === 'online' ? 'All clear' : 'Not answering';
    const sub = items.length ? [...new Set(items.map(i => LABEL[i.type]))].join(' · ')
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
        <div class="horb">${sev === 'clear' ? ICON.check.replace('width="13" height="13"', 'width="30" height="30"') : `<span>${crit || items.length || '!'}</span>`}</div>
        <div class="hhead"><h2>${headline}</h2><p>${sub}</p></div>${vitals}</section>
      ${SECTIONS.map(([sv, title, hint]) => {
        const list = all.filter(it => SEV[it.severity] === sv);
        return list.length ? `<section class="hsec sev-${sv}"><header><h3>${title}</h3><span>${hint}</span></header><div class="${sv === 'done' ? 'hrows' : 'hgrid'}">${list.map(it => issue(m, it)).join('')}</div></section>` : '';
      }).join('')}
      ${(m.items || []).length > all.length ? `<div class="hfoot">${m.items.length - all.length} snoozed · <button class="link-btn" onclick="DevDockViews.machines.snooze()">show them</button></div>` : ''}
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
  // The row's ⋯ menu, shown on hover, the same as every other DevDock table
  const canAct = m => m.scope?.actions && m.status === 'online';
  function rowMenu(id, items) {
    items = items.filter(Boolean).join('');
    return `<td class="actions-cell">${items ? `<button class="actions-trigger" aria-label="Actions" onclick="event.stopPropagation();toggleActionsMenu('${id}',this)">⋯</button><div class="actions-menu" id="menu-${id}">${items}</div>` : ''}</td>`;
  }
  // a signed action (asks for Touch ID), only when the machine allows actions
  const signed = (m, action, target, label, icon, text, cls = '') => canAct(m) ? actBtn(m, action, target, label, cls, `${icon}${text}<span class="mtid-hint">${ICON.finger}</span>`, `${text} ${label}: asks for Touch ID`) : '';
  const copyItem = (value, text) => `<button data-v="${esc(String(value))}" onclick="closeAllMenus();copyText(this.dataset.v, '${text}')">${ICON.copy}Copy ${text}</button>`;
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
  const table = (head, rows, empty, cls = 'mtable') => rows.length ? `<div class="scroll"><table class="${cls}"><thead><tr>${head.map(th).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
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

  // A button that opens a terminal over your SSH (docker exec, compose pull/up). Values ride in data-*.
  const termItem = (m, kind, target, icon, text) => `<button data-id="${m.id}" data-k="${kind}" data-t="${esc(target)}" onclick="DevDockViews.machines.dockerTerm(this)">${icon}${text}</button>`;
  // Containers and Stacks sub-tabs with All/Running/Stopped, like the desktop Containers tab
  let csub = { tab: 'containers', filter: 'all' };
  try { csub = { ...csub, ...JSON.parse(localStorage.getItem('devdock:machine-ctr')) }; } catch {}
  const CSUB = {
    containers: ['Containers', svg('<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M6 7V4h12v3"/><line x1="7" y1="11" x2="7" y2="16"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="17" y1="11" x2="17" y2="16"/>')],
    stacks: ['Stacks', svg('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>')],
  };
  const pctText = v => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
  const runChip = '<span class="chip chip-live">running</span>';
  function stackList(containers) {
    const by = new Map();
    for (const c of containers) if (c.project) (by.get(c.project) || by.set(c.project, []).get(c.project)).push(c);
    return [...by].map(([name, list]) => {
      const run = list.filter(c => c.state === 'running');
      return { name, list, on: run.length, dir: list.find(c => c.dir)?.dir, cpu: run.reduce((n, c) => n + c.cpu, 0), mem: run.reduce((n, c) => n + c.mem, 0) };
    });
  }
  function stacksBody(m, stacks, q) {
    const rows = stacks.filter(x => matches(q, x.name, x.dir, x.list.map(c => `${c.name} ${c.image}`).join(' '))).map(({ name, list, on, dir, cpu, mem }) =>
      `<tr data-key="s:${esc(name)}"><td class="col-name"><div class="stk-name"><b class="trunc">${esc(name)}</b>${dir ? `<span class="code trunc dim" title="${esc(dir)}">${esc(dir)}</span>` : ''}</div></td>
        <td><div class="stk-svcs">${list.map(c => `<span class="stk-svc ${c.state === 'running' ? 'on' : c.state === 'restarting' ? 'bad' : ''}" title="${esc(c.name)} · ${esc(c.image)}\n${esc(c.status)}"><i></i>${esc(c.service || c.name)}</span>`).join('')}</div>
          <span class="stk-count">${on}/${list.length} running</span></td>
        <td class="code">${on ? pctText(cpu) : '—'}</td><td class="code">${on ? bytes(mem) : '—'}</td><td>${on ? runChip : '<span class="code">stopped</span>'}</td>
        ${rowMenu(`ms-${name}`, [on < list.length && signed(m, 'stack-start', name, name, ICON.play, 'Start'), on && signed(m, 'stack-restart', name, name, ICON.redo, 'Restart'),
          dir && termItem(m, 'stack-update', name, ICON.update, 'Update (pull and up)'), dir && copyItem(dir, 'folder'),
          `<button data-v="${esc(name)}" onclick="closeAllMenus();DevDockViews.machines.onlyStack(this.dataset.v)">${ICON.eye}Show its containers</button>`,
          on && signed(m, 'stack-stop', name, name, ICON.stop, 'Stop', 'danger')])}</tr>`);
    return table([['Stack', '', 'name'], ['Services'], ['CPU', '', 'cpu'], ['Memory', '', 'mem'], ['Last ran', '', 'on'], ['']], rows, 'No Docker Compose stacks match.', 'ctr-table stk-table mstk');
  }
  function containersBody(m, list, q) {
    const rows = list.filter(c => matches(q, c.name, c.image, c.state, c.project)).map(c => {
      const on = c.state === 'running', sp = m.ctrSpark?.[c.id] || {};
      const name = c.project && c.name.startsWith(c.project) ? c.name.slice(c.project.length).replace(/^[-_]/, '') || c.name : c.name;
      const stat = (text, values, color, tip) => `<td><div class="ustat" title="${esc(tip)}"><span class="code">${text}</span>${sparkline(values, { color, w: 54, h: 18 })}</div></td>`;
      return `<tr data-key="c:${esc(c.id)}"><td class="col-name"><span class="path-cell"><span class="trunc" title="${esc(c.name)}\n${esc(c.status)}">${esc(name)}</span>${c.project ? `<span class="chip" title="Compose project">${esc(c.project)}</span>` : ''}</span></td>
        <td><span class="code trunc" title="${esc(c.image)}">${esc(c.image)}</span></td>
        ${on ? stat(pctText(c.cpu), sp.cpu, 'var(--accent)', `${c.cpu.toFixed(1)}% of one core`) + stat(bytes(c.mem), sp.mem, '#a78bfa', `${bytes(c.mem)}${c.limit ? ` of ${bytes(c.limit)} allowed` : ''}`)
          + `<td><div class="unet"><span class="code${c.rx < 1 ? ' zero' : ''}">↓ ${rate(c.rx)}</span><span class="code${c.tx < 1 ? ' zero' : ''}">↑ ${rate(c.tx)}</span></div></td>` : '<td><span class="code">—</span></td>'.repeat(3)}
        <td title="${esc(c.status)}">${on ? runChip : `<span class="code">${esc(c.state)}</span>`}</td>
        ${rowMenu(`mc-${c.id.slice(0, 12)}`, [on && termItem(m, 'container-shell', c.id, ICON.term, 'Open a shell'), !on && signed(m, 'container-start', c.id, c.name, ICON.play, 'Start'),
          on && signed(m, 'container-restart', c.id, c.name, ICON.redo, 'Restart'), copyItem(c.id.slice(0, 12), 'ID'), on && signed(m, 'container-stop', c.id, c.name, ICON.stop, 'Stop', 'danger')])}</tr>`;
    });
    return table([['Name', '', 'name'], ['Image', '', 'image'], ['CPU', '', 'cpu'], ['Memory', '', 'mem'], ['Network', '', 'net'], ['Last ran', '', 'state'], ['']], rows, 'No containers match.', 'ctr-table mctr');
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
      const rows = sorted(ch.pick(s.processes)).filter(p => matches(q, p.name, p.user, p.pid)).map(p => `<tr data-key="p:${p.pid}"><td><b>${esc(p.name)}</b></td><td>${esc(p.user)}</td><td class="num dim">${p.pid}</td>
        <td class="num"><span class="mcpu"><span class="mcpubar"><i style="width:${(p.cpu / max * 100).toFixed(1)}%"></i></span>${p.cpu.toFixed(1)}%</span></td>
        <td class="mspark">${sparkline(m.procSpark?.[p.pid], { color: 'var(--accent)', w: 80, h: 20 })}</td><td class="num">${bytes(p.mem)}</td>${rowMenu(`mp-${p.pid}`, [copyItem(p.pid, 'PID'), signed(m, 'process-stop', p.pid, p.name, ICON.stop, 'Stop'), signed(m, 'process-kill', p.pid, p.name, ICON.close, 'Force quit', 'danger')])}</tr>`);
      return ch.html + table([['Process', '', 'name'], ['User', '', 'user'], ['PID', 'num', 'pid'], ['CPU', 'num', 'cpu'], ['Last 15 min'], ['Memory', 'num', 'mem'], ['']], rows, 'No processes match') + '<p class="hcap mnote">The 20 busiest processes, refreshed every 3 seconds.</p>';
    }
    if (mtab === 'agents') {
      const rows = sorted(m.agents || []).filter(a => matches(q, a.name, a.user, a.pid, a.state.status)).map(a => `<tr data-key="g:${a.pid}">
        <td><b>${esc(a.name)}</b></td><td>${agentStateHTML(a.state)}</td><td>${esc(a.user)}</td><td class="code dim">${a.pid}</td>
        <td><div class="ustat"><span class="code">${pctText(a.cpu)}</span>${sparkline(m.procSpark?.[a.pid], { color: 'var(--accent)', w: 54, h: 18 })}</div></td><td class="code">${bytes(a.mem)}</td>
        ${rowMenu(`mg-${a.pid}`, [`<button onclick="closeAllMenus();DevDockViews.machines.tab('sessions')">${ICON.term}Find its session</button>`, copyItem(a.pid, 'PID'),
          signed(m, 'process-stop', a.pid, a.name, ICON.stop, 'Stop'), signed(m, 'process-kill', a.pid, a.name, ICON.close, 'Force quit', 'danger')])}</tr>`);
      return table([['Agent', '', 'name'], ['State'], ['User', '', 'user'], ['PID', '', 'pid'], ['CPU', '', 'cpu'], ['Memory', '', 'mem'], ['']], rows,
        m.agents?.length ? 'No agents match.' : 'No coding agents running here.', 'mtable magents') + '<p class="hcap mnote">Working means it\'s using CPU. Over SSH DevDock can\'t tell when one is waiting on you.</p>';
    }
    if (mtab === 'ports') {
      const ch = chips(s.ports);
      const rows = sorted(ch.pick([...s.ports].sort((a, b) => a.port - b.port))).filter(p => matches(q, p.port, p.name, p.pid))
        .map(p => `<tr data-key="o:${p.port}"><td class="mono"><b>${p.port}</b></td><td>${esc(p.name || '–')}</td><td class="num dim">${p.pid || ''}</td><td class="dim">${esc(p.proto)}</td>
          ${rowMenu(`mo-${p.port}-${p.proto}`, [p.proto === 'tcp' && `<button data-u="http://${esc(m.host)}:${p.port}" onclick="closeAllMenus();window.open(this.dataset.u)">${ICON.jump}Open in browser</button>`,
            copyItem(`${m.host}:${p.port}`, 'address'), p.pid && signed(m, 'process-stop', p.pid, p.name || `port ${p.port}`, ICON.stop, `Stop ${esc(p.name || 'its process')}`, 'danger')])}</tr>`);
      return ch.html + table([['Port', '', 'port'], ['Process', '', 'name'], ['PID', 'num', 'pid'], ['Protocol', '', 'proto'], ['']], rows, 'Nothing listening matches');
    }
    if (mtab === 'containers') {
      if (!s.containers) return `<div class="empty-view">${esc((s.errors || []).find(e => /docker/i.test(e)) || 'No Docker here')}</div>`;
      const stacks = stackList(s.containers), sub = csub.tab === 'stacks' && stacks.length ? 'stacks' : 'containers', f = csub.filter;
      const ch = chips(s.containers);
      const keep = x => f === 'all' || (f === 'running') === (sub === 'stacks' ? x.on > 0 : x.state === 'running');
      const bar = `<div class="subbar">${stacks.length ? `<div class="subtabs" role="tablist">${Object.entries(CSUB).map(([k, [l, icon]]) => `<button role="tab" aria-selected="${k === sub}" aria-label="${l}" title="${l}" onclick="DevDockViews.machines.csub('tab', '${k}')">${icon}<span class="tab-label">${l}</span></button>`).join('')}</div>` : ''}
        <div class="seg">${[['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped']].map(([k, l]) => `<button class="${k === f ? 'active' : ''}" onclick="DevDockViews.machines.csub('filter', '${k}')">${l}</button>`).join('')}</div>
        ${sub === 'containers' ? ch.html.replace('patterns mpatterns', 'patterns') : ''}</div>`;
      return bar + (sub === 'stacks' ? stacksBody(m, sorted(stacks.filter(keep)), q) : containersBody(m, sorted(ch.pick(s.containers)).filter(keep), q));
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
        <div class="mlistrow mlook"><button class="mdpic" title="Change icon" onclick="DevDockViews.machines.lookOpen('${m.id}')">${avatar(m, 56)}<i>${ICON.edit}</i></button>
          <div><input name="mname" class="minline big" value="${esc(m.name)}" maxlength="40" onchange="DevDockViews.machines.customize('${m.id}', {name: this.value})">
          <span class="hcap"><button class="link-btn" onclick="DevDockViews.machines.lookOpen('${m.id}')">Change icon</button>${m.picture || m.icon || m.emoji ? ` · <button class="link-btn" onclick="DevDockViews.machines.lookReset('${m.id}')">Use default</button>` : ''}</span></div></div>
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
    const count = { overview: live(m).filter(i => i.severity !== 'done').length || '', processes: s?.processes?.length, agents: m.agents?.length, ports: s?.ports?.length, containers: s?.containers?.length };
    return `<div class="mpage" style="--mc:${m.color}">
      <header class="mphead">
        <button class="mback" onclick="DevDockViews.machines.back()" title="All machines  Esc">${ICON.back}Machines</button>
        <div class="mpid">${avatar(m, 44)}<div class="mtitle"><b>${esc(m.name)}</b><span>${esc(h?.hostname || m.host)}${h?.distro ? ` · ${esc(h.distro)}` : ''}${s ? ` · up ${dur(s.uptime)}` : ''}</span></div>${statusPill(m)}</div>
        <button class="btn-primary mshell" onclick="DevDockViews.machines.shell('${m.id}')" title="ssh ${esc(m.ssh || m.host)} in DevDock">${ICON.term}Open Shell</button>
      </header>
      ${m.status === 'untrusted' ? `<div class="malert">${ICON.warn}<div><b>This machine's key changed.</b> DevDock stopped talking to it. If you reinstalled the agent, run <code>sudo devdock-agent pair</code> there and paste the code in Settings. If you didn't, someone may be posing as it.</div></div>` : ''}
      <nav class="subtabs mtabs" role="tablist">${tabs.map(([k, l], i) => `<button role="tab" aria-selected="${k === mtab}" aria-label="${l}" title="${l}${count[k] ? ` · ${count[k]}` : ''}" onclick="DevDockViews.machines.tab('${k}')">${TAB_ICON[k]()}<span class="tab-label">${l}</span>${count[k] ? `<span class="${k === 'overview' ? 'malertn' : 'mcount'}">${count[k]}</span>` : ''}</button>`).join('')}</nav>
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
    exportRows() {
      if (openId) return null; // a machine's page: its tables export like any other
      const list = data().machines || [];
      return { cols: ['Name', 'Host', 'Status', 'OS', 'CPU %', 'Memory used', 'Memory total', 'Uptime', 'Agent'],
        rows: list.map(m => { const s = m.snap || {}; return [m.name, m.port && m.port !== 7337 ? `${m.host}:${m.port}` : m.host, m.status, s.host?.distro || '', s.cpu ? Math.round(s.cpu.usage) : '',
          s.mem ? bytes(s.mem.used) : '', s.mem ? bytes(s.mem.total) : '', s.uptime ? dur(s.uptime) : '', s.version || '']; }) };
    },
    render, close,
    snooze(id, ms) {
      if (id) snoozed[id] = Date.now() + ms; else snoozed = {};
      for (const [k, t] of Object.entries(snoozed)) if (t < Date.now()) delete snoozed[k];
      try { localStorage.setItem('devdock:machine-snooze', JSON.stringify(snoozed)); } catch {}
      render();
    },
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
    dockerTerm(btn) {
      closeAllMenus();
      const m = byId(btn.dataset.id), k = btn.dataset.k, t = btn.dataset.t;
      if (!m) return;
      const c = m.snap?.containers?.find(x => x.id === t);
      openSession({ id: m.id, kind: k, target: t }, k === 'stack-update' ? `Update ${t} on ${m.name}` : `${c?.name || t.slice(0, 12)} on ${m.name}`, 'machines');
    },
    shell(id) { const m = byId(id); if (m) openSession({ id }, `${m.name} shell`, 'machines'); },
    attach(id, mux, session) { const m = byId(id); if (m) openSession({ id, mux, session }, `${session} on ${m.name}`, 'machines'); },
    openAdd(id) {
      adding = { id: id || null, step: 0, host: '', name: '', port: '7337', preset: 'watch', scope: { ...PRESETS[0][4] }, networks: 'private' };
      renderAdd();
      if (!id) sourceAction('machines', 'nearby').then(r => { found = r?.found || []; if (adding && !adding.id && adding.step === 0) renderAdd(); });
    },
    set(k, v) {
      adding[k] = v;
      if (k === 'preset' && v !== 'custom') adding.scope = { ...PRESETS.find(p => p[0] === v)[4] };
      if (k === 'host') { const b = document.querySelector('#maddSheet .modal-footer .btn-primary'); if (b) b.disabled = !v.trim(); return; }
      if (k !== 'name' && k !== 'port') renderAdd();
    },
    scope(k, on) { adding.scope[k] = on; renderAdd(); },
    pickHost(host, name) { Object.assign(adding, { host, name: adding.name || name }); renderAdd(); },
    next() { if (adding.host.trim()) { adding.step = 1; renderAdd(); } },
    back1() { adding.step = 0; renderAdd(); },
    onlyStack(name) { csub.tab = 'containers'; this.csub('filter', 'all'); searchInput.value = name; searchInput.dispatchEvent(new Event('input')); },
    csub(k, v) { csub[k] = v; try { localStorage.setItem('devdock:machine-ctr', JSON.stringify(csub)); } catch {} render(); },
    tourGo(i) { adding.tour = i; renderAdd(); },
    lookOpen(id) { look = { id, tab: 'icons', q: '' }; lookHTML(); lookLoad(); },
    lookTab(tab) { look.tab = tab; look.q = ''; lookHTML(); lookLoad(); },
    lookFind(q) { look.q = q; lookHTML(); },
    async useIcon(slug) {
      const i = ICONS.find(x => x[0] === slug), id = look.id;
      if (i && await sourceAction('machines', 'customize', { id, icon: { slug: i[0], title: i[1], hex: i[2], path: i[3] } })) {
        Object.assign(byId(id), { icon: { slug: i[0], title: i[1], hex: i[2], path: i[3] }, emoji: '', picture: null }); close(); render();
      }
    },
    async useEmoji(e) {
      const id = look.id;
      if (await sourceAction('machines', 'customize', { id, emoji: e })) { Object.assign(byId(id), { emoji: e, icon: null, picture: null }); close(); render(); }
    },
    async usePicture(file) { const id = look.id; close(); await DevDockViews.machines.pic(id, file); },
    async lookReset(id) {
      const m = byId(id);
      if (m.picture) await DevDockViews.machines.pic(id, null);
      if (await sourceAction('machines', 'customize', { id, icon: null, emoji: '' })) { Object.assign(m, { emoji: '', icon: null, picture: null }); close(); render(); }
    },
    cmd: id => byId(id)?.command || '',
    async create() {
      const f = adding, el = document.getElementById('maddSheet');
      const scope = Object.fromEntries(SCOPES.map(([k]) => [k, !!f.scope[k]]));
      const r = await sourceAction('machines', 'add', { host: f.host.trim(), name: f.name.trim(), port: f.port, scope, networks: f.networks });
      if (!r) return;
      adding = { id: r.id, how: 'ssh', tour: null };
      // show the command right away; the next scan fills in the waiting state
      DevDock.sourceData.machines.machines.push({ id: r.id, name: f.name.trim() || f.host.trim().split('.')[0], host: f.host.trim(), port: +f.port, color: COLORS[0], status: 'pending', command: r.command, scope, networks: f.networks });
      el?.remove();
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
      closeAllMenus();
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
      if (await sourceAction('machines', 'picture', { id, dataUrl })) { Object.assign(byId(id), dataUrl ? { picture: Date.now(), icon: null, emoji: '' } : { picture: null }); render(); }
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

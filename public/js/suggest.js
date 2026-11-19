// Prompt suggestions for what's selected, from what DevDock already knows about it:
// a container that died with 137, an agent sitting in an idle session, a server on 90% CPU.
// Each rule scores how telling its signal is; the composer shows the best four.
(function () {
  const svg = d => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    why: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    logs: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
    clean: svg('<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M9 6V4h6v2"/>'),
    pulse: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    agent: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
    size: svg('<path d="M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3M8 3H5a2 2 0 0 0-2 2v3"/>'),
  };

  const exitCode = c => +(String(c.status).match(/Exited \((\d+)\)/)?.[1] ?? NaN);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  window.DevDockSuggest = function (items) {
    const out = [];
    const add = (score, icon, text) => out.push({ score, icon: I[icon], text });
    const of = k => items.filter(i => i.kind === k);
    const kinds = [...new Set(items.map(i => i.kind))];

    // containers
    const ctrs = of('container');
    for (const it of ctrs.slice(0, 3)) {
      const c = it.raw, code = exitCode(c);
      if (c.state === 'restarting') add(10, 'why', `Why does ${it.name} keep restarting?`);
      else if (code === 137) add(10, 'why', `Why was ${it.name} killed (exit 137)? Did it run out of memory?`);
      else if (code > 0) add(9, 'why', `Why did ${it.name} crash with exit code ${code}?`);
      if (c.k8s) add(7, 'pulse', `Is pod ${c.k8s.pod} in ${c.k8s.namespace} healthy? Check its events and logs`);
    }
    const byImage = {};
    ctrs.filter(i => i.raw.state === 'running').forEach(i => { (byImage[i.raw.image] ||= []).push(i); });
    for (const [image, list] of Object.entries(byImage)) {
      if (list.length >= 3) add(9.5, 'why', `Why are ${list.length} ${image.split('/').pop()} containers running? Which are leftovers I can remove?`);
    }
    if (ctrs.length === 1) {
      add(6, 'logs', `Is ${ctrs[0].name} healthy? Check its logs for errors`);
      add(4, 'why', `What does ${ctrs[0].name} do, and who started it?`);
    } else if (ctrs.length > 1) {
      add(6, 'clean', `Which of these ${ctrs.length} containers can I safely remove?`);
      add(4.5, 'list', 'One line on what each container does and if it looks healthy');
    }

    // images
    const imgs = of('image');
    const dangling = imgs.filter(i => !i.raw.tags.length);
    const unusedImgs = imgs.filter(i => !i.raw.containers);
    const big = imgs.filter(i => i.raw.size > 1e9).sort((a, b) => b.raw.size - a.raw.size)[0];
    if (dangling.length) add(7, 'why', dangling.length > 1 ? 'Where did these dangling images come from? Can they go?' : 'Where did this dangling image come from? Can it go?');
    if (unusedImgs.length > 1) add(7, 'clean', `Which of these ${unusedImgs.length} unused images might I still need?`);
    else if (unusedImgs.length === 1 && unusedImgs[0].raw.tags.length) add(6, 'clean', `Does any project here still need ${unusedImgs[0].name}?`);
    if (big) add(8, 'size', `Why is ${big.name} ${big.facts.size}? How can I slim it down?`);

    // volumes
    const vols = of('volume');
    const unusedVols = vols.filter(v => !v.raw.containers);
    if (unusedVols.length) add(8, 'clean', unusedVols.length > 1 ? `What's in these ${unusedVols.length} unused volumes? Is any of it worth keeping?` : `What's inside ${unusedVols[0].name}? Is it safe to delete?`);
    const usedVol = vols.find(v => v.raw.containers);
    if (usedVol) add(5, 'why', `What data does ${usedVol.name} hold, and which container writes it?`);

    // sessions
    const ses = of('session');
    for (const it of ses.slice(0, 3)) {
      const s = it.raw;
      if (s.agents.length) add(10, 'agent', `What is ${s.agents[0]} doing in ${it.name}? Is it stuck or waiting for me?`);
      if (s.ports.length) add(5, 'pulse', `Is the server in ${it.name} on :${s.ports[0]} healthy?`);
      if (s.branch && ses.length === 1) add(5.5, 'logs', `Summarize the work on ${s.branch} in ${it.name}`);
    }
    const idle = ses.filter(i => i.raw.idle);
    if (idle.length > 1) add(9, 'clean', `What was going on in these ${idle.length} idle sessions? Which can I close?`);
    else if (idle.length === 1) add(8, 'why', `What was I doing in ${idle[0].name}? Where did I leave off?`);
    if (ses.length > 1) add(6, 'list', 'One line on what each session is doing');
    else if (ses.length === 1 && !ses[0].raw.agents.length) add(4, 'logs', `What's happening in ${ses[0].name} right now?`);

    // servers
    const srv = of('server');
    for (const it of srv.slice(0, 3)) {
      const p = it.raw, port = `:${p.port}`;
      if (['unhealthy', 'unreachable'].includes(it.facts.health)) add(10, 'why', `Why is ${port} not responding?`);
      if ((p.cpu || 0) >= 30) add(10, 'pulse', `Why is ${port} using ${Math.round(p.cpu)}% CPU?`);
      if ((p.memMB || 0) >= 1024) add(8, 'size', `Why is ${port} using ${it.facts.memory} of memory?`);
      if (p.orphan) add(9, 'why', `Where did ${port} come from? Is it safe to kill?`);
      if (p.dupOf?.length) add(9, 'why', `Why are ${p.dupOf.length + 1} servers running from ${p.scriptPath.split('/').pop()}? Which should I keep?`);
      if (p.idle) add(6, 'clean', `Is ${port} still needed? It has been idle a while`);
    }
    if (srv.length > 1) add(7, 'clean', `Which of these ${srv.length} servers do I actually need?`);
    else if (srv.length === 1) add(5, 'pulse', `What is running on :${srv[0].raw.port}, and is it healthy?`);

    // apps
    const apps = of('app');
    for (const it of apps.slice(0, 3)) {
      const x = it.raw;
      if (x.cpu >= 30) add(10, 'pulse', `Why is ${it.name} using ${Math.round(x.cpu)}% CPU? Which of its processes is it?`);
      if (x.memMB >= 1500) add(9, 'size', `Why is ${it.name} using ${it.facts.memory}? Which part of it?`);
      if (x.kind === 'background') add(7, 'why', `What is "${it.name}" and what started it? Do I need it?`);
    }
    if (apps.length === 1) add(6, 'why', `What does ${apps[0].name} run in the background, and does it start at login?`);
    else if (apps.length > 1) add(6, 'clean', `Which of these ${apps.length} apps can I quit to free memory without losing anything?`);

    // coding agents
    const ags = of('agent');
    for (const it of ags.slice(0, 3)) {
      const x = it.raw;
      if (x.state?.status === 'working') add(9, 'agent', `What is ${it.name} working on right now? Is it making progress or stuck?`);
      if (x.state?.status === 'needs-you') add(10, 'agent', `What is ${it.name} waiting on me for?`);
      if (!x.where?.mux && !x.where?.app && !x.where?.background) add(9, 'why', `What started ${it.name}, and is it safe to stop?`);
    }
    if (ags.length > 1) add(7, 'list', `One line on what each of these ${ags.length} agents is doing and where it left off`);

    if (kinds.length > 1) add(7.5, 'link', `How are these ${kinds.map(k => plural(of(k).length, k)).join(' and ')} related?`);

    const seen = new Set();
    return out.sort((a, b) => b.score - a.score).filter(s => !seen.has(s.text) && seen.add(s.text)).slice(0, 4);
  };
})();

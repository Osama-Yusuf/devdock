// Home tab: only what needs attention right now. Every rule waits for a condition to hold
// for a while (a build pinning the CPU for 20s is normal), and every item has a fix next to it.
// Reads the other sources' latest scans; keeps 15 minutes of CPU and memory per process.
const path = require('path');

const MIN = 60 * 1000;
const KEEP = 15 * MIN;
const RUNAWAY_CPU = 200;      // % of one core: two cores flat out
const RUNAWAY_FOR = 3 * MIN;
const LEAK_MB = 1500;
const LEAK_FOR = 10 * MIN;
const LEAK_GROWTH = 1.25;     // grew a quarter in those 10 minutes
const NEEDS_YOU_AFTER = MIN;  // a permission prompt answered at once never shows
const FINISHED_FOR = 15 * MIN;
const FORGOTTEN_AFTER = 6 * 60 * MIN;
const CRASH_RESTARTS = 3;

function runaway(list, now) {
  const recent = list.filter(s => now - s.t <= RUNAWAY_FOR);
  if (!list.length || now - list[0].t < RUNAWAY_FOR) return null;
  // a short dip (GC, a pause between requests) doesn't reset it
  const hot = recent.filter(s => s.cpu >= RUNAWAY_CPU).length;
  if (hot < recent.length * 0.9) return null;
  let since = now;
  for (let i = list.length - 1; i >= 0 && list[i].cpu >= RUNAWAY_CPU * 0.8; i--) since = list[i].t;
  return { since, value: recent.reduce((n, s) => n + s.cpu, 0) / recent.length };
}
function leak(list, now) {
  const cur = list[list.length - 1];
  if (!cur || cur.mem < LEAK_MB || now - list[0].t < LEAK_FOR) return null;
  const start = list.find(s => now - s.t <= LEAK_FOR) || list[0];
  if (cur.mem < start.mem * LEAK_GROWTH) return null;
  // still climbing: each third of the window averages higher than the one before
  const third = Math.floor(list.length / 3), avg = a => a.reduce((n, s) => n + s.mem, 0) / a.length;
  const [a, b, c] = [list.slice(0, third), list.slice(third, 2 * third), list.slice(2 * third)].map(avg);
  if (!(a < b && b < c)) return null;
  return { since: start.t, from: start.mem, value: cur.mem, rate: (cur.mem - start.mem) / ((now - start.t) / MIN) };
}

const LIMIT_AT = 80; // % of a plan window used before Home warns (20% left)

module.exports = function home(ctx) {
  const samples = new Map(); // key -> [{ t, cpu, mem }]
  const totals = [];         // [{ t, cpu, mem }] for everything DevDock watches

  function record(key, cpu, mem, now) {
    const list = samples.get(key) || [];
    list.push({ t: now, cpu, mem });
    while (list.length && now - list[0].t > KEEP) list.shift();
    samples.set(key, list);
    return list;
  }
  // 24 points for a sparkline
  const spark = (list, f) => {
    const step = Math.max(1, Math.floor(list.length / 24));
    return list.filter((_, i) => i % step === 0 || i === list.length - 1).map(s => Math.round(s[f]));
  };

  async function scan() {
    if (ctx.DEMO) return require('../demo').demoHome();
    const now = Date.now();
    const procs = ctx.procs() || {};
    const ports = ctx.ports();
    const agents = ctx.source('coding')?.last?.() || [];
    const docker = ctx.source('containers')?.last?.();
    const items = [];
    const live = new Set();

    // one server per pid (a server on 3000 and 3001 is one process)
    const servers = new Map();
    for (const p of ports) {
      if (!p.scriptPath || p.scriptPath === '/' || p.appName) continue;
      const s = servers.get(p.pid);
      if (s) s.ports.push(p.port);
      else servers.set(p.pid, { ...p, ports: [p.port] });
    }
    const serverSubject = s => ({ kind: 'server', pid: s.pid, runtime: s.runtime, name: s.procName || s.runtimeName, ports: s.ports, cwd: s.scriptPath, branch: s.branch, runtimeIcon: s.runtimeIcon, runtimeColor: s.runtimeColor });
    const agentSubject = a => ({ kind: 'agent', pid: a.pid, name: a.name, agent: a.agent, cwd: a.cwd, branch: a.branch, where: a.where, ports: a.ports });

    // Runaway CPU and memory leaks, for servers and agents (an agent counts everything it started)
    const flagged = new Set(); // servers already flagged: their agent isn't flagged for the same thing
    const watch = (key, subject, cpu, mem, skip) => {
      live.add(key);
      const list = record(key, cpu, mem, now);
      const r = runaway(list, now);
      if (r && !skip?.('cpu')) {
        flagged.add(`cpu:${subject.pid}`);
        items.push({ id: `cpu:${key}`, type: 'cpu', severity: 'critical', subject, since: r.since, value: r.value, spark: spark(list, 'cpu') });
      }
      const l = leak(list, now);
      if (l && !skip?.('mem')) {
        flagged.add(`mem:${subject.pid}`);
        items.push({ id: `mem:${key}`, type: 'mem', severity: 'critical', subject, since: l.since, value: l.value, from: l.from, rate: l.rate, spark: spark(list, 'mem') });
      }
    };
    for (const s of servers.values()) watch(`p${s.pid}`, serverSubject(s), s.cpu || 0, s.memMB || 0);
    const portPid = Object.fromEntries(ports.map(p => [p.port, p.pid]));
    for (const a of agents) {
      watch(`a${a.pid}`, agentSubject(a), a.cpu || 0, a.memMB || 0,
        type => a.ports.some(port => flagged.has(`${type}:${portPid[port]}`)));
    }
    for (const k of samples.keys()) if (!live.has(k)) samples.delete(k);

    // Totals count each process once: an agent's tree often holds the very servers listed above
    let sumCpu = [...servers.values()].reduce((n, s) => n + (s.cpu || 0), 0);
    let sumMem = [...servers.values()].reduce((n, s) => n + (s.memMB || 0), 0);
    const counted = new Set([...servers.keys()].map(String));
    for (const a of agents) {
      if (!a.pids) { sumCpu += a.cpu || 0; sumMem += a.memMB || 0; continue; }
      for (const x of a.pids) if (!counted.has(String(x))) { counted.add(String(x)); sumCpu += procs[x]?.cpu || 0; sumMem += procs[x]?.memMB || 0; }
    }
    totals.push({ t: now, cpu: sumCpu, mem: sumMem });
    while (totals.length && now - totals[0].t > KEEP) totals.shift();

    // Agents waiting on you, and ones that just finished a turn
    for (const a of agents) {
      const st = a.state;
      if (st?.status === 'needs-you' && now - (st.since || now) >= NEEDS_YOU_AFTER) {
        items.push({ id: `needs:${a.pid}`, type: 'needs-you', severity: 'needs-you', subject: agentSubject(a), since: st.since });
      } else if (st?.status === 'idle' && st.since && now - st.since <= FINISHED_FOR && st.since - (a.startedAt || 0) > MIN) {
        // idle a little while after a turn (not just launched): it finished something
        items.push({ id: `done:${a.pid}:${st.since}`, type: 'finished', severity: 'done', subject: agentSubject(a), since: st.since });
      }
    }

    // Crash loops: Docker says "restarting"; Kubernetes names each attempt k8s_<container>_<pod>_<ns>_<uid>_<attempt>
    // ponytail: a pod that crashed 3 times days ago and has run fine since is skipped by the 15 min freshness check
    for (const c of docker?.containers || []) {
      const attempt = c.k8s && !c.k8s.sandbox ? +(c.name.match(/_(\d+)$/)?.[1] || 0) : 0;
      const looping = c.state === 'restarting' || (attempt >= CRASH_RESTARTS && now - c.createdAt <= 15 * MIN);
      if (!looping) continue;
      const restarts = attempt || +(c.status.match(/Restarting \((\d+)\)/)?.[1] || 0);
      items.push({ id: `crash:${c.k8s ? `${c.k8s.namespace}/${c.k8s.pod}/${c.k8s.container}` : c.id}`, type: 'crash', severity: 'critical',
        subject: { kind: 'container', id: c.id, name: c.k8s ? c.k8s.container || c.k8s.pod : c.name, pod: c.k8s?.pod, namespace: c.k8s?.namespace, image: c.image, status: c.status },
        since: c.createdAt, value: restarts });
    }

    // Forgotten: nothing owns it any more and it has done nothing for hours
    const forgotten = [];
    for (const s of servers.values()) {
      if (s.orphan && s.lastActive && now - s.lastActive >= FORGOTTEN_AFTER) forgotten.push({ ...serverSubject(s), memMB: s.memMB || 0, idleSince: s.lastActive });
    }
    for (const a of agents) {
      const w = a.where || {};
      const loose = !w.mux && !w.app && !w.background;
      const quiet = a.state ? a.state.status === 'idle' && now - (a.state.since || now) >= FORGOTTEN_AFTER : now - (a.startedAt || now) >= FORGOTTEN_AFTER;
      if (loose && quiet) forgotten.push({ ...agentSubject(a), memMB: a.memMB || 0, idleSince: a.state?.since || a.startedAt });
    }
    if (forgotten.length) {
      items.push({ id: `forgotten:${forgotten.map(f => f.pid).sort().join(',')}`, type: 'forgotten', severity: 'tidy', subjects: forgotten,
        value: forgotten.reduce((n, f) => n + f.memMB, 0) });
    }

    // Duplicates: two unrelated servers from the same folder (not a parent and its worker)
    const related = (a, b) => {
      for (let cur = a, i = 0; cur && cur !== '1' && i < 40; cur = procs[cur]?.ppid, i++) if (cur === b) return true;
      return false;
    };
    const byFolder = {};
    for (const s of servers.values()) (byFolder[s.scriptPath] ||= []).push(s);
    for (const [cwd, list] of Object.entries(byFolder)) {
      const top = list.filter(s => !list.some(o => o !== s && related(s.pid, o.pid)));
      if (top.length < 2) continue;
      top.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
      items.push({ id: `dup:${top.map(s => s.pid).join(',')}`, type: 'duplicate', severity: 'tidy', subjects: top.map(serverSubject),
        name: path.basename(cwd), cwd });
    }

    // A coding plan running low: under 20% of a window left. The reset time is in the id,
    // so each window alerts once and the card goes away when it resets.
    for (const t of ctx.source('limits')?.last?.()?.tools || []) {
      for (const l of t.limits) {
        if (l.used >= LIMIT_AT) items.push({ id: `limit:${t.tool}:${l.label}:${l.resetsAt || ''}`, type: 'limit', severity: 'limit', tool: t.tool, plan: t.plan, label: l.label, used: l.used, resetsAt: l.resetsAt });
      }
    }

    return {
      items,
      vitals: {
        servers: servers.size, agents: agents.length,
        working: agents.filter(a => a.state?.status === 'working').length,
        needsYou: agents.filter(a => a.state?.status === 'needs-you').length,
        unknown: agents.filter(a => !a.state).length, // only Claude Code reports its state
        cpu: sumCpu, mem: sumMem, cpuSpark: spark(totals, 'cpu'), memSpark: spark(totals, 'mem'),
        cores: require('os').cpus().length, totalMem: require('os').totalmem() / 1024 / 1024,
        net: await network(now),
      },
    };
  }

  // Network speed of the interface the default route uses, from netstat's byte counters
  // (free, unlike nettop). ponytail: one interface; traffic on a VPN that isn't the default route isn't counted.
  const netHist = [];
  let netPrev = null, iface = null, ifaceAt = 0, tsIp = null;
  // Tailscale's address, from Tailscale itself: 100.64.0.0/10 alone also means carrier NAT or another VPN
  const TS_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  async function tailscaleIp() {
    const bin = ctx.findBin('tailscale') || (require('fs').existsSync(TS_APP) && TS_APP);
    if (!bin) return null;
    const ip = (await ctx.run(bin, ['ip', '-4'], { timeout: 3000 })).stdout.trim().split('\n')[0];
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  }
  async function network(now) {
    if (!iface || now - ifaceAt > 30000) {
      iface = (await ctx.run('route', ['-n', 'get', 'default'], { timeout: 3000 })).stdout.match(/interface:\s*(\S+)/)?.[1] || null;
      ifaceAt = now;
      tsIp = await tailscaleIp();
    }
    if (!iface) return null;
    // count from the end: lo0's link row has no address column
    const row = (await ctx.run('netstat', ['-ibn', '-I', iface], { timeout: 3000 })).stdout.split('\n').find(l => /<Link#/.test(l))?.trim().split(/\s+/);
    if (!row) return null;
    const cur = { t: now, rx: +row[row.length - 5], tx: +row[row.length - 2] };
    if (netPrev && cur.rx >= netPrev.rx && cur.tx >= netPrev.tx) {
      const secs = (now - netPrev.t) / 1000 || 1;
      netHist.push({ t: now, rx: (cur.rx - netPrev.rx) / secs, tx: (cur.tx - netPrev.tx) / secs });
      while (netHist.length && now - netHist[0].t > KEEP) netHist.shift();
    }
    netPrev = cur;
    const addrs = Object.entries(require('os').networkInterfaces()).flatMap(([name, list]) => list.filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, ip: a.address })));
    const last = netHist[netHist.length - 1] || { rx: 0, tx: 0 };
    return {
      iface, rx: last.rx, tx: last.tx, rxSpark: spark(netHist, 'rx'), txSpark: spark(netHist, 'tx'),
      lan: addrs.find(a => a.name === iface)?.ip || null,
      tailscale: addrs.some(a => a.ip === tsIp) ? tsIp : null, // only while it's up on this Mac
    };
  }

  // Which processes use the network, from one nettop sample. On demand only: nettop costs
  // about a CPU second per sample. Grouped by app, so Chrome's helpers count as Chrome.
  // External interfaces only: localhost traffic (DevDock talking to your dev servers) isn't network use.
  async function talkers() {
    if (ctx.DEMO) return require('../demo').demoTalkers();
    const out = (await ctx.run('nettop', ['-P', '-L', '2', '-d', '-s', '1', '-x', '-t', 'external', '-J', 'bytes_in,bytes_out'], { timeout: 8000 })).stdout;
    const block = out.split(/^,bytes_in,bytes_out,$/m)[2] || ''; // the second block is the 1s delta
    const procs = ctx.procs() || {};
    const apps = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^(.*)\.(\d+),(\d+),(\d+),$/);
      if (!m || +m[3] + +m[4] === 0) continue;
      const comm = procs[m[2]]?.comm || '';
      const name = ctx.appFromPath(comm) || ctx.agentOf(comm) || path.basename(comm) || m[1];
      const a = apps[name] ||= { name, rx: 0, tx: 0, pids: [] };
      a.rx += +m[3]; a.tx += +m[4]; a.pids.push(m[2]);
    }
    return { at: Date.now(), apps: Object.values(apps).sort((x, y) => y.rx + y.tx - x.rx - x.tx).slice(0, 8) };
  }

  return { id: 'home', intervalMs: 5000, scan, actions: { talkers } };
};

// shared with sources/machines.js: the same rules for remote machines
module.exports.runaway = runaway;
module.exports.leak = leak;
module.exports.MIN = MIN;

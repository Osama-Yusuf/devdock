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

    const sumCpu = [...servers.values()].reduce((n, s) => n + (s.cpu || 0), 0) + agents.reduce((n, a) => n + (a.cpu || 0), 0);
    const sumMem = [...servers.values()].reduce((n, s) => n + (s.memMB || 0), 0) + agents.reduce((n, a) => n + (a.memMB || 0), 0);
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

    return {
      items,
      vitals: {
        servers: servers.size, agents: agents.length,
        working: agents.filter(a => a.state?.status === 'working').length,
        needsYou: agents.filter(a => a.state?.status === 'needs-you').length,
        cpu: sumCpu, mem: sumMem, cpuSpark: spark(totals, 'cpu'), memSpark: spark(totals, 'mem'),
        cores: require('os').cpus().length, totalMem: require('os').totalmem() / 1024 / 1024,
      },
    };
  }

  return { id: 'home', intervalMs: 5000, scan, actions: {} };
};

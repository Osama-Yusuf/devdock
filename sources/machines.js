// Machines tab: your servers running devdock-agent (agent/ in this repo).
//
// Trust: DevDock has its own P-256 key (made once with the system's openssl). The install
// command carries its fingerprint and a one-time token. At pairing, the agent proves it
// holds that token, bound to its own certificate (see agent/identity.go); DevDock keeps
// that certificate and from then on talks only to it. No passwords, no certificate authority.
//
// Everything lives outside the app bundle, so updates keep it:
//   ~/Library/Application Support/DevDock/master-key.pem   (0600)
//   ~/Library/Application Support/DevDock/machines.json    (0600)
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tls = require('tls');

// The agent's certificate is self-signed, and Electron's TLS won't take a self-signed leaf as its
// own trust anchor (plain Node does). So trust is the exact pin: a socket is handed to HTTP only
// after its certificate's fingerprint matches the one paired, before a single byte is sent.
class PinnedAgent extends https.Agent {
  constructor(fp, opts) { super(opts); this.fp = fp; }
  createConnection(options, done) {
    const s = tls.connect({ ...options, rejectUnauthorized: false });
    s.once('secureConnect', () => {
      const c = s.getPeerX509Certificate?.();
      if (c && c.fingerprint256.replace(/:/g, '').toLowerCase() === this.fp) return done(null, s);
      s.destroy(); done(new Error('This machine\'s key changed'));
    });
    s.once('error', e => done(e));
  }
}
const crypto = require('crypto');

const DATA = process.env.DEVDOCK_DATA || path.join(os.homedir(), 'Library/Application Support/DevDock');
const KEY = path.join(DATA, 'master-key.pem');
const CERT = path.join(DATA, 'master-cert.pem');
const FILE = path.join(DATA, 'machines.json');
const PICS = path.join(DATA, 'pictures');
const KEEP = 15 * 60 * 1000;
const { runaway, leak, MIN } = require('./home'); // the same rules Home uses for this Mac
// The installer comes from the release matching this DevDock and must hash to the copy we ship:
// a swapped file on GitHub, or anyone in between, fails that check before sudo runs anything.
const INSTALL_URL = process.env.DEVDOCK_INSTALL_URL || `https://github.com/Osama-Yusuf/devdock/releases/download/v${require('./version').version}/install-agent.sh`;
const INSTALL_SHA = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../agent/install-agent.sh'))).digest('hex');
// what people compare by eye: the agent prints the same groups when it installs (agent keyCode)
const READY = 'devdock-install';
const keyCode = fp => fp.slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');

// Touch ID key in the Secure Enclave (native/devdock-key.swift); signs every action
const KEYTOOL = path.join(__dirname, '..', 'native', 'devdock-key');
const ACTION_KEY = path.join(DATA, 'action-key.blob');
const ACTIONS = { 'process-stop': 'Stop', 'process-kill': 'Force quit', 'container-stop': 'Stop', 'container-start': 'Start', 'container-restart': 'Restart',
  'stack-stop': 'Stop', 'stack-start': 'Start', 'stack-restart': 'Restart' };

function keytool(args, input) {
  return new Promise((resolve, reject) => {
    // 45 s for the finger: the signed action itself expires 60 s after it's made
    const p = require('child_process').execFile(KEYTOOL, args, { timeout: 45000 }, (err, out, errOut) => {
      if (!err) return resolve(out.trim());
      if (err.killed) return reject(bad('Touch ID wasn\'t confirmed in time', 409));
      reject(bad(err.code === 2 ? 'Cancelled' : `Touch ID key: ${errOut.trim() || err.message}`, err.code === 2 ? 409 : 500));
    });
    if (input) p.stdin.end(input);
  });
}

const fpOf = cert => new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// An agent is only as trustworthy as the server it runs on. Rebuild its snapshot from the
// schema: numbers become numbers, strings become short strings, lists are capped, so
// nothing a hostile server sends reaches the UI or the rules in a shape we didn't expect.
const N = x => Number.isFinite(+x) ? +x : 0;
const T = (x, n = 200) => typeof x === 'string' ? x.slice(0, n) : '';
const L = (x, f, n = 64) => Array.isArray(x) ? x.slice(0, n).filter(o => o && typeof o === 'object').map(f) : [];
const O = (x, f) => x && typeof x === 'object' && !Array.isArray(x) ? f(x) : undefined;
function clean(b) {
  return O(b, b => ({
    version: T(b.version, 32), at: N(b.at), uptime: N(b.uptime),
    scope: O(b.scope, x => Object.fromEntries(['processes', 'ports', 'containers', 'actions', 'terminal'].map(k => [k, x[k] === true]))) || {},
    host: O(b.host, h => ({ hostname: T(h.hostname, 64), os: T(h.os, 16), distro: T(h.distro, 64), distroId: T(h.distroId, 16), kernel: T(h.kernel, 64),
      arch: T(h.arch, 16), cpuModel: T(h.cpuModel, 96), cores: N(h.cores), memTotal: N(h.memTotal), bootTime: N(h.bootTime), virt: T(h.virt, 16), model: T(h.model, 96), machineId: T(h.machineId, 64) })),
    cpu: O(b.cpu, c => ({ usage: N(c.usage), load: L(Array.isArray(c.load) ? c.load.map(v => ({ v })) : [], o => N(o.v), 3) })),
    mem: O(b.mem, m => ({ total: N(m.total), used: N(m.used), available: N(m.available), swapTotal: N(m.swapTotal), swapUsed: N(m.swapUsed) })),
    disks: L(b.disks, d => ({ mount: T(d.mount, 128), fs: T(d.fs, 32), total: N(d.total), used: N(d.used) }), 32),
    net: L(b.net, i => ({ name: T(i.name, 32), rx: N(i.rx), tx: N(i.tx), addrs: (Array.isArray(i.addrs) ? i.addrs : []).slice(0, 16).map(a => T(a, 64)) }), 32),
    processes: L(b.processes, p => ({ pid: Math.trunc(N(p.pid)), name: T(p.name, 64), user: T(p.user, 32), cpu: N(p.cpu), mem: N(p.mem) })),
    ports: L(b.ports, p => ({ port: Math.trunc(N(p.port)), proto: T(p.proto, 8), pid: Math.trunc(N(p.pid)) || undefined, name: T(p.name, 64) }), 256),
    containers: L(b.containers, c => ({ id: T(c.id, 128), name: T(c.name, 128), image: T(c.image, 200), state: T(c.state, 16).replace(/[^a-z]/g, ''), status: T(c.status, 64),
      created: N(c.created), project: T(c.project, 64), service: T(c.service, 64), dir: T(c.dir, 256), cpu: N(c.cpu), mem: N(c.mem), limit: N(c.limit), rx: N(c.rx), tx: N(c.tx) }), 256),
    errors: (Array.isArray(b.errors) ? b.errors : []).slice(0, 16).map(e => T(e, 200)),
  }));
}

module.exports = function machines(ctx) {
  let master = null;          // { key, cert, fp }
  const live = new Map();     // id -> { snap, at, error, hist: [{t,cpu,mem,rx,tx}], agent: https.Agent }

  async function ensureMaster() {
    if (master) return master;
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(KEY) || !fs.existsSync(CERT)) {
      const r = await ctx.run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', // LibreSSL's default spells the curve out, which Go rejects
        '-keyout', KEY, '-out', CERT, '-days', '7300', '-subj', `/CN=devdock-master ${os.hostname()}`]);
      if (r.code !== 0) throw bad('Could not create DevDock\'s key: ' + r.stderr, 500);
    }
    fs.chmodSync(KEY, 0o600);
    const cert = fs.readFileSync(CERT, 'utf8');
    master = { key: fs.readFileSync(KEY, 'utf8'), cert, fp: fpOf(cert), actionKey: await keytool(['pubkey', ACTION_KEY]).catch(() => null) };
    return master;
  }

  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
  function save(list) {
    if (ctx.DEMO) return; // the demo never touches your real machines
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(FILE + '.tmp', FILE);
  }

  // One HTTPS call to an agent. After pairing, only the certificate it paired with is
  // accepted: it's the sole trust anchor and its fingerprint is checked again.
  function call(m, method, p, body, { pairing = false, timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const st = live.get(m.id) || {};
      if (!pairing && !st.agent) {
        st.agent = new PinnedAgent(m.agentFp, { keepAlive: true, maxSockets: 2, key: master.key, cert: master.cert });
        live.set(m.id, st);
      }
      const req = https.request({
        host: m.host, port: m.port, method, path: p, timeout,
        ...(pairing ? { key: master.key, cert: master.cert, rejectUnauthorized: false, agent: false } : { agent: st.agent }),
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(new Error('Answer too large')); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: json, peer: pairing ? res.socket.getPeerCertificate(true) : null });
        });
      });
      req.on('timeout', () => req.destroy(new Error('No answer')));
      // timeout above is per idle gap: a server dripping a byte every few seconds would hold
      // the poll forever, so the whole answer also gets a hard deadline
      const deadline = setTimeout(() => req.destroy(new Error('No answer')), timeout * 2);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  // A pending machine: try to pair. Succeeds once the agent is installed and reachable.
  async function tryPair(m, list) {
    let r;
    try { r = await call(m, 'POST', '/v1/pair', { tokenHint: m.token.slice(0, 8) }, { pairing: true, timeout: 3000 }); }
    catch (e) { return { waiting: true, error: e.code === 'ECONNREFUSED' ? 'Waiting for the agent…' : e.message }; }
    if (r.status !== 200) return { error: r.body?.error || `The agent answered ${r.status}` };
    const pem = `-----BEGIN CERTIFICATE-----\n${r.peer.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const seen = fpOf(r.peer.raw);
    const want = crypto.createHmac('sha256', m.token).update(`devdock-pair-v1|${seen}|${master.fp}`).digest('hex');
    // the agent must prove the token for the key we actually saw, or it's not our agent
    if (r.body?.agentFp !== seen || !r.body?.proof || !crypto.timingSafeEqual(Buffer.from(r.body.proof, 'hex'), Buffer.from(want, 'hex'))) {
      return { error: 'Pairing proof is wrong: this may not be your machine. Nothing was saved.' };
    }
    // the token proves the agent read the command, not that nobody else did: you check its key too
    Object.assign(m, { agentFp: seen, agentCert: pem, pairedAt: Date.now(), token: undefined, confirmed: false });
    save(list);
    return { paired: true };
  }

  function record(st, s, now) {
    const net = (s.net || []).reduce((n, i) => ({ rx: n.rx + i.rx, tx: n.tx + i.tx }), { rx: 0, tx: 0 });
    st.hist.push({ t: now, cpu: s.cpu?.usage || 0, mem: s.mem ? s.mem.used / s.mem.total * 100 : 0, rx: net.rx, tx: net.tx });
    while (st.hist.length && now - st.hist[0].t > KEEP) st.hist.shift();
  }
  // history for the top processes and the running containers the agent reports
  function watchProcs(st, s, now) {
    st.procs ||= new Map();
    const seen = new Set();
    const items = [...(s.processes || []).map(p => [`${p.pid}:${p.name}`, p]), ...(s.containers || []).filter(c => c.state === 'running').map(c => [`c:${c.id}`, c])];
    for (const [key, p] of items) {
      seen.add(key);
      const l = st.procs.get(key) || [];
      l.push({ t: now, cpu: p.cpu, mem: p.mem / 1048576 });
      while (l.length && now - l[0].t > KEEP) l.shift();
      st.procs.set(key, l);
    }
    for (const k of st.procs.keys()) if (!seen.has(k)) st.procs.delete(k); // ponytail: out of the top 20 = history lost
  }

  // Only what needs you, like Home: each rule waits for its condition to hold
  function attention(m, st, status, now) {
    const s = st.snap, items = [];
    const add = (type, severity, key, more) => items.push({ id: `${m.id}:${type}:${key}`, type, severity, ...more });
    if (status === 'offline' && st.at) add('offline', 'critical', '', { since: st.at, error: st.error });
    if (status !== 'online' || !s) return items;
    for (const p of s.processes || []) {
      const l = st.procs?.get(`${p.pid}:${p.name}`) || [];
      const subject = { pid: p.pid, name: p.name, user: p.user };
      const r = runaway(l, now), k = leak(l, now);
      if (r) add('cpu', 'critical', p.pid, { subject, ...r, spark: l.map(x => Math.round(x.cpu)) });
      if (k) add('mem', 'critical', p.pid, { subject, ...k, spark: l.map(x => Math.round(x.mem)) });
    }
    coding(st, s, now, add);
    const stopped = (s.containers || []).filter(c => c.state === 'exited' || c.state === 'dead' || c.state === 'created');
    if (stopped.length) add('stopped', 'tidy', stopped.map(c => c.id).sort().join(','), { subjects: stopped.map(c => ({ id: c.id, name: c.name, status: c.status })) });
    for (const c of s.containers || []) if (c.state === 'restarting') add('crash', 'critical', c.id, { subject: { id: c.id, name: c.name, image: c.image }, status: c.status });
    for (const d of s.disks || []) {
      const pct = d.total ? d.used / d.total * 100 : 0;
      if (pct >= 85) add('disk', pct >= 95 ? 'critical' : 'warning', d.mount, { subject: { mount: d.mount }, value: pct, free: d.total - d.used });
    }
    // sustained for 5 minutes, not a spike
    const held = (f, min) => { const r = st.hist.filter(h => now - h.t <= 5 * MIN); return st.hist.length && now - st.hist[0].t >= 5 * MIN && r.every(h => h[f] >= min) ? r : null; };
    const mp = held('mem', 90);
    if (mp) add('pressure', 'critical', '', { value: mp[mp.length - 1].mem, spark: mp.map(h => Math.round(h.mem)) });
    const cp = held('cpu', 90);
    if (cp) add('busy', 'warning', '', { value: cp[cp.length - 1].cpu, spark: cp.map(h => Math.round(h.cpu)) });
    return items;
  }

  // Coding agents on the machine, like Home's: a turn of real work then quiet = just finished;
  // quiet for hours = left behind. CPU is the only signal: a remote agent has no hooks.
  const AGENTS = new Set(['claude', 'codex', 'gemini', 'aider', 'opencode', 'amp', 'cursor-agent']);
  function coding(st, s, now, add) {
    st.agents ||= new Map();
    const live = new Set();
    for (const p of s.processes || []) {
      if (!AGENTS.has(p.name)) continue;
      live.add(p.pid);
      const a = st.agents.get(p.pid) || { firstSeen: now };
      st.agents.set(p.pid, a);
      const recent = (st.procs?.get(`${p.pid}:${p.name}`) || []).filter(x => now - x.t <= 15e3);
      const busy = recent.length && recent.reduce((n, x) => n + x.cpu, 0) / recent.length >= 3;
      if (busy) { a.busySince ||= now; a.idleSince = null; }
      else {
        if (a.busySince && now - a.busySince >= 30e3) a.finishedAt = now;
        a.busySince = null;
        a.idleSince ||= now;
      }
      const subject = { pid: p.pid, name: p.name, user: p.user, mem: p.mem };
      if (a.finishedAt && now - a.finishedAt < 30 * MIN) add('finished', 'done', `${p.pid}:${a.finishedAt}`, { subject, since: a.finishedAt });
      if (a.idleSince && now - a.idleSince >= 2 * 60 * MIN) add('idle-agent', 'tidy', p.pid, { subject, since: a.idleSince });
    }
    for (const pid of st.agents.keys()) if (!live.has(pid)) st.agents.delete(pid);
  }

  const series = (h, f) => {
    const step = Math.max(1, Math.floor(h.length / 40));
    return h.filter((_, i) => i % step === 0 || i === h.length - 1).map(x => Math.round(x[f] * 10) / 10);
  };

  async function scan() {
    if (ctx.DEMO) return require('../demo').demoMachines();
    await ensureMaster();
    const list = load();
    const now = Date.now();
    const out = await Promise.all(list.map(async m => {
      const st = live.get(m.id) || { hist: [] };
      st.hist ||= [];
      live.set(m.id, st);
      const base = () => ({ id: m.id, name: m.name, emoji: m.emoji, icon: m.icon || null, color: m.color, picture: m.picture || null, host: m.host, port: m.port,
        ssh: m.ssh || '', scope: m.scope, networks: m.networks, addedAt: m.addedAt, pairedAt: m.pairedAt || null });
      if (!m.agentFp) {
        const p = await tryPair(m, list);
        if (!p.paired) return { ...base(), status: 'pending', note: p.error, expires: m.addedAt + 3600e3, command: installCommand(m) };
      }
      // nothing is read from it until you've matched its key with what the install printed
      if (m.confirmed === false) return { ...base(), status: 'confirm', keyCode: keyCode(m.agentFp) };
      try {
        const r = await call(m, 'GET', '/v1/snapshot');
        if (r.status !== 200) throw new Error(r.body?.error || `answered ${r.status}`);
        st.snap = clean(r.body); st.at = now; st.error = null;
        record(st, r.body, now);
        watchProcs(st, r.body, now);
      } catch (e) {
        st.error = /key changed/i.test(e.message) ? 'This machine\'s key changed: it may have been reinstalled, or someone is impersonating it' : e.message;
        if (!/key changed/.test(st.error)) st.agent?.destroy?.(), st.agent = null; // a fresh connection next time
        if (/key changed/.test(st.error)) st.agent?.destroy?.(), st.agent = null;
      }
      // a different key on that address is never "online", however recent the last good answer
      const untrusted = /key changed/.test(st.error || '');
      const online = !untrusted && st.at && now - st.at < 15000;
      const status = untrusted ? 'untrusted' : online ? 'online' : 'offline';
      const procSpark = Object.fromEntries((online ? st.snap.processes || [] : []).map(p => [p.pid, series(st.procs?.get(`${p.pid}:${p.name}`) || [], 'cpu').slice(-24)]));
      const ctrSpark = Object.fromEntries((online ? st.snap.containers || [] : []).map(c => { const l = st.procs?.get(`c:${c.id}`) || []; return [c.id, { cpu: series(l, 'cpu').slice(-24), mem: series(l, 'mem').slice(-24) }]; }));
      const items = attention(m, st, status, now); // also refreshes st.agents
      // coding agents, with a state read from CPU alone (a remote agent has no hooks to say "needs you")
      const agents = (online ? st.snap.processes || [] : []).filter(p => AGENTS.has(p.name)).map(p => {
        const a = st.agents?.get(p.pid) || {};
        return { ...p, state: a.busySince ? { status: 'working', since: a.busySince } : { status: 'idle', since: a.finishedAt || a.idleSince || a.firstSeen } };
      });
      return { items, agents, procSpark, ctrSpark, ...base(), status, error: online ? null : st.error, lastSeen: st.at || null, snap: untrusted ? null : st.snap || null,
        spark: { cpu: series(st.hist, 'cpu'), mem: series(st.hist, 'mem'), rx: series(st.hist, 'rx'), tx: series(st.hist, 'tx') } };
    }));
    return { masterFp: master.fp, machines: out };
  }

  // The token never lands in a command line, where any user on that machine could read it from
  // /proc: the shell keeps it in a variable and pipes it to the installer. Over SSH, DevDock types
  // it into the terminal instead, so it's not in the remote command either.
  function installCommand(m, viaSsh) {
    const scope = Object.entries(m.scope).filter(([, v]) => v).map(([k]) => k).join(',');
    const args = `--master ${master.fp} --scope ${scope || 'system'} --port ${m.port}${m.networks === 'any' ? ' --networks any' : ''}${m.scope.actions ? ` --action-key ${master.actionKey}` : ''}`;
    const run = `d=$(mktemp -d); { curl -fsSLo "$d/i.sh" ${INSTALL_URL} || wget -qO "$d/i.sh" ${INSTALL_URL}; } 2>/dev/null; if (sha256sum "$d/i.sh" 2>/dev/null || shasum -a 256 "$d/i.sh") | grep -q "^${INSTALL_SHA} "; `
      + `then printf "%s\\n" "$t" | sudo sh "$d/i.sh" ${args}; else echo "That installer is not the one this DevDock ships: not running it."; fi; rm -rf "$d"`;
    // over SSH: echo off, then an invisible title sequence tells DevDock it may type the token
    return viaSsh ? `sh -c 'stty -echo; printf "\\033]0;${READY}\\007"; IFS= read -r t; stty echo; ${run}'` : `t=${m.token}; ${run}`;
  }

  // What ssh connects to: the machine's address, or what you set ("me@box", an ~/.ssh/config alias)
  const sshTarget = m => m.ssh || m.host;
  function dockerTerminal(m, kind, target) {
    const s = live.get(m.id)?.snap;
    if (!m.agentFp || !m.scope?.containers || !s?.containers) throw bad("This machine doesn't share its containers");
    return { file: '/usr/bin/ssh', args: ['-t', '--', sshTarget(m), dockerCommand(s.containers, kind, target)] };
  }

  const SSH = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,127}$/;
  const SESSION = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/;

  const find = (list, id) => list.find(m => m.id === id) || (() => { throw bad('That machine is gone', 404); })();
  const SCOPES = ['system', 'processes', 'ports', 'containers', 'actions'];
  const HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;

  function forget(list, id) {
    live.get(id)?.agent?.destroy?.();
    live.delete(id);
    fs.rmSync(path.join(PICS, `${id}.png`), { force: true });
    save(list.filter(m => m.id !== id));
    return {};
  }

  return {
    id: 'machines',
    intervalMs: 3000,
    scan,
    actions: {
      // Machines this Mac already knows: ~/.ssh/config hosts, OrbStack VMs, Tailscale peers.
      // Hints for the add sheet, nothing is contacted.
      async nearby() {
        if (ctx.DEMO) return { found: [{ host: 'nas.local', name: 'nas', from: 'SSH config' }, { host: 'pi.tail1234.ts.net', name: 'pi', from: 'Tailscale' }, { host: 'dev.orb.local', name: 'dev', from: 'OrbStack' }] };
        const found = [], add = (host, name, from) => { if (host && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(host) && !found.some(f => f.host === host)) found.push({ host, name: name || host.split('.')[0], from }); };
        try {
          let alias = null;
          for (const line of fs.readFileSync(path.join(os.homedir(), '.ssh/config'), 'utf8').split('\n')) {
            const [k, ...v] = line.trim().split(/\s+/), key = (k || '').toLowerCase();
            if (key === 'host') alias = v.length === 1 && !/[*?!]/.test(v[0]) ? v[0] : null;
            if (key === 'hostname' && alias) { add(v[0], alias, 'SSH config'); alias = null; }
          }
        } catch {}
        const orb = ctx.findBin('orb');
        if (orb) {
          const r = await ctx.run(orb, ['list', '-f', 'json'], { timeout: 4000 });
          try { for (const m of JSON.parse(r.stdout)) if (m.state === 'running') add(`${m.name}.orb.local`, m.name, 'OrbStack'); } catch {}
        }
        const ts = ctx.findBin('tailscale') || ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(p => fs.existsSync(p));
        if (ts) {
          const r = await ctx.run(ts, ['status', '--json'], { timeout: 4000 });
          try { for (const p of Object.values(JSON.parse(r.stdout).Peer || {})) if (p.Online && !/^(macOS|iOS|android)$/i.test(p.OS)) add(p.DNSName.replace(/\.$/, ''), p.HostName, 'Tailscale'); } catch {}
        }
        return { found: found.slice(0, 12) };
      },
      // Start adding a machine: a token and the install command that carries it
      async add({ host, port = 7337, name, scope = {}, networks = 'private' }) {
        await ensureMaster();
        host = String(host || '').trim();
        if (!HOST.test(host)) throw bad('Type the machine\'s hostname or IP, like nas.local or 192.168.1.20');
        port = +port;
        if (!(port > 0 && port < 65536)) throw bad('Port must be 1 to 65535');
        if (scope.actions && !master.actionKey) throw bad('Actions need Touch ID, and this Mac\'s Secure Enclave key couldn\'t be made');
        const list = load();
        if (list.some(m => m.host === host && m.port === port)) throw bad(`${host}:${port} is already in your machines`);
        const m = {
          id: crypto.randomBytes(6).toString('hex'), host, port, name: String(name || host.split('.')[0]).slice(0, 40),
          emoji: '', color: ['#60a5fa', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#22d3ee'][list.length % 6],
          scope: Object.fromEntries(SCOPES.map(k => [k, !!scope[k]])), networks: networks === 'any' ? 'any' : 'private',
          token: crypto.randomBytes(32).toString('hex'), addedAt: Date.now(),
        };
        list.push(m);
        save(list);
        return { id: m.id, command: installCommand(m) };
      },
      // One action on one machine: Touch ID signs it here, the agent checks the signature there
      async act({ id, action, target }) {
        await ensureMaster();
        const m = find(load(), id);
        if (!ACTIONS[action]) throw bad('Unknown action');
        if (!m.agentFp || !m.scope?.actions) throw bad(`${m.name} doesn't allow actions`, 403);
        target = String(target ?? '');
        const req = { action, target, nonce: crypto.randomBytes(16).toString('hex'), expires: Math.floor(Date.now() / 1000) + 60 };
        const text = `devdock-action-v1\n${m.agentFp}\n${action}\n${target}\n${req.nonce}\n${req.expires}`;
        // the reason shows in the Touch ID prompt: say exactly what and where
        // the prompt describes what is actually signed: the caller's label never reaches it
        const s = live.get(m.id)?.snap, what = action.startsWith('process')
          ? `${s?.processes?.find(p => String(p.pid) === target)?.name || 'process'} (pid ${target})`
          : action.startsWith('stack') ? `stack ${target}`
          : `container ${s?.containers?.find(c => c.id === target || c.name === target)?.name || target}`;
        req.sig = await keytool(['sign', ACTION_KEY, `${ACTIONS[action].toLowerCase()} ${what.replace(/[^\w .()/:@-]/g, '').slice(0, 80)} on ${m.name}`], text);
        const r = await call(m, 'POST', '/v1/action', req, { timeout: 35000 });
        if (r.status !== 200) throw bad(r.body?.error || `The agent answered ${r.status}`);
        return {};
      },
      // Multiplexer sessions, over SSH with keys only: no prompt can hang it
      async sessions({ id }) {
        const m = find(load(), id);
        const r = await ctx.run('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', sshTarget(m),
          'tmux ls -F "tmux #{session_name} #{session_windows} #{session_attached}" 2>/dev/null; zellij ls -n -s 2>/dev/null | sed "s/^/zellij /"'], { timeout: 12000 });
        if (r.code === 255) return { error: /Host key|known_hosts/i.test(r.stderr) ? 'Open a shell once to trust its SSH key' : /denied/i.test(r.stderr) ? 'SSH needs a key here: set who to connect as, or add your key to the machine' : 'SSH couldn\'t connect: ' + r.stderr.trim().split('\n').pop() };
        return { sessions: r.stdout.split('\n').map(l => l.split(' ')).filter(f => f.length >= 2 && (f[0] === 'tmux' || f[0] === 'zellij') && SESSION.test(f[1]))
          .map(([mux, name, windows, attached]) => ({ mux, name, windows: +windows || 1, attached: attached === '1' || +attached > 0 })) };
      },
      // One look at a time: a brand icon, an emoji or a picture; choosing one drops the others
      async customize({ id, name, emoji, icon, color, ssh }) {
        if (ctx.DEMO) return {};
        const list = load();
        const m = find(list, id);
        const plain = () => { fs.rmSync(path.join(PICS, `${id}.png`), { force: true }); m.picture = null; };
        if (name != null) m.name = String(name).trim().slice(0, 40) || m.name;
        if (emoji != null) {
          m.emoji = [...new Intl.Segmenter().segment(String(emoji))][0]?.segment.slice(0, 16) || ''; // one emoji, ZWJ ones too
          if (m.emoji) { m.icon = undefined; plain(); }
        }
        if (icon === null) m.icon = undefined;
        else if (icon != null) {
          const { slug, title, hex, path: d } = icon;
          if (!/^[a-z0-9]{1,64}$/.test(slug) || !/^[0-9A-Fa-f]{6}$/.test(hex) || typeof d !== 'string' || d.length > 30000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) throw bad('That icon looks wrong');
          m.icon = { slug, title: String(title || slug).slice(0, 64), hex, path: d };
          m.emoji = ''; plain();
        }
        if (color != null && /^#[0-9a-f]{6}$/i.test(color)) m.color = color;
        if (ssh != null) {
          if (ssh && !SSH.test(ssh)) throw bad('SSH target looks wrong: use host, user@host or an ~/.ssh/config name');
          m.ssh = ssh || undefined;
        }
        save(list);
        return {};
      },
      // A small picture, already resized by the page; stored as a file, served by /api/machines/:id/picture
      async picture({ id, dataUrl }) {
        if (ctx.DEMO) return {};
        const list = load();
        const m = find(list, id);
        if (dataUrl === null) { fs.rmSync(path.join(PICS, `${id}.png`), { force: true }); m.picture = null; save(list); return {}; }
        const b64 = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)?.[2];
        if (!b64 || b64.length > 700e3) throw bad('Use a PNG, JPEG or WebP under 500 KB');
        fs.mkdirSync(PICS, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(PICS, `${id}.png`), Buffer.from(b64, 'base64'), { mode: 0o600 });
        m.picture = Date.now(); // also busts the page's cache
        m.icon = undefined; m.emoji = '';
        save(list);
        return {};
      },
      // Pair again after `sudo devdock-agent pair` on the machine printed a new code
      async repair({ id, token }) {
        const list = load();
        const m = find(list, id);
        if (!/^[0-9a-f]{64}$/.test(String(token || '').trim())) throw bad('Paste the 64-character code `sudo devdock-agent pair` printed');
        Object.assign(m, { token: token.trim(), agentFp: undefined, agentCert: undefined, pairedAt: undefined, addedAt: Date.now() });
        live.get(id)?.agent?.destroy?.();
        live.delete(id);
        save(list);
        return {};
      },
      // You compared the key DevDock shows with the one the install printed
      async confirm({ id, matches }) {
        const list = load();
        const m = find(list, id);
        if (m.confirmed !== false) return {};
        if (matches !== true) return forget(list, id);
        m.confirmed = true;
        save(list);
        return {};
      },
      async remove({ id }) {
        const list = load();
        find(list, id);
        return forget(list, id);
      },
    },
    // Terminals go through your own SSH, never the agent: it can't start a shell, so it can't
    // be turned into one. Pending machines: the install command. Paired: a shell, or attach.
    terminal({ id, mux, session, kind, target }) {
      const m = load().find(x => x.id === id);
      if (!m) return null;
      if (kind) return dockerTerminal(m, kind, target);
      if (!m.agentFp) return m.token && master ? { file: '/usr/bin/ssh', args: ['-t', '--', sshTarget(m), installCommand(m, true)], input: m.token + '\n', inputWhen: READY, keep: true } : null;
      if (!mux) return { file: '/usr/bin/ssh', args: ['-t', '--', sshTarget(m)] };
      if (!SESSION.test(session || '')) return null;
      const cmd = { tmux: `tmux attach -t '=${session}'`, zellij: `zellij attach '${session}'` }[mux];
      return cmd ? { file: '/usr/bin/ssh', args: ['-t', '--', sshTarget(m), cmd] } : null;
    },
    picturePath: id => /^[0-9a-f]{12}$/.test(id) && fs.existsSync(path.join(PICS, `${id}.png`)) ? path.join(PICS, `${id}.png`) : null,
  };
};

// Docker over your SSH: a shell in a container, or `compose pull && up -d` for a stack.
// Names and paths come from the agent's snapshot, so each is checked against a strict
// pattern and single-quoted before it reaches the remote shell. Plain docker first,
// sudo docker if this user can't reach the daemon (the prompt shows in the terminal).
const sq = v => `'${v.replace(/'/g, `'\\''`)}'`;
const DOCKER = 'D=docker; $D info >/dev/null 2>&1 || D="sudo docker"; if $D compose version >/dev/null 2>&1; then C="$D compose"; else C="${D%docker}docker-compose"; fi;';
function dockerCommand(containers, kind, target) {
  if (kind === 'container-shell') {
    const c = containers.find(x => x.id === target);
    if (!c || !/^[0-9a-f]{12,64}$/.test(c.id)) throw bad('That container is gone');
    if (c.state !== 'running') throw bad(`${c.name} isn't running`);
    return `${DOCKER} $D exec ${c.id} sh -c 'exit 0' >/dev/null 2>&1 || { echo "${c.id.slice(0, 12)} has no shell: its image ships without one."; exit 1; }; exec $D exec -it ${c.id} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
  }
  if (kind === 'stack-update') {
    const c = containers.find(x => x.project === target && x.dir);
    if (!c || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(c.project)) throw bad('That stack is gone');
    if (!/^\/[A-Za-z0-9_.\/@+ -]{0,255}$/.test(c.dir)) throw bad(`Can't update from ${c.dir}: unusual folder name`);
    return `${DOCKER} cd ${sq(c.dir)} && $C -p ${sq(c.project)} pull && $C -p ${sq(c.project)} up -d && echo && echo "Updated ${c.project}."`;
  }
  throw bad('Unknown terminal');
}

module.exports.clean = clean;
module.exports.dockerCommand = dockerCommand;
module.exports.PinnedAgent = PinnedAgent;

const test = require('node:test');
const assert = require('node:assert');
const { clean } = require('../sources/machines');

test('a hostile snapshot comes out typed and harmless', () => {
  const x = '<img src=x onerror=alert(1)>';
  const s = clean({ host: { cores: x, distro: 7 }, cpu: { usage: x, load: x }, processes: { pid: 1 },
    ports: [{ port: x, pid: x }], containers: [{ state: '"><script>', id: 'a' }], net: [{ addrs: [x, 5] }], disks: 'nope', extra: x });
  assert.strictEqual(s.host.cores, 0);
  assert.strictEqual(s.host.distro, '');
  assert.strictEqual(s.cpu.usage, 0);
  assert.deepStrictEqual(s.processes, []);
  assert.strictEqual(s.ports[0].port, 0);
  assert.strictEqual(s.containers[0].state, 'script');
  assert.deepStrictEqual(s.net[0].addrs, [x, '']); // strings stay strings: the UI escapes them
  assert.deepStrictEqual(s.disks, []);
  assert.strictEqual(s.extra, undefined);
  assert.strictEqual(clean('junk'), undefined);
  assert.strictEqual(clean({ processes: Array(500).fill({ pid: 2 }) }).processes.length, 64);
});

test('docker commands for SSH refuse names that could escape the remote shell', () => {
  const { dockerCommand } = require('../sources/machines');
  const ok = { id: 'a'.repeat(64), name: 'web', state: 'running', project: 'shop', dir: '/srv/shop' };
  assert.match(dockerCommand([ok], 'container-shell', ok.id), /exec -it a{64} sh -c/);
  assert.match(dockerCommand([ok], 'stack-update', 'shop'), /cd '\/srv\/shop' && \$C -p 'shop' pull/);
  const evil = [
    { ...ok, id: 'a1;rm -rf /' },
    { ...ok, project: "x';reboot;'" },
    { ...ok, dir: "/srv/$(reboot)" },
    { ...ok, dir: '/srv/`reboot`' },
    { ...ok, dir: "/srv/a'b" },
  ];
  for (const c of evil) {
    for (const [kind, target] of [['container-shell', c.id], ['stack-update', c.project]]) {
      let cmd = '';
      try { cmd = dockerCommand([c], kind, target); } catch { continue; }
      assert.ok(!/reboot|rm -rf/.test(cmd), `${kind} let through: ${cmd}`);
    }
  }
  assert.throws(() => dockerCommand([{ ...ok, state: 'exited' }], 'container-shell', ok.id), /isn't running/);
});

test('agent connections trust only the pinned key, and send nothing to any other', async () => {
  const { PinnedAgent } = require('../sources/machines');
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), crypto = require('crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=agent',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem')), key = fs.readFileSync(path.join(dir, 'k.pem'));
  const fp = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
  let got = 0;
  const server = https.createServer({ key, cert }, (req, res) => { got++; res.end('ok'); });
  server.on('connection', s => s.on('data', () => {})); // raw bytes are counted by the handler only
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const get = pin => new Promise(r => https.get({ host: '127.0.0.1', port: server.address().port, path: '/', agent: new PinnedAgent(pin, {}) },
    res => { res.resume(); res.on('end', () => r(res.statusCode)); }).on('error', e => r(e.message)));
  assert.match(String(await get('00'.repeat(32))), /key changed/);
  assert.strictEqual(got, 0);
  assert.strictEqual(await get(fp), 200);
  assert.strictEqual(got, 1);
  server.close();
  fs.rmSync(dir, { recursive: true });
});

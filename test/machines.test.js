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

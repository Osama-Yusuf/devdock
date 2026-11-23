// node --test: the Home rules fire only on sustained trouble
const test = require('node:test');
const assert = require('node:assert');
const home = require('../sources/home');

async function run(series) { // series(minute) -> { cpu, mem }, sampled every 5s for 15 min
  const server = { pid: '10', port: 3000, scriptPath: '/code/app', procName: 'node' };
  const src = home({ procs: () => ({}), ports: () => [server], source: () => null, run: async () => ({ code: 1, stdout: '' }) });
  const real = Date.now;
  let now = 1e12, out;
  Date.now = () => now;
  try {
    for (let t = 0; t <= 15 * 60; t += 5, now += 5000) {
      const s = series(t / 60);
      server.cpu = s.cpu; server.memMB = s.mem;
      out = await src.scan();
    }
  } finally { Date.now = real; }
  return out.items.map(i => i.type);
}

test('pinned CPU for minutes is runaway, a short spike is not', async () => {
  assert.deepStrictEqual(await run(m => ({ cpu: m > 5 ? 250 : 5, mem: 300 })), ['cpu']);
  assert.deepStrictEqual(await run(m => ({ cpu: m > 14 ? 400 : 5, mem: 300 })), []);
});

test('steady growth past 1.5 GB is a leak, a big flat process is not', async () => {
  assert.deepStrictEqual(await run(m => ({ cpu: 1, mem: 1000 + m * 60 })), ['mem']);
  assert.deepStrictEqual(await run(() => ({ cpu: 1, mem: 3000 })), []);
});

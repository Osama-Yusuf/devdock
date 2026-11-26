const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('Codex limits come from the newest rate-limit snapshot in its logs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  const day = path.join(home, 'sessions/2026/11/24');
  fs.mkdirSync(day, { recursive: true });
  const snap = used => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'plus',
    primary: { used_percent: used, window_minutes: 300, resets_at: 1900000000 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1900500000 } } } });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [snap(40), '{"type":"other"}', snap(85)].join('\n'));
  const r = require('../sources/limits')({}).codexFromLogs(home);
  assert.deepStrictEqual(r.limits.map(l => [l.label, l.used, l.resetsAt]), [['5-hour', 85, 1900000000000], ['Weekly', 10, 1900500000000]]);
  assert.strictEqual(r.plan, 'plus');
});

test('Home warns when under 20% of a plan window is left', async () => {
  const tools = [{ tool: 'Codex', plan: 'plus', limits: [{ label: '5-hour', used: 85, resetsAt: 1 }, { label: 'Weekly', used: 79, resetsAt: 2 }] }];
  const ctx = { DEMO: false, procs: () => ({}), ports: () => [], run: async () => ({ code: 1, stdout: '' }), findBin: () => null,
    source: id => id === 'limits' ? { last: () => ({ tools }) } : null };
  const { items } = await require('../sources/home')(ctx).scan();
  assert.deepStrictEqual(items.filter(i => i.type === 'limit').map(i => i.label), ['5-hour']);
});

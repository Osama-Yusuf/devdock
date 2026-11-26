// node --test: which processes count as coding agents
const test = require('node:test');
const assert = require('node:assert');
const coding = require('../sources/coding');
const { agentOf, appFromPath } = require('../sources/detect');

test('agents bundled in desktop apps count; the apps and helpers that host them do not', async () => {
  const S = '/Users/me/Library/Application Support/Claude/claude-code/2.1.331/5cdc5c10ac5c/claude.app/Contents/MacOS/claude';
  const procs = {
    100: { ppid: '1', comm: '/Applications/Claude.app/Contents/MacOS/Claude' },
    101: { ppid: '100', comm: '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper' },
    102: { ppid: '101', comm: S }, // Claude desktop's Code tab
    200: { ppid: '1', comm: '/Applications/Codex.app/Contents/MacOS/Codex' },
    201: { ppid: '200', comm: '/Applications/Codex.app/Contents/Resources/codex' }, // Codex desktop
    300: { ppid: '1', comm: '/Users/me/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude' }, // Claude Code's own helper
    400: { ppid: '1', comm: 'claude' }, // a terminal session
    401: { ppid: '400', comm: 'claude bg-pty-host' }, // its helper: part of session 400
    500: { ppid: '1', comm: '/Users/me/.local/share/claude/versions/2.1.322' }, // the native install
  };
  const src = coding({
    DEMO: false, procs: () => procs, ports: () => [], source: () => null,
    agentOf, appFromPath,
    claudeState: () => null, cwdOf: async () => null, gitBranch: () => null,
  });
  const found = (await src.scan()).agents.map(a => a.pid).sort();
  assert.deepStrictEqual(found, ['102', '201', '400', '500']);
});

test('agentOf reads paths with spaces, titles with words, and versioned installs', () => {
  assert.strictEqual(agentOf('/Users/me/Library/Application Support/Claude/claude-code/2.1.331/x/claude.app/Contents/MacOS/claude'), 'Claude Code');
  assert.strictEqual(agentOf('claude bg-pty-host'), 'Claude Code');
  assert.strictEqual(agentOf('/Users/me/.local/share/claude/versions/2.1.322'), 'Claude Code');
  assert.strictEqual(agentOf('/opt/homebrew/bin/codex'), 'Codex');
  assert.strictEqual(agentOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), null);
  assert.strictEqual(agentOf('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'), null);
  assert.strictEqual(agentOf('node'), null);
});

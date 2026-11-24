// Plan limits for Claude Code and Codex: how much of each window is used, and when it resets.
//   Claude: Claude Code's login (Keychain, else ~/.claude/.credentials.json) -> the usage call /usage makes
//   Codex:  ~/.codex/auth.json -> ChatGPT's usage call; else the last snapshot in Codex's session logs
// Tokens are only read and only sent to their own provider. Never refreshed: that would rotate the CLI's login.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage';
const ms = t => t == null || t === '' ? null : typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || null;
const windowLabel = sec => sec === 18000 ? '5-hour' : sec === 604800 ? 'Weekly' : sec ? `${Math.round(sec / 3600)}-hour` : 'Limit';
// a window whose reset time has passed starts again from zero
const fresh = l => l.resetsAt && l.resetsAt < Date.now() ? { ...l, used: 0, resetsAt: null } : l;

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': 'DevDock', ...headers }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Signed out: run it once to sign in again' : `Usage service returned ${r.status}`);
  return r.json();
}

module.exports = function limits(ctx) {
  let last = null;

  async function claude() {
    let raw = null;
    const k = await ctx.run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 30000 });
    if (k.code === 0) raw = k.stdout;
    else try { raw = fs.readFileSync(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8'); } catch {}
    let creds;
    try { creds = JSON.parse(raw).claudeAiOauth; } catch {}
    if (!creds?.accessToken) return null; // not signed in with a plan: nothing to show
    const plan = creds.subscriptionType ? creds.subscriptionType[0].toUpperCase() + creds.subscriptionType.slice(1) : null;
    const tool = { tool: 'Claude Code', plan, limits: [] };
    if (creds.expiresAt && creds.expiresAt < Date.now()) return { ...tool, error: 'Login expired: open Claude Code to refresh it' };
    try {
      const d = await getJSON(CLAUDE_URL, { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' });
      if (Array.isArray(d.limits) && d.limits.length) {
        tool.limits = d.limits.map(l => {
          const name = l.scope?.model?.display_name || l.scope?.surface?.display_name;
          const label = l.kind === 'session' ? '5-hour' : l.kind === 'weekly_all' ? 'Weekly' : String(l.kind || '').startsWith('weekly') ? `Weekly ${name || ''}`.trim() : name || String(l.kind || 'Limit');
          return { label, used: Number(l.percent) || 0, resetsAt: ms(l.resets_at) };
        });
      } else {
        for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly Opus'], ['seven_day_sonnet', 'Weekly Sonnet']]) {
          if (d[key]) tool.limits.push({ label, used: Number(d[key].utilization) || 0, resetsAt: ms(d[key].resets_at) });
        }
      }
    } catch (e) { tool.error = e.message; }
    return tool;
  }

  // Codex logs a rate-limit snapshot with every response: the newest one is where its limits stood
  function codexFromLogs(home) {
    const files = [];
    const walk = (dir, depth) => {
      let names; try { names = fs.readdirSync(dir).sort().reverse(); } catch { return; }
      for (const n of names) {
        if (files.length >= 3) return;
        const f = path.join(dir, n);
        if (depth < 3) walk(f, depth + 1); else if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.push(f);
      }
    };
    walk(path.join(home, 'sessions'), 0); // sessions/YYYY/MM/DD/rollout-*.jsonl, newest first
    for (const f of files) {
      let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = text.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let rl; try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; }
        if (!rl?.primary) continue;
        const win = w => w && { label: windowLabel((w.window_minutes || 0) * 60), used: Number(w.used_percent) || 0, resetsAt: ms(w.resets_at) };
        return { plan: rl.plan_type || null, limits: [win(rl.primary), win(rl.secondary)].filter(Boolean) };
      }
    }
    return null;
  }

  async function codex() {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    let auth; try { auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')); } catch { return null; }
    const tok = auth.tokens?.access_token;
    let exp = 0; try { exp = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')).exp * 1000; } catch {}
    if (tok && (!exp || exp > Date.now())) {
      try {
        const d = await getJSON(CODEX_URL, { Authorization: `Bearer ${tok}`, ...(auth.tokens.account_id && { 'ChatGPT-Account-Id': auth.tokens.account_id }) });
        const win = w => w && { label: windowLabel(w.limit_window_seconds), used: Number(w.used_percent) || 0, resetsAt: ms(w.reset_at) };
        return { tool: 'Codex', plan: d.plan_type || null, limits: [win(d.rate_limit?.primary_window), win(d.rate_limit?.secondary_window)].filter(Boolean) };
      } catch {} // fall back to the logs
    }
    const logs = codexFromLogs(home);
    return logs ? { tool: 'Codex', ...logs, stale: true } : { tool: 'Codex', plan: null, limits: [], error: 'Signed out: run Codex once to sign in again' };
  }

  async function scan() {
    if (ctx.DEMO) return { tools: [
      { tool: 'Claude Code', plan: 'Max', limits: [{ label: '5-hour', used: 86, resetsAt: Date.now() + 5400000 }, { label: 'Weekly', used: 41, resetsAt: Date.now() + 3 * 864e5 }] },
      { tool: 'Codex', plan: 'plus', limits: [{ label: '5-hour', used: 12, resetsAt: Date.now() + 9000000 }, { label: 'Weekly', used: 63, resetsAt: Date.now() + 5 * 864e5 }] },
    ] };
    const tools = (await Promise.all([claude(), codex()])).filter(Boolean).map(t => ({ ...t, limits: t.limits.map(fresh) }));
    return (last = { tools, at: Date.now() });
  }

  return { id: 'limits', intervalMs: 5 * 60000, scan, last: () => last, codexFromLogs };
};

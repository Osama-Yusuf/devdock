// Which agent or app a process is, from its ps comm. Shared by server.js and the sources.
const path = require('path');

const AGENTS = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider',
  opencode: 'opencode', 'cursor-agent': 'Cursor Agent', amp: 'Amp', goose: 'Goose',
  droid: 'Droid', crush: 'Crush', qwen: 'Qwen Code', kiro: 'Kiro',
};

// Outermost bundle wins: ".../Visual Studio Code.app/.../Code Helper.app/..." -> "Visual Studio Code"
function appFromPath(p) {
  const m = p && p.match(/\/([^/]+?)\.app\//);
  return m ? m[1] : null;
}

// Agent name for a process's ps comm, or null. A path is the whole comm (it can hold spaces:
// ".../Application Support/Claude/claude-code/..."); a retitled process is its first word
// ("claude bg-pty-host"). ".../claude/versions/2.1.322" -> "claude"
function agentOf(comm) {
  const c = comm.startsWith('/') ? comm : comm.split(' ')[0];
  let base = path.basename(c).toLowerCase();
  if (/^\d+(\.\d+)+$/.test(base)) base = path.basename(path.dirname(path.dirname(c))).toLowerCase();
  return AGENTS[base] || null;
}

module.exports = { AGENTS, appFromPath, agentOf };

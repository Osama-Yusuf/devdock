const $ = id => document.getElementById(id);
let allEntries = [];
let settings = {};
let groupingDepth = 1;

// View state survives refresh, same as the dashboard
const VIEW_KEY = 'devdock:history-view';
let view = {};
try { view = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch {}
let groupBy = view.groupBy === 'project' ? 'project' : 'none';
let statusFilter = ['running', 'stopped'].includes(view.status) ? view.status : 'all';
function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ groupBy, status: statusFilter })); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function timeAgo(dateStr) {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function tildify(path) {
  const home = settings.home;
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

function runtimeIconHTML(key, color, letters) {
  const d = RUNTIME_ICONS[key];
  return d
    ? `<svg class="runtime-logo" width="16" height="16" viewBox="0 0 24 24" fill="${color}" aria-hidden="true"><path d="${d}"/></svg>`
    : `<span class="runtime-icon" style="background:${color}">${esc(letters || '?')}</span>`;
}

// ── Actions ──────────────────────────────────────────────────────
async function openTerminal(dir) {
  const res = await fetch('/api/open-terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }),
  }).catch(() => null);
  showToast(res?.ok ? `Terminal opened at ${dir.split('/').pop()}` : 'Failed to open terminal', res?.ok ? 'success' : 'warn');
}

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => showToast(`${label} copied`));
}

async function startServer(port, dir) {
  const res = await fetch('/api/start-server', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, port }),
  }).catch(() => null);
  if (res?.ok) { showToast(`Starting server in ${dir.split('/').pop()}…`); setTimeout(loadHistory, 2000); }
  else showToast((await res?.json().catch(() => null))?.error || 'Failed to start server', 'warn');
}

async function removeFromHistory(port) {
  if (!await confirmDialog(`Remove port ${port} from history?`, '', 'Remove')) return;
  await fetch(`/api/history/${port}`, { method: 'DELETE' });
  showToast(`Port ${port} removed`);
  loadHistory();
}

async function clearAll() {
  if (!await confirmDialog('Clear all port history?', 'Running processes stay listed.', 'Clear')) return;
  await fetch('/api/history', { method: 'DELETE' });
  showToast('History cleared');
  loadHistory();
}

// ── Row menu ─────────────────────────────────────────────────────
const menuBackdrop = $('menuBackdrop');
const floatingMenu = $('floatingMenu');

function closeMenus() {
  floatingMenu.classList.remove('open');
  floatingMenu.innerHTML = '';
  menuBackdrop.classList.remove('open');
}

function toggleMenu(id, triggerEl) {
  const source = document.getElementById(`hmenu-${id}`);
  if (!source) return;
  const wasOpen = floatingMenu.classList.contains('open');
  closeMenus();
  if (wasOpen) return;
  floatingMenu.innerHTML = source.innerHTML;
  const rect = triggerEl.getBoundingClientRect();
  if (window.innerHeight - rect.bottom < 150) {
    floatingMenu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    floatingMenu.style.top = 'auto';
  } else {
    floatingMenu.style.top = (rect.bottom + 4) + 'px';
    floatingMenu.style.bottom = 'auto';
  }
  floatingMenu.style.right = (window.innerWidth - rect.right) + 'px';
  floatingMenu.style.left = 'auto';
  floatingMenu.classList.add('open');
  menuBackdrop.classList.add('open');
}

menuBackdrop.addEventListener('click', closeMenus);
floatingMenu.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(closeMenus, 50); });

// ── Render ───────────────────────────────────────────────────────
function getGroupKey(scriptPath, depth) {
  if (!scriptPath || scriptPath === '/') return 'Unknown';
  const parts = scriptPath.replace(/\/$/, '').split('/');
  return parts.length > depth ? parts.slice(0, parts.length - depth).join('/') : scriptPath;
}

function updateFilters() {
  const runtimes = new Set(allEntries.map(e => e.runtime).filter(Boolean));
  const cur = $('runtimeFilter').value;
  $('runtimeFilter').innerHTML = '<option value="all">All Runtimes</option>' + [...runtimes].sort()
    .map(rt => `<option value="${esc(rt)}">${esc(allEntries.find(e => e.runtime === rt)?.runtimeName || rt)}</option>`).join('');
  if (runtimes.has(cur)) $('runtimeFilter').value = cur;
}

const ICON = {
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  term: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function rowHTML(e) {
  const id = `${e.port}-${e.stopped ? 's' : 'r'}`;
  const gone = e.stopped && e.pathExists === false;
  const path = e.appName && (!e.scriptPath || e.scriptPath === '/')
    ? `<span class="app-name trunc" title="No project directory, owned by ${esc(e.appName)}">${esc(e.appName)}</span>`
    : e.scriptPath
    ? (gone
      ? `<span class="path-link trunc path-gone" title="${esc(e.scriptPath)}\nThis folder no longer exists">${esc(tildify(e.scriptPath))}</span>`
      : `<span class="path-link trunc" data-path="${esc(e.scriptPath)}" onclick="copyText(this.dataset.path, 'Path')" oncontextmenu="event.preventDefault();openTerminal(this.dataset.path)" title="${esc(e.scriptPath)}\nClick to copy · Right-click to open terminal">${esc(tildify(e.scriptPath))}</span>`)
    : '<span class="code">—</span>';
  const canStart = e.stopped && e.scriptPath && !gone;
  return `
    <td><span class="status-dot ${e.stopped ? 'stopped' : 'running'}" title="${e.stopped ? 'Stopped' : 'Running'}"></span>${e.port
      ? `<a href="http://localhost:${e.port}" target="_blank" class="code port-link" title="Open in browser">${e.port}</a>`
      : '<span class="code">&mdash;</span>'}</td>
    <td><span class="code pid-copy">${e.stopped ? '—' : esc(e.pid)}</span></td>
    <td><span class="proc" title="${esc(e.runtimeName)}${e.command ? '\nprocess: ' + esc(e.command) : ''}">
      ${runtimeIconHTML(e.runtime, e.runtimeColor, e.runtimeIcon)}
      <span class="proc-text"><span class="proc-name trunc is-runtime">${esc(e.runtimeName || e.command || '—')}</span></span>
    </span></td>
    <td class="col-path"><span class="path-cell">${path}</span></td>
    <td><span class="started" title="${e.lastSeen ? new Date(e.lastSeen).toLocaleString() : ''}">${e.stopped ? (e.lastSeen ? timeAgo(e.lastSeen) : '—') : 'now'}</span></td>
    <td class="actions-cell" style="text-align:right;">
      <button class="actions-trigger" onclick="event.stopPropagation();toggleMenu('${id}',this)" aria-label="Actions">⋯</button>
      <div class="actions-menu" id="hmenu-${id}">
        ${canStart ? `<button onclick="startServer(${e.port}, this.dataset.path)" data-path="${esc(e.scriptPath)}">${ICON.play} Start server</button>` : ''}
        ${e.scriptPath && !gone ? `<button onclick="openTerminal(this.dataset.path)" data-path="${esc(e.scriptPath)}">${ICON.term} Open terminal</button>
        <button onclick="copyText(this.dataset.path, 'Path')" data-path="${esc(e.scriptPath)}">${ICON.copy} Copy path</button>` : ''}
        ${e.stopped ? `<div class="actions-divider"></div>
        <button class="danger" onclick="removeFromHistory(${e.port})">${ICON.trash} Remove from history</button>` : ''}
        ${!e.stopped && !e.scriptPath ? '<button disabled style="opacity:0.5;cursor:default;">Running, nothing to do here</button>' : ''}
      </div>
    </td>`;
}

function renderTable() {
  const term = $('searchInput').value.toLowerCase();
  const rtFilter = $('runtimeFilter').value;
  const filtering = term || rtFilter !== 'all' || statusFilter !== 'all';
  $('clearFilters').style.display = filtering ? '' : 'none';

  const filtered = allEntries.filter(e => {
    const matchesSearch = !term || [e.port, e.pid, e.command, e.runtimeName, e.scriptPath, e.user]
      .some(v => String(v ?? '').toLowerCase().includes(term));
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'running') === !e.stopped;
    return matchesSearch && (rtFilter === 'all' || e.runtime === rtFilter) && matchesStatus;
  });

  $('resultInfo').textContent = allEntries.length && filtered.length !== allEntries.length
    ? `Showing ${filtered.length} of ${allEntries.length}` : '';

  if (!filtered.length) {
    $('emptyState').style.display = 'block';
    $('emptyState').textContent = filtering
      ? 'No entries match your filters.'
      : 'No port history yet. Ports are recorded while DevDock is running.';
    $('tableContainer').style.display = 'none';
    return;
  }
  $('emptyState').style.display = 'none';
  $('tableContainer').style.display = '';

  const tbody = $('tableBody');
  tbody.innerHTML = '';
  const addRow = (e) => {
    const tr = document.createElement('tr');
    if (e.stopped) tr.className = 'row-stopped';
    tr.innerHTML = rowHTML(e);
    tbody.appendChild(tr);
    return tr;
  };

  if (groupBy === 'project') {
    const groups = {};
    filtered.forEach(e => (groups[getGroupKey(e.scriptPath, groupingDepth)] ||= []).push(e));
    Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).forEach(([groupPath, entries]) => {
      const gap = document.createElement('tr');
      gap.className = 'group-gap';
      gap.innerHTML = '<td colspan="6"></td>';
      tbody.appendChild(gap);
      const header = document.createElement('tr');
      header.className = 'group-row';
      const running = entries.filter(e => !e.stopped).length;
      header.innerHTML = `<td colspan="6">
        <div class="group-header" onclick="toggleGroup(this)">
          <span class="group-chevron">▼</span>
          <span class="group-name trunc" title="${esc(groupPath)}">${esc(groupPath.startsWith('/') ? tildify(groupPath) : groupPath)}</span>
          <span class="group-count">${entries.length}</span>
          <span class="group-usage">${running} running · ${entries.length - running} stopped</span>
        </div></td>`;
      tbody.appendChild(header);
      entries.forEach(addRow);
    });
  } else {
    filtered.forEach(addRow);
  }
}

function toggleGroup(headerEl) {
  const collapsed = headerEl.classList.toggle('collapsed');
  let next = headerEl.closest('tr').nextElementSibling;
  while (next && !next.classList.contains('group-gap')) {
    next.style.display = collapsed ? 'none' : '';
    next = next.nextElementSibling;
  }
}

async function loadHistory() {
  try {
    const data = await fetch('/api/ports').then(r => r.json());
    const running = (data.ports || []).map(p => ({ ...p, stopped: false, pathExists: true, lastSeen: data.timestamp }));
    const stopped = data.history || [];
    allEntries = [
      ...running.sort((a, b) => (a.port || 0) - (b.port || 0)),
      ...stopped.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '')),
    ];
    $('runningCount').textContent = running.length;
    $('stoppedCount').textContent = stopped.length;
    updateFilters();
    renderTable();
  } catch (err) {
    console.error('Failed to load history', err);
  }
}

// ── View switches ────────────────────────────────────────────────
function syncSegs() {
  $('statusSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.s === statusFilter));
  $('groupSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.g === groupBy));
  $('tableContainer').classList.toggle('grouped', groupBy === 'project');
}
$('statusSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  statusFilter = b.dataset.s; syncSegs(); saveView(); renderTable();
});
$('groupSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  groupBy = b.dataset.g; syncSegs(); saveView(); renderTable();
});
syncSegs();

function clearFilters() {
  $('searchInput').value = '';
  $('runtimeFilter').value = 'all';
  statusFilter = 'all';
  syncSegs(); saveView(); renderTable();
}

$('searchInput').addEventListener('input', renderTable);
$('runtimeFilter').addEventListener('change', renderTable);
$('clearFilters').addEventListener('click', clearFilters);
$('clearAllBtn').addEventListener('click', clearAll);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') { e.target.blur(); closeMenus(); }
    return;
  }
  switch (e.key) {
    case 'Escape': {
      // menu open -> close it; filters on -> clear them; otherwise leave History
      if (floatingMenu.classList.contains('open')) closeMenus();
      else if ($('searchInput').value || $('runtimeFilter').value !== 'all' || statusFilter !== 'all') clearFilters();
      else window.location.href = '/';
      break;
    }
  }
});

window.devdockCommand = (cmd) => {
  switch (cmd) {
    case 'find': $('searchInput').focus(); $('searchInput').select(); break;
    case 'back': window.location.href = '/'; break;
    case 'settings': window.location.href = '/#settings'; break;
    case 'view-none': case 'view-project': groupBy = cmd.slice(5); syncSegs(); saveView(); renderTable(); break;
  }
};

(async function init() {
  try {
    settings = await fetch('/api/settings').then(r => r.json());
    if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);
    if (settings.groupingDepth != null) groupingDepth = settings.groupingDepth;
  } catch {}
  loadHistory();
})();

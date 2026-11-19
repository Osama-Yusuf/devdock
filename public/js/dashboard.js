// ── DOM ───────────────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const tableBody = $('tableBody');
    const countEl = $('count');
    const emptyStateEl = $('emptyState');
    const searchInput = $('searchInput');
    const runtimeFilter = $('runtimeFilter');
    const clearBtn = $('clearBtn');
    const resultInfo = $('resultInfo');
    const runtimePills = $('runtimePills');

    let allPorts = [];
    let previousPorts = [];
    let healthMap = {};
    let runtimeDefs = {};
    let currentSettings = {};
    let ws = null;
    let groupingDepth = 1;

    // View state survives refresh (per-window convenience, so localStorage)
    const VIEW_KEY = 'devdock:view';
    let savedView = {};
    try { savedView = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch {}
    let sortColumn = savedView.sortColumn || 'port';
    let sortDirection = savedView.sortDirection || 'asc';
    // 'none' | 'project' | 'session' (older saves stored a boolean)
    // ?view=project|session|none deep-links a grouping
    let groupBy = new URLSearchParams(location.search).get('view') || savedView.groupBy || (savedView.groupByProject ? 'project' : 'none');
    const collapsedGroups = new Set(savedView.collapsed || []);

    function saveView() {
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({
          sortColumn, sortDirection, groupBy, collapsed: [...collapsedGroups],
        }));
      } catch {}
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ── Theme ────────────────────────────────────────────────────────
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      const icon = $('themeIcon');
      if (theme === 'light') {
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      } else {
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      }
    }

    $('themeToggle').addEventListener('click', async () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    });

    // ── Toast ─────────────────────────────────────────────────────────
    // key: reuse one toast instead of stacking (e.g. rapid auto-saves)
    function showToast(msg, type = 'success', key) {
      let t = key && document.querySelector(`.toast[data-key="${key}"]`);
      if (!t) {
        t = document.createElement('div');
        if (key) t.dataset.key = key;
        document.body.appendChild(t);
      }
      t.className = `toast toast-${type}`;
      t.textContent = msg;
      clearTimeout(t._timer);
      t._timer = setTimeout(() => t.remove(), 2500);
    }

    // ── Kill / Restart ───────────────────────────────────────────────
    async function killPids(pids, message) {
      closeAllMenus();
      pids = [...new Set(pids.map(String))];
      if (!pids.length) return;
      if (!await confirmDialog(message, `PID${pids.length > 1 ? 's' : ''} ${pids.join(', ')}`)) return;
      const results = await Promise.all(pids.map(pid =>
        fetch(`/api/kill/${pid}`, { method: 'POST' }).then(r => r.ok).catch(() => false)));
      const failed = results.filter(ok => !ok).length;
      if (failed) showToast(`Killed ${pids.length - failed}, ${failed} failed`, 'warn');
      else showToast(pids.length > 1 ? `Killed ${pids.length} processes` : `Process ${pids[0]} killed`);
      setTimeout(() => loadPorts(true), 800);
    }

    function killProcess(pid) { return killPids([pid], `Kill process ${pid}?`); }

    function killGroup(btn) {
      const group = btn.closest('tr').dataset.key.slice(2);
      const ports = getFilteredAndSortedPorts().filter(p => groupKeyFor(p) === group);
      killPids(ports.map(p => p.pid), `Kill all ${ports.length} processes in ${group}?`);
    }

    async function restartProcess(pid) {
      closeAllMenus();
      try {
        const res = await fetch(`/api/restart/${pid}`, { method: 'POST' });
        if (res.ok) { showToast(`SIGHUP sent to ${pid}`); setTimeout(() => loadPorts(true), 1500); }
        else { showToast('Failed to restart', 'warn'); }
      } catch { showToast('Failed to restart', 'warn'); }
    }

    // ── Editor ────────────────────────────────────────────────────────
    let editors = [];
    function editorName() {
      return editors.includes(currentSettings.editor) ? currentSettings.editor : (editors[0] || 'editor');
    }
    async function openEditor(dir) {
      const res = await fetch('/api/open-editor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }),
      }).catch(() => null);
      const d = res && await res.json().catch(() => ({}));
      if (res?.ok) showToast(`Opened in ${d.editor}`);
      else showToast(d?.error || 'Failed to open editor', 'warn');
    }

    // ── Logs ──────────────────────────────────────────────────────────
    let logsTimer = null;
    async function openLogs(pid, port) {
      $('logsTitle').textContent = `Logs \u00B7 :${port} \u00B7 pid ${pid}`;
      $('logsBody').textContent = 'Loading\u2026';
      $('logsMeta').textContent = '';
      $('logsModal').style.display = 'flex';
      const body = $('logsBody');
      const tick = async () => {
        const d = await fetch(`/api/logs/${pid}`).then(r => r.json()).catch(() => null);
        if (!d) return;
        if (!d.logs.length) {
          clearInterval(logsTimer);
          $('logsMeta').textContent = '';
          body.textContent = d.tty
            ? `This process writes to a terminal (${d.tty}). Its output lives in that terminal window and can't be read from outside.`
            : d.piped
              ? 'Output goes to a pipe owned by its parent app, so there is no log file to show.'
              : 'No stdout/stderr found. The process may have exited.';
          return;
        }
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        $('logsMeta').textContent = d.logs.map(l => l.file).join('  \u00B7  ');
        body.textContent = d.logs.map(l => l.error ? `[${l.error}]` : l.text).join('\n');
        if (atBottom) body.scrollTop = body.scrollHeight;
      };
      clearInterval(logsTimer);
      await tick();
      body.scrollTop = body.scrollHeight;
      logsTimer = setInterval(tick, 1000);
    }
    function closeLogs() { clearInterval(logsTimer); $('logsModal').style.display = 'none'; }
    $('logsClose').addEventListener('click', closeLogs);
    $('helpClose').addEventListener('click', () => { $('helpModal').style.display = 'none'; });
    $('helpModal').addEventListener('click', (e) => { if (e.target === $('helpModal')) $('helpModal').style.display = 'none'; });
    $('logsModal').addEventListener('click', (e) => { if (e.target === $('logsModal')) closeLogs(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('logsModal').style.display !== 'none') { e.stopImmediatePropagation(); closeLogs(); }
    }, true);

    // ── Open terminal ─────────────────────────────────────────────────
    async function openTerminal(dir) {
      try {
        const res = await fetch('/api/open-terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        if (res.ok) showToast(`Terminal opened at ${dir.split('/').pop()}`);
        else showToast('Failed to open terminal', 'warn');
      } catch { showToast('Failed to open terminal', 'warn'); }
    }

    // ── Favorites ────────────────────────────────────────────────────
    async function toggleFavorite(port, isFav) {
      const method = isFav ? 'DELETE' : 'POST';
      await fetch(`/api/favorites/${port}`, { method });
      // Update local state
      allPorts.forEach(p => {
        if (p.port === port) p.favorite = !isFav;
      });
      renderTable();
      showToast(isFav ? `Port ${port} unpinned` : `Port ${port} pinned`);
    }

    // ── Notifications ────────────────────────────────────────────────
    // The server only lists a port after it survived 2 scans and drops it after
    // 2 misses (or at once if the process died), so changes here are real.
    let notifiedPorts = new Set();  // ports we've announced as up
    let notifyReady = false;        // skip until first load
    const lastInfo = {};

    function checkNotifications() {
      if (!notifyReady) return;
      const currSet = new Set(allPorts.map(p => p.port));
      allPorts.forEach(p => { lastInfo[p.port] = p; });
      for (const port of currSet) {
        if (notifiedPorts.has(port)) continue;
        notifiedPorts.add(port);
        const p = lastInfo[port];
        if (currentSettings.notifications) notify(`Port ${port} is up`, `${p.runtimeName} process started (${p.command})`);
      }
      for (const port of [...notifiedPorts]) {
        if (currSet.has(port)) continue;
        notifiedPorts.delete(port);
        const prev = lastInfo[port];
        if (currentSettings.notifications) notify(`Port ${port} is down`, prev ? `${prev.runtimeName} process stopped` : 'Process stopped');
        delete lastInfo[port];
      }
    }

    function notify(title, body) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
      }
      showToast(`${title}: ${body}`, 'info');
    }

    async function requestNotificationPermission() {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    }

    // ── Export ────────────────────────────────────────────────────────
    function updateExportVisibility(show) {
      const wrapper = $('exportBtn')?.closest('.export-wrapper');
      if (wrapper) wrapper.style.display = show ? '' : 'none';
    }

    function exportAs(format) {
      const data = getFilteredAndSortedPorts();
      let output = '';

      if (format === 'json') {
        output = JSON.stringify(data.map(p => ({
          port: p.port, pid: p.pid, user: p.user,
          process: p.command, runtime: p.runtimeName, path: p.scriptPath,
        })), null, 2);
      } else if (format === 'markdown') {
        output = '| Port | PID | User | Process | Runtime | Path |\n';
        output += '|------|-----|------|---------|---------|------|\n';
        data.forEach(p => {
          output += `| ${p.port || '-'} | ${p.pid} | ${p.user || '-'} | ${p.command} | ${p.runtimeName} | ${p.scriptPath || '-'} |\n`;
        });
      } else if (format === 'csv') {
        output = 'Port,PID,User,Process,Runtime,Path\n';
        data.forEach(p => {
          output += `${p.port || ''},${p.pid},${p.user || ''},${p.command},${p.runtimeName},"${p.scriptPath || ''}"\n`;
        });
      }

      navigator.clipboard.writeText(output).then(() => {
        showToast(`Copied as ${format.toUpperCase()}`);
      });

      $('exportMenu').classList.remove('open');
    }

    $('exportBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('exportMenu').classList.toggle('open');
    });

    // ── Actions menu ─────────────────────────────────────────────────
    let activeMenuId = null;

    const menuBackdrop = $('menuBackdrop');
    const floatingMenu = $('floatingMenu');

    function closeAllMenus() {
      floatingMenu.classList.remove('open');
      floatingMenu.innerHTML = '';
      document.querySelectorAll('.export-menu').forEach(m => m.classList.remove('open'));
      menuBackdrop.classList.remove('open');
      activeMenuId = null;
    }

    function toggleActionsMenu(id, triggerEl) {
      const sourceMenu = document.getElementById(`menu-${id}`);
      if (!sourceMenu) return;

      const wasOpen = activeMenuId === id;
      closeAllMenus();
      if (wasOpen) return;

      floatingMenu.innerHTML = sourceMenu.innerHTML;

      const rect = triggerEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;

      if (spaceBelow < 120) {
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
      activeMenuId = id;
    }

    function isAnyMenuOpen() {
      return activeMenuId !== null;
    }

    menuBackdrop.addEventListener('click', closeAllMenus);
    floatingMenu.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        setTimeout(closeAllMenus, 50);
      }
    });

    // ── Filter & sort ────────────────────────────────────────────────
    const NUMERIC_COLUMNS = new Set(['port', 'pid', 'cpu', 'memMB', 'startedAt']);

    function getFilteredAndSortedPorts() {
      const term = searchInput.value.toLowerCase();
      const rtFilter = runtimeFilter.value;

      let filtered = allPorts.filter(p => {
        const matchesSearch = !term ||
          String(p.port || '').includes(term) ||
          String(p.pid || '').toLowerCase().includes(term) ||
          String(p.user || '').toLowerCase().includes(term) ||
          String(p.command || '').toLowerCase().includes(term) ||
          String(p.runtimeName || '').toLowerCase().includes(term) ||
          String(p.scriptPath || '').toLowerCase().includes(term) ||
          [p.appName, p.procName, p.branch, p.launcher?.name].some(v => String(v || '').toLowerCase().includes(term)) ||
          (term === 'orphan' && p.orphan) || (term === 'idle' && p.idle);

        const matchesRuntime = rtFilter === 'all' || p.runtime === rtFilter;
        return matchesSearch && matchesRuntime;
      });

      // Favorites first, then sort
      filtered.sort((a, b) => {
        if (a.favorite && !b.favorite) return -1;
        if (!a.favorite && b.favorite) return 1;

        let aVal = a[sortColumn];
        let bVal = b[sortColumn];
        if (NUMERIC_COLUMNS.has(sortColumn)) {
          aVal = parseFloat(aVal) || 0;
          bVal = parseFloat(bVal) || 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });

      return filtered;
    }

    let lastFiltersKey = '';
    function updateFilters() {
      const runtimes = new Set();
      allPorts.forEach(p => runtimes.add(p.runtime));
      const key = Array.from(runtimes).sort().join(',');
      if (key === lastFiltersKey) return;
      lastFiltersKey = key;

      const cur = runtimeFilter.value;
      runtimeFilter.innerHTML = '<option value="all">All Runtimes</option>';
      Array.from(runtimes).sort().forEach(rt => {
        const opt = document.createElement('option');
        opt.value = rt;
        opt.textContent = runtimeDefs[rt]?.name || rt;
        runtimeFilter.appendChild(opt);
      });
      if (cur !== 'all' && runtimes.has(cur)) runtimeFilter.value = cur;
    }

    let lastPillsKey = '';
    // Same folder, different (unrelated) processes -> probably a second dev server by mistake
    function markDuplicates() {
      const byPath = {};
      allPorts.forEach(p => { p.dupOf = []; if (hasProject(p)) (byPath[p.scriptPath] ||= []).push(p); });
      // parent/child (cluster master + worker) is one server, not a duplicate
      const related = (a, b) => a.pid === b.pid || a.ppid === b.pid || b.ppid === a.pid;
      Object.values(byPath).forEach(list => list.forEach(a => {
        a.dupOf = list.filter(b => !related(a, b)).map(b => ({ port: b.port, pid: b.pid }));
      }));
    }

    const announcedDups = new Set();
    function announceDuplicates() {
      const now = new Set();
      allPorts.forEach(p => {
        if (!p.dupOf.length) return;
        now.add(p.scriptPath);
        if (notifyReady && !announcedDups.has(p.scriptPath)) {
          const ports = [p.port, ...p.dupOf.map(d => d.port)].sort((a, b) => a - b).map(x => ':' + x).join(', ');
          if (currentSettings.notifications) notify('Duplicate dev server', `${p.scriptPath.split('/').slice(-2).join('/')} is running on ${ports}`);
        }
      });
      announcedDups.clear(); now.forEach(k => announcedDups.add(k));
    }

    function updateIdle() {
      const idle = allPorts.filter(p => p.idle);
      const btn = $('idleBtn');
      btn.style.display = idle.length ? '' : 'none';
      btn.textContent = `${idle.length} idle`;
    }

    function updateOrphans() {
      const orphans = allPorts.filter(p => p.orphan);
      const btn = $('orphanBtn');
      btn.style.display = orphans.length ? '' : 'none';
      btn.textContent = `${orphans.length} orphaned`;
    }

    function updateRuntimePills() {
      const counts = {};
      allPorts.forEach(p => { counts[p.runtime] = (counts[p.runtime] || 0) + 1; });
      const key = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}:${c}`).join(',');
      if (key === lastPillsKey) return; // no change
      lastPillsKey = key;
      runtimePills.innerHTML = '';
      Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([rt, count]) => {
        const color = runtimeDefs[rt]?.color || '#6b7280';
        const name = runtimeDefs[rt]?.name || rt;
        const pill = document.createElement('span');
        pill.className = 'runtime-pill';
        pill.style.cssText = `background:${color}18;color:${color};border:1px solid ${color}40;`;
        pill.title = `${count} ${name}`;
        pill.innerHTML = `${runtimeIconHTML(rt, color, runtimeDefs[rt]?.icon, 12)}<span class="pill-count">${count}</span>`;
        runtimePills.appendChild(pill);
      });
    }

    // ── Render (reconciliation — only patch what changed) ─────────────
    let renderedKeys = []; // track what's currently in DOM

    function rowKey(p) { return `${p.pid}:${p.port}`; }

    function formatMem(mb) {
      if (!mb || mb === 0) return '0 MB';
      if (mb < 1024) return Math.round(mb) + ' MB';
      return (mb / 1024).toFixed(1) + ' GB';
    }

    // Official logo when we have one, letter badge otherwise
    function runtimeIconHTML(key, color, letters, size = 16) {
      const d = RUNTIME_ICONS[key];
      return d
        ? `<svg class="runtime-logo" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}" aria-hidden="true"><path d="${d}"/></svg>`
        : `<span class="runtime-icon" style="background:${color}">${esc(letters || '?')}</span>`;
    }

    // Icon + process name (only when it isn't just the runtime binary) + subtle version
    function processCell(p) {
      const cmd = String(p.procName || p.command || '');
      const plain = cmd.toLowerCase().startsWith(p.runtime) || cmd.toLowerCase().startsWith(String(p.runtimeName).toLowerCase());
      const tip = [`${p.runtimeName}${p.version ? ' ' + p.version : ''}`, `process: ${cmd}`, p.exePath, `user: ${p.user}`,
        p.launcher && `launched by ${p.launcher.name}`].filter(Boolean).join('\n');
      // logo, then label with the version stacked underneath
      return `<span class="proc" title="${esc(tip)}">
        ${runtimeIconHTML(p.runtime, p.runtimeColor, p.runtimeIcon)}
        <span class="proc-text">
          <span class="proc-name trunc ${plain ? 'is-runtime' : ''}">${esc(plain ? p.runtimeName : cmd)}</span>
          ${p.version ? `<span class="proc-ver">v${esc(p.version)}</span>` : ''}
        </span>
      </span>`;
    }

    function chipsHTML(p) {
      let html = '';
      if (p.branch) html += `<span class="branch trunc" title="git branch: ${esc(p.branch)}">\u2387 ${esc(p.branch)}</span>`;
      if (p.launcher?.kind === 'agent') {
        const ico = AGENT_ICONS[p.launcher.name];
        html += ico
          ? `<span class="agent-ico" title="Started by ${esc(p.launcher.name)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="${ico.color}"><path d="${ico.d}"/></svg></span>`
          : `<span class="chip chip-agent" title="Started from a ${esc(p.launcher.name)} session">${esc(p.launcher.name)}</span>`;
      }
      if (p.idle) html += `<span class="chip chip-idle" title="No real CPU activity since ${new Date(p.lastActive).toLocaleString()}">idle ${timeAgo(p.lastActive).replace(' ago', '')}</span>`;
      if (p.dupOf?.length) html += `<span class="chip chip-dup" title="Another server from this folder is running:\n${p.dupOf.map(d => `:${d.port} (pid ${d.pid})`).join('\n')}">also on :${p.dupOf[0].port}</span>`;
      if (p.orphan) html += `<span class="chip chip-orphan" title="Parent process exited: probably left behind by a closed terminal or agent session">orphan</span>`;
      return html;
    }

    function contextLine(p) {
      return [`port ${p.port}`, `${p.runtimeName}${p.version ? ' ' + p.version : ''}`, `pid ${p.pid}`,
        p.scriptPath, p.branch && `branch ${p.branch}`, p.launcher && `via ${p.launcher.name}`].filter(Boolean).join(' \u00B7 ');
    }

    function copyText(text, label) {
      navigator.clipboard.writeText(text).then(() => showToast(`${label} copied`));
    }

    function timeAgo(ts) {
      const s = Math.max(0, (Date.now() - ts) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    }

    // In group view the group header already shows the common prefix
    function tildify(path) {
      const home = currentSettings.home;
      return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
    }

    function displayPath(path) {
      if (groupBy !== 'project') return tildify(path);
      const group = getGroupKey(path, groupingDepth);
      return path.startsWith(group + '/') ? '\u2026/' + path.slice(group.length + 1) : tildify(path);
    }

    // CPU: dim at zero, colored only when it's actually busy
    function cpuClass(cpu) { return cpu >= 80 ? 'cpu-hot' : cpu >= 30 ? 'cpu-warm' : cpu < 0.05 ? 'cpu-zero' : ''; }

    function usageColor(val, max) {
      if (val < max * 0.3) return 'var(--green)';
      if (val < max * 0.7) return 'var(--yellow)';
      return 'var(--red)';
    }

    function rowHTML(p) {
      const health = healthMap[p.port] || 'checking';
      const uid = `${p.pid}-${p.port}`;
      return `
        <td><button class="fav-btn ${p.favorite ? 'is-fav' : ''}" onclick="toggleFavorite(${p.port}, ${p.favorite})" title="${p.favorite ? 'Unpin' : 'Pin to top'}">${p.favorite ? '\u2605' : '\u2606'}</button></td>
        <td><span class="health-dot ${health}" data-port="${p.port}" title="${health}"></span>${p.port
          ? `<a href="http://localhost:${p.port}" target="_blank" class="code port-link" title="Open in browser">${p.port}</a>`
          : '<span class="code">&mdash;</span>'
        }</td>
        <td><span class="pid-copy" onclick="navigator.clipboard.writeText('${p.pid}');showToast('PID ${p.pid} copied')" title="Click to copy PID">${p.pid}</span></td>
        <td class="col-user">${p.startedAt
          ? `<span class="trunc started" title="${new Date(p.startedAt).toLocaleString()}">${timeAgo(p.startedAt)}</span>`
          : '<span class="code">\u2014</span>'}</td>
        <td class="col-cmd">${processCell(p)}</td>
        <td class="col-path"><span class="path-cell">${hasProject(p)
          ? `<span class="path-link trunc" data-path="${esc(p.scriptPath)}" onclick="copyText(this.dataset.path, 'Path')" oncontextmenu="event.preventDefault();openTerminal(this.dataset.path)" title="${esc(p.scriptPath)}\nClick to copy \u00B7 Right-click to open terminal">${esc(displayPath(p.scriptPath))}</span>`
          : `<span class="app-name trunc" title="No project directory${p.appName ? ', owned by ' + esc(p.appName) : ''}">${esc(p.appName || '\u2014')}</span>`
        }${chipsHTML(p)}</span></td>
        <td class="usage-cell ${cpuClass(p.cpu || 0)}" title="CPU: ${p.cpu || 0}%">${(p.cpu || 0).toFixed(1)}%</td>
        <td class="usage-cell" title="Memory: ${formatMem(p.memMB || 0)}">
          <span class="usage-bar ${(p.memMB || 0) > 2048 ? 'hot' : ''}" style="width:${Math.max(3, Math.min((p.memMB || 0) / 1024 * 40, 40))}px;"></span>${formatMem(p.memMB || 0)}
        </td>
        <td class="actions-cell" style="text-align:right;">
          <button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('${uid}',this)">
            \u22EF
          </button>
          <div class="actions-menu" id="menu-${uid}">
            ${hasProject(p) ? `<button onclick="openEditor(this.dataset.path)" data-path="${esc(p.scriptPath)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              Open in ${esc(editorName())}
            </button>` : ''}
            ${p.github && p.branch ? `<button onclick="window.open(this.dataset.url)" data-url="${esc(p.github + '/tree/' + p.branch.split('/').map(encodeURIComponent).join('/'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              Open branch on GitHub
            </button>` : ''}
            <button onclick="openLogs('${p.pid}', ${p.port})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              View logs
            </button>
            <div class="actions-divider"></div>
            <button onclick="copyText('http://localhost:${p.port}', 'URL')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Copy URL
            </button>
            <button onclick="copyText(this.dataset.ctx, 'Context')" data-ctx="${esc(contextLine(p))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy context for agent
            </button>
            <button onclick="restartProcess('${p.pid}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Restart (SIGHUP)
            </button>
            <div class="actions-divider"></div>
            <button class="danger" onclick="killProcess('${p.pid}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              Kill process
            </button>
          </div>
        </td>`;
    }

    function hasProject(p) { return !!p.scriptPath && p.scriptPath !== '/'; }

    function groupKeyFor(p) {
      if (groupBy === 'session') return sessionKey(p);
      return hasProject(p) ? getGroupKey(p.scriptPath, groupingDepth) : (p.appName || 'Unknown');
    }

    // One group per agent process: everything a single Claude/Codex session spawned
    function sessionKey(p) {
      const l = p.launcher;
      if (l?.kind === 'agent') {
        const where = l.cwd ? l.cwd.split('/').slice(-2).join('/') : '';
        return `${l.name}${where ? ' \u00B7 ' + where : ''} \u00B7 pid ${l.pid}`;
      }
      if (l?.kind === 'app') return `Started from ${l.name}`;
      return p.orphan ? 'Orphaned (session gone)' : 'No agent';
    }

    function getGroupKey(scriptPath, depth) {
      if (!scriptPath || scriptPath === '/') return 'Unknown';
      const parts = scriptPath.replace(/\/$/, '').split('/');
      if (parts.length > depth) {
        return parts.slice(0, parts.length - depth).join('/');
      }
      return scriptPath;
    }

    // Fingerprint a port entry for change detection
    function portFingerprint(p) {
      return `${p.pid}|${p.port}|${p.user}|${p.command}|${p.runtime}|${p.scriptPath}|${p.favorite}|${(p.cpu||0).toFixed(1)}|${p.memMB||0}|${p.startedAt && timeAgo(p.startedAt)}|${p.version}|${p.branch}|${p.orphan}|${p.appName}|${p.procName}|${p.idle}|${(p.dupOf || []).map(d => d.port)}|${p.health}`;
    }

    let lastFingerprints = {};
    let lastFilteredKeys = '';

    function renderTable() {
      const filtered = getFilteredAndSortedPorts();

      const filtering = searchInput.value || runtimeFilter.value !== 'all';
      const killBtn = $('killFilteredBtn');
      killBtn.style.display = filtering && filtered.length ? '' : 'none';
      killBtn.textContent = `\u2715 Kill ${filtered.length} matching`;

      // Update counters
      if (allPorts.length === 0) {
        resultInfo.textContent = '';
      } else if (filtered.length !== allPorts.length) {
        resultInfo.textContent = `Showing ${filtered.length} of ${allPorts.length}`;
      } else {
        resultInfo.textContent = '';
      }

      if (filtered.length === 0) {
        emptyStateEl.style.display = 'block';
        emptyStateEl.textContent = (searchInput.value || runtimeFilter.value !== 'all')
          ? 'No processes match your filters.'
          : 'No dev processes currently listening. Start a dev server and it will appear here.';
        if (tableBody.children.length > 0) {
          tableBody.innerHTML = '';
          renderedKeys = [];
          lastFingerprints = {};
          lastFilteredKeys = '';
        }
        return;
      }

      emptyStateEl.style.display = 'none';

      // Build the desired row list (flat, no grouping for reconciliation)
      let rows;
      if (groupBy !== 'none') {
        rows = [];
        const groups = {};
        filtered.forEach(p => {
          const key = groupKeyFor(p);
          if (!groups[key]) groups[key] = [];
          groups[key].push(p);
        });
        const total = (ports, col) => ports.reduce((s, p) => s + (p[col] || 0), 0);
        const entries = Object.entries(groups);
        if (sortColumn === 'cpu' || sortColumn === 'memMB') {
          const dir = sortDirection === 'asc' ? 1 : -1;
          entries.sort((a, b) => dir * (total(a[1], sortColumn) - total(b[1], sortColumn)));
        } else {
          entries.sort((a, b) => a[0].localeCompare(b[0]));
        }
        entries.forEach(([groupPath, ports]) => {
          rows.push({ _groupHeader: true, groupPath, count: ports.length, cpu: total(ports, 'cpu'), memMB: total(ports, 'memMB') });
          ports.forEach(p => rows.push(p));
        });
      } else {
        rows = filtered;
      }

      // Build a key for the full list to detect structural changes (add/remove/reorder)
      const newKeys = rows.map(r => r._groupHeader ? `g:${r.groupPath}` : rowKey(r)).join(',');

      // If structure changed, do full rebuild
      if (newKeys !== lastFilteredKeys) {
        tableBody.innerHTML = '';
        lastFingerprints = {};

        let collapsed = false;
        rows.forEach(r => {
          const tr = document.createElement('tr');
          if (r._groupHeader) {
            // gap before every group, including the first (separates it from the header bar)
            const gap = document.createElement('tr');
            gap.className = 'group-gap';
            gap.innerHTML = '<td colspan="9"></td>';
            tableBody.appendChild(gap);
            collapsed = collapsedGroups.has(r.groupPath);
            tr.dataset.key = `g:${r.groupPath}`;
            tr.className = 'group-row';
            tr.innerHTML = `<td colspan="9">
              <div class="group-header ${collapsed ? 'collapsed' : ''}" onclick="toggleGroup(this)">
                <span class="group-chevron">\u25BC</span>
                <span class="group-name trunc" title="${esc(r.groupPath)}">${esc(r.groupPath.startsWith('/') ? tildify(r.groupPath) : r.groupPath)}</span>
                <span class="group-count">${r.count}</span>
                <span class="group-usage">${r.cpu.toFixed(1)}% CPU \u00B7 ${formatMem(r.memMB)}</span>
                <button class="group-kill" onclick="event.stopPropagation();killGroup(this)" title="Kill all ${r.count} in this group">\u2715</button>
              </div></td>`;
          } else {
            if (collapsed) tr.style.display = 'none';
            const key = rowKey(r);
            tr.dataset.key = key;
            if (r.favorite) tr.classList.add('is-favorite');
            tr.innerHTML = rowHTML(r);
            lastFingerprints[key] = portFingerprint(r);
          }
          tableBody.appendChild(tr);
        });

        lastFilteredKeys = newKeys;
        renderedKeys = newKeys.split(',');
        return;
      }

      // Structure same — only patch cells that changed (reconciliation)
      const existingRows = tableBody.querySelectorAll('tr[data-key]');
      let idx = 0;
      rows.forEach(r => {
        if (r._groupHeader) {
          const usage = existingRows[idx++]?.querySelector('.group-usage');
          if (usage) usage.textContent = `${r.cpu.toFixed(1)}% CPU · ${formatMem(r.memMB)}`;
          return;
        }
        const key = rowKey(r);
        const fp = portFingerprint(r);
        const tr = existingRows[idx];
        idx++;

        if (!tr || lastFingerprints[key] === fp) return;

        // Something changed — patch this row
        if (r.favorite) tr.classList.add('is-favorite');
        else tr.classList.remove('is-favorite');
        tr.innerHTML = rowHTML(r);
        lastFingerprints[key] = fp;
      });
    }

    function toggleGroup(headerEl) {
      const tr = headerEl.closest('tr');
      const group = tr.dataset.key.slice(2);
      const collapsed = headerEl.classList.toggle('collapsed');
      if (collapsed) collapsedGroups.add(group); else collapsedGroups.delete(group);
      saveView();
      let next = tr.nextElementSibling;
      while (next && !next.classList.contains('group-gap') && !next.querySelector('.group-header')) {
        next.style.display = collapsed ? 'none' : '';
        next = next.nextElementSibling;
      }
    }

    // ── Short-lived listeners ────────────────────────────────────────
    // The server hides listeners that didn't survive 2 scans and reports them here.
    let transientLog = [];

    function updateTransient() {
      const btn = $('transientBtn');
      const recent = transientLog;
      btn.style.display = recent.length ? '' : 'none';
      btn.textContent = `${recent.length} short-lived`;
      const lines = recent.slice(0, 12).map(t =>
        `:${t.port}  ${t.procName || t.command}  pid ${t.pid}${t.launcher ? '  via ' + t.launcher.name : ''}  ${timeAgo(t.at)}`);
      btn.dataset.tip = `Listeners that lived under a few seconds (last 10 min), hidden from the table:\n${lines.join('\n')}`
        + (recent.length > 12 ? `\n+${recent.length - 12} more` : '');
    }

    // ── Load ports ───────────────────────────────────────────────────
    function handlePortsData(data, fromWS) {
      if (isAnyMenuOpen()) return;

      previousPorts = [...allPorts];
      allPorts = data.ports || [];
      healthMap = Object.fromEntries(allPorts.map(p => [p.port, p.health]));
      transientLog = data.transient || [];
      updateTransient();
      markDuplicates();
      announceDuplicates();

      countEl.textContent = allPorts.length;

      // Only check notifications on WebSocket updates (not initial HTTP load)
      if (fromWS) checkNotifications();

      updateFilters();
      updateRuntimePills();
      updateOrphans();
      updateIdle();
      renderTable();
    }

    async function loadPorts(force) {
      try {
        const res = await fetch('/api/ports');
        const data = await res.json();
        handlePortsData(data, false);
        // After first successful load, seed the notified set and enable notifications
        if (!notifyReady) {
          notifiedPorts = new Set(allPorts.map(p => p.port));
          allPorts.forEach(p => { lastInfo[p.port] = p; });
          notifyReady = true;
        }
      } catch (err) {
        console.error('Failed to load ports', err);
      }
    }

    function connectWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onopen = () => { $('offlineBadge').style.display = 'none'; };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ports') handlePortsData(data, true);
          if (data.type === 'reaped') {
            const ports = data.reaped.map(r => ':' + r.port).join(', ');
            notify('Idle servers stopped', `Auto-killed ${data.reaped.length}: ${ports}`);
          }
        } catch {}
      };

      ws.onclose = () => {
        $('offlineBadge').style.display = '';
        // Reconnect after 2s
        setTimeout(connectWebSocket, 2000);
      };

      ws.onerror = () => ws.close();
    }

    // ── Settings modal ───────────────────────────────────────────────
    async function openSettings() {
      const [sRes, rRes] = await Promise.all([fetch('/api/settings'), fetch('/api/runtimes')]);
      currentSettings = await sRes.json();
      runtimeDefs = await rRes.json();

      $('showOther').checked = currentSettings.showOtherProcesses || false;
      $('notificationsToggle').checked = currentSettings.notifications !== false;
      $('groupingDepth').value = String(currentSettings.groupingDepth ?? 1);
      $('showHistoryToggle').checked = currentSettings.showHistory !== false;
      $('showExportToggle').checked = currentSettings.showExport || false;
      $('idleAfterHours').value = String(currentSettings.idleAfterHours ?? 24);
      $('autoKillIdle').checked = !!currentSettings.autoKillIdle;
      editors = await fetch('/api/editors').then(r => r.json()).catch(() => []);
      $('editorSelect').innerHTML = editors.length
        ? editors.map(e => `<option ${e === editorName() ? 'selected' : ''}>${esc(e)}</option>`).join('')
        : '<option value="">None installed</option>';

      const container = $('runtimeToggles');
      container.innerHTML = '';
      Object.entries(runtimeDefs).sort((a, b) => a[1].name.localeCompare(b[1].name)).forEach(([key, rt]) => {
        const enabled = currentSettings.runtimes?.[key]?.enabled ?? true;
        const div = document.createElement('div');
        div.className = 'runtime-toggle';
        div.title = `Matches: ${rt.commands.join(', ') || 'unrecognized processes'}`;
        div.innerHTML = `
          <div class="runtime-toggle-left">
            ${runtimeIconHTML(key, rt.color, rt.icon, 18)}
            <div class="runtime-toggle-info">
              <h4>${rt.name}</h4>
            </div>
          </div>
          <label class="toggle">
            <input type="checkbox" data-runtime="${key}" ${enabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        `;
        container.appendChild(div);
      });

      $('settingsModal').style.display = 'block';
    }

    function closeSettings() { $('settingsModal').style.display = 'none'; }

    // "Saved · Notifications on", "Saved · Python off", "Saved · Grouping depth 2"
    function describeChange(el) {
      const row = el?.closest('.settings-row, .runtime-toggle');
      const name = row?.querySelector('h4, label')?.textContent.trim();
      if (!name) return '';
      if (el.type === 'checkbox') return `${name} ${el.checked ? 'on' : 'off'}`;
      return `${name}: ${el.options?.[el.selectedIndex]?.text || el.value}`;
    }

    async function saveSettings(what) {
      const runtimes = {};
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => {
        runtimes[i.dataset.runtime] = { enabled: i.checked };
      });

      const notifs = $('notificationsToggle').checked;
      if (notifs) requestNotificationPermission();

      const newDepth = parseInt($('groupingDepth').value);
      groupingDepth = newDepth;

      const body = {
        runtimes,
        showOtherProcesses: $('showOther').checked,
        notifications: notifs,
        groupingDepth: newDepth,
        showHistory: $('showHistoryToggle').checked,
        showExport: $('showExportToggle').checked,
        idleAfterHours: parseInt($('idleAfterHours').value),
        autoKillIdle: $('autoKillIdle').checked,
        editor: $('editorSelect').value,
      };

      const ok = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.ok).catch(() => false);
      if (!ok) return showToast('Could not save settings', 'warn', 'settings');

      currentSettings = { ...currentSettings, ...body };
      updateExportVisibility(body.showExport);
      lastFilteredKeys = ''; // grouping depth may have changed
      const label = typeof what === 'string' ? what : describeChange(what?.target);
      showToast(label ? `Saved \u00B7 ${label}` : 'Settings saved', 'success', 'settings');
      loadPorts(true);
    }

    // ── Group toggle ─────────────────────────────────────────────────
    const GROUP_MODES = ['none', 'project', 'session'];
    function setGroupBy(mode, render = true) {
      groupBy = mode;
      $('groupSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.g === mode));
      document.querySelector('.scroll').classList.toggle('grouped', mode !== 'none');
      saveView();
      lastFilteredKeys = '';
      if (render) renderTable();
    }
    $('groupSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setGroupBy(b.dataset.g); });
    setGroupBy(GROUP_MODES.includes(groupBy) ? groupBy : 'none', false);

    // ── Event listeners ──────────────────────────────────────────────
    function updateClearBtn() {
      clearBtn.style.display = (searchInput.value || runtimeFilter.value !== 'all') ? '' : 'none';
    }
    updateClearBtn();

    searchInput.addEventListener('input', () => { renderTable(); updateClearBtn(); });
    $('idleBtn').addEventListener('click', () => {
      const idle = allPorts.filter(p => p.idle);
      killPids(idle.map(p => p.pid), `Kill ${idle.length} idle server${idle.length > 1 ? 's' : ''}?`);
    });
    $('orphanBtn').addEventListener('click', () => {
      const orphans = allPorts.filter(p => p.orphan);
      killPids(orphans.map(p => p.pid), `Kill ${orphans.length} orphaned process${orphans.length > 1 ? 'es' : ''}?`);
    });
    $('killFilteredBtn').addEventListener('click', () => {
      const ports = getFilteredAndSortedPorts();
      const what = searchInput.value ? `matching "${searchInput.value}"` : 'matching the filter';
      killPids(ports.map(p => p.pid), `Kill all ${ports.length} processes ${what}?`);
    });
    runtimeFilter.addEventListener('change', () => { renderTable(); updateClearBtn(); });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      runtimeFilter.value = 'all';
      renderTable();
      updateClearBtn();
    });

$('settingsBtn').addEventListener('click', openSettings);
    $('modalClose').addEventListener('click', closeSettings);
    // Auto-save: every toggle/select change persists immediately
    $('settingsModal').addEventListener('change', saveSettings);
    // Esc always closes settings, whatever has focus inside it
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('settingsModal').style.display !== 'none' && $('confirmModal').style.display === 'none') {
        e.stopImmediatePropagation();
        closeSettings();
      }
    }, true);
    $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeSettings(); });

    // ── Settings panes: one section at a time, last one remembered ────
    const PANE_KEY = 'devdock:settings-pane';
    function showPane(name) {
      const btns = [...$('settingsNav').querySelectorAll('button[data-pane]')];
      if (!btns.some(b => b.dataset.pane === name)) name = btns[0].dataset.pane;
      btns.forEach(b => b.classList.toggle('active', b.dataset.pane === name));
      document.querySelectorAll('.settings-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
      try { localStorage.setItem(PANE_KEY, name); } catch {}
    }
    $('settingsNav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pane]');
      if (b) showPane(b.dataset.pane);
    });
    let initialPane = 'general';
    try { initialPane = localStorage.getItem(PANE_KEY) || 'general'; } catch {}
    showPane(initialPane);
    document.addEventListener('keydown', (e) => {
      if ($('settingsModal').style.display === 'none' || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      if (['SELECT', 'INPUT'].includes(e.target.tagName) && e.target.type !== 'checkbox') return;
      e.preventDefault();
      const btns = [...$('settingsNav').querySelectorAll('button[data-pane]')];
      const i = btns.findIndex(b => b.classList.contains('active'));
      showPane(btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length].dataset.pane);
    });

    $('clearHistory').addEventListener('click', async () => {
      if (!await confirmDialog('Clear all port history?', '', 'Clear')) return;
      await fetch('/api/history', { method: 'DELETE' });
      showToast('History cleared');
    });

    $('enableAll').addEventListener('click', () => {
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => i.checked = true);
      saveSettings('All runtimes on');
    });
    $('disableAll').addEventListener('click', () => {
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => i.checked = false);
      saveSettings('All runtimes off');
    });

    // Sortable columns
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.column;
        if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        else { sortColumn = col; sortDirection = 'asc'; }
        document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sorted', 'asc', 'desc'));
        th.classList.add('sorted', sortDirection);
        saveView();
        renderTable();
      });
    });
    document.querySelector(`th.sortable[data-column="${sortColumn}"]`)?.classList.add('sorted', sortDirection);

    // ── Keyboard shortcuts ───────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') { e.target.blur(); closeSettings(); }
        return;
      }
      switch (e.key) {
        case '?': if (!e.metaKey && !e.ctrlKey) window.devdockCommand('help'); break; // like GitHub, Gmail
        case 'Escape': closeSettings(); $('helpModal').style.display = 'none'; $('exportMenu').classList.remove('open'); break;
      }
    });

    // Menu bar and ⌘ shortcuts (see shortcuts.js)
    window.devdockCommand = (cmd) => {
      switch (cmd) {
        case 'settings': openSettings(); break;
        case 'find': searchInput.focus(); searchInput.select(); break;
        case 'view-none': case 'view-project': case 'view-session': setGroupBy(cmd.slice(5)); break;
        case 'history': window.location.href = '/history'; break;
        case 'export': if ($('exportBtn').offsetParent) $('exportBtn').click(); else showToast('Turn on the export button in Settings', 'info'); break;
        case 'theme': $('themeToggle').click(); break;
        case 'help': $('helpModal').style.display = 'flex'; break;
      }
    };
    if (location.hash === '#settings') { history.replaceState(null, '', '/'); openSettings(); }

    // ── Init ─────────────────────────────────────────────────────────
    (async function init() {
      const [rtRes, stRes] = await Promise.all([fetch('/api/runtimes'), fetch('/api/settings')]);
      runtimeDefs = await rtRes.json();
      currentSettings = await stRes.json();
      fetch('/api/editors').then(r => r.json()).then(list => { editors = list; lastFilteredKeys = ''; }).catch(() => {});

      setTheme(currentSettings.theme || 'dark');
      groupingDepth = currentSettings.groupingDepth ?? 1;
      if (currentSettings.notifications) requestNotificationPermission();
      updateExportVisibility(currentSettings.showExport);

      const q = new URLSearchParams(location.search).get('q'); // ?q= deep-links a search
      if (q) searchInput.value = q;
      loadPorts();
      connectWebSocket();
    })();

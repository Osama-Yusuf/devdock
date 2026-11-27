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
        icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
      } else {
        icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
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
      if (!pids.length) return false;
      if (!await confirmDialog(message, `PID${pids.length > 1 ? 's' : ''} ${pids.join(', ')}`)) return false;
      const results = await Promise.all(pids.map(pid =>
        fetch(`/api/kill/${pid}`, { method: 'POST' }).then(r => r.ok).catch(() => false)));
      const failed = results.filter(ok => !ok).length;
      if (failed) showToast(`Killed ${pids.length - failed}, ${failed} failed`, 'warn');
      else showToast(pids.length > 1 ? `Killed ${pids.length} processes` : `Process ${pids[0]} killed`);
      setTimeout(() => loadPorts(true), 800);
      return true;
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
    // ── Sessions inside DevDock: xterm.js on a pty the server runs (tmux attach, ...) ──
    const DETACH_KEYS = { tmux: 'Prefix + d', zellij: 'Ctrl+o d', screen: 'Ctrl+a d', herdr: 'Ctrl+b q' };
    let term = null;
    // Size the terminal to the modal, so the attached client gets the real grid.
    function fitTerm() {
      const cell = term._core._renderService.dimensions.css.cell; // ponytail: private xterm 5.5 API, swap for @xterm/addon-fit if it breaks
      const box = $('termBox');
      const cols = Math.max(20, Math.floor((box.clientWidth - 16) / cell.width));
      const rows = Math.max(5, Math.floor((box.clientHeight - 16) / cell.height));
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    }
    // params: { mux, id, target? } as the sessions source lists them
    // source: which sources/ module turns params into a command (agents runs a step's command)
    function openSession(params, title, source = 'sessions') {
      if (source === 'sessions' && (currentSettings.tmuxOpen || 'devdock') === 'terminal') return openSessionInTerminal(params, title);
      if (!ws || ws.readyState !== 1) return showToast('Not connected', 'warn');
      closeTerm();
      $('termTitle').textContent = title;
      $('termHint').innerHTML = `${DETACH_KEYS[params.mux] ? esc(DETACH_KEYS[params.mux]) + ' to detach, or ' : 'Close with '}<kbd>&#8984;.</kbd>`;
      $('termBox').innerHTML = '';
      $('termModal').style.display = 'flex';
      term = new Terminal({
        fontSize: 12, cursorBlink: true, scrollback: 0, macOptionIsMeta: true,
        // Nerd Fonts first, so prompt icons (powerlevel10k, starship) render when installed
        fontFamily: "'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', 'Symbols Nerd Font Mono', Menlo, monospace",
        theme: { background: '#0b0f17', foreground: '#e5e7eb', cursor: '#e5e7eb', selectionBackground: '#334155' },
      });
      term.open($('termBox'));
      fitTerm();
      term.onData(data => ws.send(JSON.stringify({ type: 'term-in', data })));
      term.onResize(({ cols, rows }) => ws.send(JSON.stringify({ type: 'term-resize', cols, rows })));
      term.focus();
      ws.send(JSON.stringify({ type: 'term-open', source, params, cols: term.cols, rows: term.rows }));
    }
    // A server's tmux pane: session name plus "session:window.pane"
    function attachTmux(session, target) {
      openSession({ mux: 'tmux', id: session, target: target.slice(session.length + 1) }, `tmux \u00B7 ${session}`);
    }
    window.addEventListener('resize', () => term && fitTerm());
    function closeTerm() {
      if ($('termModal').style.display === 'none') return;
      ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'term-close' }));
      term?.dispose(); term = null;
      $('termModal').style.display = 'none';
    }
    function handleTermMessage(m) {
      if (!term) return;
      if (m.type === 'term-out') term.write(m.data);
      else if (m.type === 'term-exit') {
        if (m.reason === 'Detached') return closeTerm(); // detach key, like a real terminal
        if (m.reason === 'Ended') { // keep what it printed, say how it ended
          term.options.disableStdin = true;
          term.write(m.code ? `\r\n\x1b[31m● Stopped with exit code ${m.code}.\x1b[0m The output above says why. Close when you're done.\r\n`
            : '\r\n\x1b[32m● Done.\x1b[0m Close when you\'re ready.\r\n');
          return;
        }
        term.dispose(); term = null;
        $('termBox').innerHTML = `<div class="term-status">${esc(m.reason)}</div>`;
      }
    }

    $('termClose').addEventListener('click', closeTerm);
    // Fill the whole window (remembered); the terminal refits to the new size
    function growTerm(on = !document.querySelector('.term-modal').classList.contains('max')) {
      document.querySelector('.term-modal').classList.toggle('max', on);
      $('termGrow').title = on ? 'Back to normal size  \u2318\u21E7\u21B5' : 'Fill the window  \u2318\u21E7\u21B5';
      try { localStorage.setItem('devdock:term-max', on ? '1' : ''); } catch {}
      requestAnimationFrame(() => term && fitTerm());
    }
    try { growTerm(localStorage.getItem('devdock:term-max') === '1'); } catch {}
    $('termGrow').addEventListener('click', () => { growTerm(); term?.focus(); });
    $('termModal').addEventListener('keydown', e => { if (e.metaKey && e.shiftKey && e.key === 'Enter') { e.preventDefault(); growTerm(); } }, true);
    // Every key belongs to the session (Esc included, for vim); only ⌘. closes.
    $('termModal').addEventListener('keydown', e => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key === '.' && $('termModal').style.display !== 'none') { e.preventDefault(); e.stopImmediatePropagation(); closeTerm(); }
    }, true);

    async function openSessionInTerminal(params, title) {
      const res = await fetch('/api/sources/sessions/open-in-terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      }).catch(() => null);
      showToast(res?.ok ? `Opened ${title} in Terminal` : 'Could not open the session', res?.ok ? 'success' : 'warn');
    }

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
      // in the app DevDock posts these natively itself, even with the window closed
      if (!window.__DEVDOCK_APP__ && window.Notification?.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
      }
      showToast(`${title}: ${body}`, 'info');
    }

    async function requestNotificationPermission() {
      if (!window.__DEVDOCK_APP__ && 'Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    }

    // ── Export ────────────────────────────────────────────────────────
    let exportOn = true;
    function updateExportVisibility(show) {
      exportOn = show !== false;
      refreshExport();
    }
    // What the current tab shows, as columns and rows. Servers knows its ports; a view can
    // say its own (exportRows); otherwise the biggest table on screen, minus action columns.
    function exportData() {
      if (DevDock.tab === 'servers') {
        return { name: 'servers', cols: ['Port', 'PID', 'User', 'Process', 'Runtime', 'Path'],
          rows: getFilteredAndSortedPorts().map(p => [p.port || '', p.pid, p.user || '', p.command, p.runtimeName, p.scriptPath || '']) };
      }
      const own = DevDockViews[DevDock.tab]?.exportRows?.();
      if (own) return { name: DevDock.tab, ...own };
      const t = [...document.querySelectorAll(`#${DevDock.tab}View table`)].filter(t => t.offsetParent)
        .sort((a, b) => b.tBodies[0]?.rows.length - a.tBodies[0]?.rows.length)[0];
      if (!t) return { name: DevDock.tab, cols: [], rows: [] };
      const head = [...t.tHead.rows[0].cells].map(c => c.textContent.trim());
      const keep = head.map((h, i) => h ? i : -1).filter(i => i >= 0);
      const text = c => c ? c.innerText.split('\n').map(x => x.trim()).filter(Boolean).join(' · ') : '';
      return { name: DevDock.tab, cols: keep.map(i => head[i]),
        rows: [...t.tBodies[0].rows].filter(r => r.offsetParent && r.cells.length >= keep.length).map(r => keep.map(i => text(r.cells[i]))) };
    }
    // Enabled only when there's something to export, like a toolbar item on the Mac
    function refreshExport() {
      const wrapper = $('exportBtn')?.closest('.export-wrapper');
      if (!wrapper) return;
      wrapper.style.display = exportOn ? '' : 'none';
      const n = exportOn ? exportData().rows.length : 0;
      $('exportBtn').disabled = !n;
      $('exportBtn').title = n ? `Copy ${n} ${n === 1 ? 'row' : 'rows'} from this tab` : 'Nothing to export on this tab';
      if (!n) $('exportMenu').classList.remove('open');
    }
    window.refreshExport = refreshExport;

    function exportAs(format) {
      const { name, cols, rows } = exportData();
      const md = v => String(v).replace(/\|/g, '\\|');
      const csv = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const output = format === 'json' ? JSON.stringify(rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), null, 2)
        : format === 'markdown' ? [`| ${cols.map(md).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(md).join(' | ')} |`)].join('\n') + '\n'
        : [cols, ...rows].map(r => r.map(csv).join(',')).join('\n') + '\n';
      navigator.clipboard.writeText(output).then(() => showToast(`Copied ${rows.length} ${name} ${rows.length === 1 ? 'row' : 'rows'} as ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}`));
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
      document.querySelectorAll('.actions-trigger.open').forEach(b => b.classList.remove('open'));
      activeMenuId = null;
    }

    function toggleActionsMenu(id, triggerEl) {
      const sourceMenu = document.getElementById(`menu-${id}`);
      if (!sourceMenu) return;

      const wasOpen = activeMenuId === id;
      closeAllMenus();
      if (wasOpen) return;

      floatingMenu.innerHTML = sourceMenu.innerHTML;
      triggerEl.classList.add('open');

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

    // Pattern chips (DevDockPatterns in js/selection.js): one folder's servers, one agent's,
    // orphans, idle ones, everything in one tmux session
    const SERVER_PATTERNS = [
      p => hasProject(p) && { id: `dir:${p.scriptPath}`, label: p.scriptPath.replace(/\/$/, '').split('/').pop(), title: `Servers from ${tildify(p.scriptPath)}` },
      p => p.launcher?.name && { id: `by:${p.launcher.name}`, label: p.launcher.name, title: `Started by ${p.launcher.name}` },
      p => p.tmux?.target && { id: `tmux:${p.tmux.target.split(':')[0]}`, label: `tmux ${p.tmux.target.split(':')[0]}`, title: `In tmux session ${p.tmux.target.split(':')[0]}` },
      p => p.orphan && { id: 'orphan', label: 'orphaned', title: 'Servers whose terminal or agent session is gone' },
      p => p.idle && { id: 'idle', label: 'idle', title: 'Servers with no CPU activity' },
    ];
    let patternSig = '';
    function renderServerPatterns() {
      const found = DevDockPatterns.find('servers', allPorts, rowKey, SERVER_PATTERNS);
      const html = DevDockPatterns.html('servers', found);
      if (html === patternSig) return;
      patternSig = html;
      $('serverPatterns').querySelector('.patterns').innerHTML = html;
    }

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
          [p.appName, p.procName, p.branch, p.launcher?.name, p.tmux && 'tmux ' + p.tmux.target].some(v => String(v || '').toLowerCase().includes(term)) ||
          (term === 'orphan' && p.orphan) || (term === 'idle' && p.idle);

        const matchesRuntime = rtFilter === 'all' || p.runtime === rtFilter;
        return matchesSearch && matchesRuntime;
      });
      filtered = DevDockPatterns.filter('servers', filtered, rowKey);

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

    // Sparkline with a soft area under it, and a dashed line where the alarm starts (Home, Containers)
    function sparkline(values, { color, limit, w = 148, h = 42 } = {}) {
      if (!(values?.length > 1)) return ''; // one point is no trend
      const max = Math.max(...values, limit || 0) * 1.08 || 1, min = limit ? 0 : Math.min(...values) * 0.92;
      const x = i => (i / Math.max(1, values.length - 1)) * w, y = v => h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
      const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const id = 'g' + Math.random().toString(36).slice(2, 8);
      return `<svg class="hspark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        ${limit ? `<line x1="0" x2="${w}" y1="${y(limit)}" y2="${y(limit)}" stroke="${color}" stroke-opacity=".45" stroke-dasharray="3 3"/>` : ''}
        <path d="${line}L${w},${h}L0,${h}Z" fill="url(#${id})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.6" fill="${color}"/>
      </svg>`;
    }

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

    // Agent logo when we have one, a labeled chip otherwise
    // A Claude Code session's state (server.js claudeState): working, needs you, or idle.
    // compact: just the icon, the words go in the tooltip (Sessions); otherwise icon and words
    const STATE_ICON = window.STATE_ICON = {
      working: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
      'needs-you': '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 5h2.4l-.4 7h-1.6zm1.2 8.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z"/></svg>',
      idle: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
    };
    function agentStateHTML(st, compact) {
      if (!st) return '';
      const mins = st.since ? Math.max(0, Math.floor((Date.now() - st.since) / 60000)) : null;
      const ago = mins == null ? '' : mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
      const LABEL = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle' };
      const TIP = {
        working: 'Claude Code is working on a turn',
        'needs-you': 'Waiting on you: a permission prompt or a question',
        idle: `Finished its turn${st.bgShell ? ', a background shell it started is still running' : ''}. Waiting for your next message`,
      };
      const tip = `${LABEL[st.status]}${ago ? ` for ${ago}` : ''}\n${TIP[st.status]}`;
      return `<span class="ast ast-${st.status} ${compact ? 'compact' : ''}" title="${esc(tip)}">${STATE_ICON[st.status]}${compact ? '' : `<span>${LABEL[st.status]}</span>${ago ? `<em>${ago}</em>` : ''}`}</span>`;
    }

    // a coding agent's own name (Claude's session name, else its folder) says more than "claude"
    function agentNames(match) {
      return (DevDock.sourceData.coding?.agents || []).filter(match).map(a => a.name);
    }
    function agentHTML(name, title) {
      const ico = AGENT_ICONS[name];
      return ico
        ? `<span class="agent-ico" title="${esc(title)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="${ico.color}"><path d="${ico.d}"/></svg></span>`
        : `<span class="chip chip-agent" title="${esc(title)}">${esc(name)}</span>`;
    }

    function chipsHTML(p) {
      let html = '';
      if (p.branch) html += `<span class="branch trunc" title="git branch: ${esc(p.branch)}">\u2387 ${esc(p.branch)}</span>`;
      if (p.launcher?.kind === 'agent') html += agentHTML(p.launcher.name, agentNames(a => a.pid == p.launcher.pid)[0] || `Started by ${p.launcher.name}`);
      if (p.tmux) html += `<span class="chip chip-tmux" data-session="${esc(p.tmux.session)}" data-target="${esc(p.tmux.target)}" onclick="attachTmux(this.dataset.session, this.dataset.target)" title="Running in tmux pane ${esc(p.tmux.target)}\nClick to open it">tmux ${esc(p.tmux.session)}</span>`;
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
          ? `<span class="path-link trunc" data-path="${esc(p.scriptPath)}" onclick="copyText(this.dataset.path, 'Path')" oncontextmenu="event.preventDefault();openTerminal(this.dataset.path)" title="${esc(p.scriptPath)}\nClick to copy \u00B7 Right-click to open terminal">\u200E${esc(displayPath(p.scriptPath))}\u200E</span>`
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
            ${p.tmux ? `<button onclick="attachTmux(this.dataset.session, this.dataset.target)" data-session="${esc(p.tmux.session)}" data-target="${esc(p.tmux.target)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="12" y1="12" x2="21" y2="12"/></svg>
              Open tmux pane
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
      if (p.tmux) return `tmux \u00B7 ${p.tmux.session}`;
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
      return `${p.pid}|${p.port}|${p.user}|${p.command}|${p.runtime}|${p.scriptPath}|${p.favorite}|${(p.cpu||0).toFixed(1)}|${p.memMB||0}|${p.startedAt && timeAgo(p.startedAt)}|${p.version}|${p.branch}|${p.orphan}|${p.appName}|${p.procName}|${p.idle}|${(p.dupOf || []).map(d => d.port)}|${p.health}|${p.tmux?.target}`;
    }

    let lastFingerprints = {};
    let lastFilteredKeys = '';

    function renderTable() {
      queueMicrotask(refreshExport);
      renderServerPatterns();
      const filtered = getFilteredAndSortedPorts();

      const filtering = searchInput.value || runtimeFilter.value !== 'all' || DevDockPatterns.on('servers');
      const killBtn = $('killFilteredBtn');
      killBtn.style.display = filtering && filtered.length ? '' : 'none';
      killBtn.textContent = `\u2715 Kill ${filtered.length} matching`;

      // Update counters (the counter is shared; other tabs write their own)
      if (DevDock.tab !== 'servers') {
        // leave it
      } else if (allPorts.length === 0) {
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
          if (data.type === 'source') handleSourceData(data);
          if (data.type?.startsWith('term-')) handleTermMessage(data);
          if (data.type === 'update') showUpdate(data);
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
      $('usageHistoryToggle').checked = currentSettings.usageHistory !== false;
      $('usageDays').value = String(currentSettings.usageDays ?? 1);
      usageInfo();
      $('tabLabels').value = currentSettings.tabLabels || 'both';
      $('idleAfterHours').value = String(currentSettings.idleAfterHours ?? 24);
      $('autoKillIdle').checked = !!currentSettings.autoKillIdle;
      $('autoUpdateToggle').checked = currentSettings.autoUpdate !== false;
      $('tmuxOpen').value = currentSettings.tmuxOpen || 'devdock';
      fillAgentSettings();
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

    // Only installed agents can be picked; the list comes from the agents source
    function fillAgentSettings() {
      const list = DevDock.sourceData.agents?.agents || [];
      const pick = list.find(a => a.installed && a.id === currentSettings.agent) || list.find(a => a.installed);
      $('agentsEnabled').checked = !!currentSettings.agentsEnabled;
      $('agentSelect').innerHTML = list.length
        ? list.map(a => `<option value="${a.id}" ${a.installed ? '' : 'disabled'} ${a === pick ? 'selected' : ''}>${esc(a.label)}${a.installed ? (a.version ? ' ' + esc(a.version) : '') : ' (not installed)'}</option>`).join('')
        : '<option value="">Looking\u2026</option>';
      $('agentAccess').value = currentSettings.agentReadOnly ? 'readonly' : 'full';
      $('agentHint').textContent = list.some(a => a.installed) ? 'Runs headless: claude -p, codex exec, opencode run' : 'Install Claude Code, Codex or OpenCode to use this';
      document.querySelectorAll('.agents-dep').forEach(r => r.classList.toggle('is-off', !$('agentsEnabled').checked));
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
        usageHistory: $('usageHistoryToggle').checked,
        usageDays: parseInt($('usageDays').value),
        tabLabels: $('tabLabels').value,
        idleAfterHours: parseInt($('idleAfterHours').value),
        autoKillIdle: $('autoKillIdle').checked,
        autoUpdate: $('autoUpdateToggle').checked,
        editor: $('editorSelect').value,
        tmuxOpen: $('tmuxOpen').value,
        agentsEnabled: $('agentsEnabled').checked,
        agent: $('agentSelect').value,
        agentReadOnly: $('agentAccess').value === 'readonly',
      };

      const ok = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.ok).catch(() => false);
      if (!ok) return showToast('Could not save settings', 'warn', 'settings');

      currentSettings = { ...currentSettings, ...body };
      updateExportVisibility(body.showExport);
      document.documentElement.dataset.tabs = body.tabLabels;
      document.querySelectorAll('.agents-dep').forEach(r => r.classList.toggle('is-off', !body.agentsEnabled));
      lastFilteredKeys = ''; // grouping depth may have changed
      const label = typeof what === 'string' ? what : describeChange(what?.target);
      showToast(label ? `Saved \u00B7 ${label}` : 'Settings saved', 'success', 'settings');
      loadPorts(true);
    }

    // ── Group by (Servers): sub-tabs like Containers', ⌥1–3 (js/keys.js) ──
    const GROUP_MODES = ['none', 'project', 'session'];
    function setGroupBy(mode, render = true) {
      groupBy = mode;
      $('groupTabs').querySelectorAll('[data-g]').forEach(b => b.setAttribute('aria-selected', b.dataset.g === mode));
      document.querySelector('.scroll').classList.toggle('grouped', mode !== 'none');
      saveView();
      lastFilteredKeys = '';
      if (render) renderTable();
    }
    $('groupTabs').addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (b) setGroupBy(b.dataset.g); });
    setGroupBy(GROUP_MODES.includes(groupBy) ? groupBy : 'none', false);

    // ── Tabs: Servers (this file), Sessions and Containers (js/views/) ──
    // A view registers window.DevDockViews[id] = { render() } and reads
    // DevDock.sourceData[id], filled from the server's "source" messages.
    const TABS = ['home', 'servers', 'sessions', 'containers', 'apps', 'coding', 'machines'];
    const SEARCH_HINTS = {
      servers: 'Search ports, PIDs, processes, paths\u2026',
      sessions: 'Search sessions, folders, branches, agents\u2026',
      containers: 'Search containers, images, volumes\u2026',
      apps: 'Search apps, bundle IDs, processes, PIDs\u2026',
      coding: 'Search agents, folders, branches, sessions\u2026',
      home: 'Search what needs attention\u2026',
      machines: 'Search machines, hosts, systems\u2026',
    };
    window.DevDockViews = {};
    window.DevDock = { sourceData: {}, tab: 'servers' };
    function setTab(next) {
      if (!TABS.includes(next)) return;
      DevDock.tab = next;
      document.body.dataset.tab = next;
      $('tabs').querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === next));
      document.querySelectorAll('[data-view]').forEach(el => { el.hidden = !el.dataset.view.split(' ').includes(next); });
      searchInput.placeholder = `${SEARCH_HINTS[next]}  \u2318F`;
      closeAllMenus();
      try { localStorage.setItem('devdock:tab', next); } catch {}
      resultInfo.textContent = '';
      if (next !== 'servers') renderActiveView(); else if (allPorts.length) { lastFilteredKeys = ''; renderTable(); }
      updateClearBtn();
      refreshExport();
    }
    // Home's "Show in …": open the tab, find the row, scroll to it and light it up for a moment.
    // Views re-render on every refresh, so the highlight is re-applied until it fades.
    // A key ending in ':' matches as a prefix (Servers rows are pid:port).
    window.revealRow = (tab, key, name, then) => {
      if (DevDock.tab !== tab) setTab(tab);
      then?.();
      const find = () => [...document.querySelectorAll('tr[data-key]')].find(r => r.offsetParent && (r.dataset.key === key || (key.endsWith(':') && r.dataset.key.startsWith(key))));
      let n = 0, searched = false, scrolled = false;
      const t = setInterval(() => {
        const row = find();
        if (!row && !searched && ++n > 6 && name) { searched = true; searchInput.value = name; searchInput.dispatchEvent(new Event('input')); }
        if (row) { row.classList.add('row-hit'); if (!scrolled) { scrolled = true; row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
        if (++n > 22) { clearInterval(t); document.querySelectorAll('tr.row-hit').forEach(r => r.classList.remove('row-hit')); }
      }, 150);
    };
    // Views redraw on every data refresh. A redraw between mouse-down and mouse-up swaps the
    // element under the pointer and the click is lost, so refreshes wait for the button to come up.
    let pressing = false, held = false;
    document.addEventListener('pointerdown', () => { pressing = true; }, true);
    const release = () => { pressing = false; if (held) { held = false; setTimeout(renderActiveView); } };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    function renderActiveView(fromData) {
      if (fromData && pressing) { held = true; return; }
      if (DevDock.tab !== 'servers') DevDockViews[DevDock.tab]?.render();
      refreshExport();
    }
    // Views report what the search left, same wording as Servers
    function setViewResult(shown, total) {
      resultInfo.textContent = searchInput.value && shown !== total ? `Showing ${shown} of ${total}` : '';
    }
    $('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
    // POST an action to a source; errors become a toast. Returns the result or null.
    async function sourceAction(source, action, params) {
      const res = await fetch(`/api/sources/${source}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}),
      }).catch(() => null);
      const body = res && await res.json().catch(() => ({}));
      if (res?.ok) return body;
      showToast(body?.error || 'Something went wrong', 'warn');
      return null;
    }
    // Selection (js/selection.js) asks each tab what a row is and what it can do to many
    DevDockViews.servers = {
      render: renderTable,
      pick(key) {
        const p = allPorts.find(x => rowKey(x) === key);
        return p && { kind: 'server', name: `:${p.port} ${p.procName || p.runtimeName}`, ref: String(p.pid), cwd: hasProject(p) ? p.scriptPath : '', raw: p, facts: {
          port: p.port, pid: p.pid, command: p.command, runtime: `${p.runtimeName}${p.version ? ' ' + p.version : ''}`, folder: p.scriptPath,
          'git branch': p.branch, cpu: `${(p.cpu || 0).toFixed(1)}%`, memory: formatMem(p.memMB || 0), started: p.startedAt ? timeAgo(p.startedAt) : '',
          health: healthMap[p.port], idle: p.idle ? 'yes, no CPU activity' : '', orphan: p.orphan ? 'yes, its parent process exited' : '',
          'started by': p.launcher?.name, 'tmux pane': p.tmux?.target, 'also running from this folder': p.dupOf?.map(d => ':' + d.port).join(' '),
        } };
      },
      bulk(items) {
        const pids = [...new Set(items.map(i => i.raw.pid))];
        return [{ label: `Kill ${pids.length}`, danger: true, run: () => killPids(pids, `Kill ${pids.length} process${pids.length > 1 ? 'es' : ''}?`) }];
      },
    };
    function handleSourceData(m) {
      DevDock.sourceData[m.id] = m.data;
      if (m.id === DevDock.tab) renderActiveView(true);
      document.dispatchEvent(new CustomEvent('devdock:source', { detail: m.id }));
    }

    // ── Event listeners ──────────────────────────────────────────────
    function updateClearBtn() {
      clearBtn.style.display = (searchInput.value || (DevDock.tab === 'servers' && runtimeFilter.value !== 'all')) ? '' : 'none';
    }
    updateClearBtn();

    searchInput.addEventListener('input', () => {
      if (DevDock.tab === 'servers') renderTable(); else renderActiveView();
      updateClearBtn();
    });
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
      if (DevDock.tab === 'servers') { runtimeFilter.value = 'all'; renderTable(); } else renderActiveView();
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
    // Version, build, and a check against the newest GitHub release
    fetch('/api/version').then(r => r.json()).then(v => { $('appVersion').textContent = v.version; $('appBuild').textContent = v.build; }).catch(() => {});
    // The app downloads and verifies updates itself; a browser tab only links to the release
    let update = null;
    function showUpdate(u) {
      update = u;
      const b = $('updateCheck'), st = $('updateStatus'), pill = $('updateBadge');
      const ready = u.state === 'ready';
      pill.style.display = ready ? '' : 'none';
      pill.textContent = `Restart to update to ${u.latest}`;
      $('autoUpdateRow').style.display = u.canInstall ? '' : 'none';
      b.disabled = u.state === 'checking' || u.state === 'downloading';
      b.textContent = { checking: 'Checking…', downloading: `Downloading${u.progress ? ` ${u.progress}%` : '…'}`, ready: 'Restart to update' }[u.state]
        || (u.available && u.canInstall ? `Install ${u.latest}` : 'Check for updates');
      st.innerHTML = u.state === 'error' ? ' · ' + esc(u.error)
        : !u.checkedAt && !u.available ? ''
        : ' · ' + (!u.available ? "You're on the latest version"
          : u.canInstall ? `<b>${esc(u.latest)}</b> ${ready ? 'is ready' : 'is out'}. <a href="${esc(u.url)}" target="_blank">What's new</a>`
          : `<b>${esc(u.latest)}</b> is out. <a href="${esc(u.url)}" target="_blank">Download it</a>`);
    }
    async function installUpdate() {
      $('updateBadge').disabled = $('updateCheck').disabled = true;
      $('updateBadge').textContent = $('updateCheck').textContent = update?.state === 'ready' ? 'Restarting…' : 'Downloading…';
      const r = await fetch('/api/update/install', { method: 'POST' }).then(r => r.json()).catch(() => ({ error: 'DevDock stopped answering' }));
      if (r.error) { showToast(r.error, 'warn'); $('updateBadge').disabled = false; fetch('/api/update').then(r => r.json()).then(showUpdate).catch(() => {}); }
    }
    $('updateBadge').addEventListener('click', installUpdate);
    $('updateCheck').addEventListener('click', async () => {
      if (update?.canInstall && (update.state === 'ready' || update.available)) return installUpdate();
      $('updateCheck').disabled = true; $('updateCheck').textContent = 'Checking…';
      const u = await fetch('/api/update').then(r => r.json()).catch(e => ({ error: e.message }));
      if (u.error && !u.state) { $('updateStatus').textContent = ' · ' + u.error; $('updateCheck').textContent = 'Try again'; $('updateCheck').disabled = false; }
      else showUpdate(u.state ? u : { ...update, state: 'error', error: u.error });
    });
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

    // what the usage history holds, in plain words (usage.rs)
    async function usageInfo() {
      const i = await sourceAction('home', 'usageInfo');
      if (!i) return;
      const size = i.bytes >= 1e6 ? `${(i.bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(i.bytes / 1e3)} KB`;
      const keep = +$('usageDays').value * 24, h = i.bytes ? Math.min(keep, (Date.now() - i.since) / 36e5) : 0;
      const dur = h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`;
      $('usageFill').style.width = `${h / keep * 100}%`;
      $('usageInfo').textContent = i.bytes ? `${dur} of ${keep} h · ${size}` : 'Nothing yet';
      $('usageReveal').title = tildify(i.path);
    }
    $('usageDays').addEventListener('change', usageInfo);
    $('usageReveal').addEventListener('click', () => sourceAction('home', 'usageReveal'));
    $('clearUsage').addEventListener('click', async () => {
      if (!await confirmDialog('Delete all recorded app usage?', 'This can\'t be undone. Recording carries on if it\'s on.', 'Delete')) return;
      if (await sourceAction('home', 'usageClear')) { showToast('App usage deleted'); usageInfo(); }
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
        case 'tab-servers': case 'tab-sessions': case 'tab-containers': case 'tab-apps': case 'tab-coding': case 'tab-home': case 'tab-machines': setTab(cmd.slice(4)); break;
        case 'group-menu': setTab('servers'); setGroupBy(GROUP_MODES[(GROUP_MODES.indexOf(groupBy) + 1) % GROUP_MODES.length]); break;
        case 'history': window.location.href = '/history'; break;
        case 'export': if ($('exportBtn').offsetParent) $('exportBtn').click(); else showToast('Turn on the export button in Settings', 'info'); break;
        case 'theme': $('themeToggle').click(); break;
        case 'help': $('helpModal').style.display = 'flex'; break;
        case 'update': openSettings().then(() => { showPane('general'); $('updateCheck').click(); }); break;
      }
    };
    if (location.hash === '#settings') { history.replaceState(null, '', '/'); openSettings(); }

    // ── Init ─────────────────────────────────────────────────────────
    // Starts once every script has run: views and selection.js load after this file, and a
    // fast fetch used to reach them first, throw, and leave the window without a connection
    document.addEventListener('DOMContentLoaded', async function init() {
      const [rtRes, stRes] = await Promise.all([fetch('/api/runtimes'), fetch('/api/settings')]);
      runtimeDefs = await rtRes.json();
      currentSettings = await stRes.json();
      fetch('/api/editors').then(r => r.json()).then(list => { editors = list; lastFilteredKeys = ''; }).catch(() => {});

      setTheme(currentSettings.theme || 'dark');
      groupingDepth = currentSettings.groupingDepth ?? 1;
      if (currentSettings.notifications) requestNotificationPermission();
      updateExportVisibility(currentSettings.showExport);
      document.documentElement.dataset.tabs = currentSettings.tabLabels || 'both';

      const params = new URLSearchParams(location.search);
      const q = params.get('q'); // ?q= deep-links a search, ?tab= a tab
      if (q) searchInput.value = q;
      let savedTab = null;
      try { savedTab = localStorage.getItem('devdock:tab'); } catch {}
      setTab(TABS.includes(params.get('tab')) ? params.get('tab') : TABS.includes(savedTab) ? savedTab : 'servers');
      loadPorts();
      connectWebSocket();
    });

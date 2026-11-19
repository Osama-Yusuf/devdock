// Mac-standard shortcuts. In the desktop app the native menu bar owns these
// (electron/main.js calls window.devdockCommand); this listener covers the browser.
(function () {
  const MAP = [
    { key: ',', cmd: 'settings' },
    { key: 'f', cmd: 'find' },
    { key: '1', cmd: 'tab-servers' },
    { key: '2', cmd: 'tab-sessions' },
    { key: '3', cmd: 'tab-containers' },
    { key: 'g', shift: true, cmd: 'group-menu' },
    { key: 'y', cmd: 'history' },
    { key: '[', cmd: 'back' },
    { key: 'e', shift: true, cmd: 'export' },
    { key: 'l', shift: true, cmd: 'theme' },
  ];
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    const hit = MAP.find(m => m.key === k && !!m.shift === e.shiftKey);
    if (!hit || typeof window.devdockCommand !== 'function') return;
    e.preventDefault();
    window.devdockCommand(hit.cmd);
  });
})();

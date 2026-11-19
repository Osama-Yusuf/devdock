// Keyboard layer shared by every tab, read off the page itself so views need no wiring:
//   ⌥1–9  the nth sub-tab of the visible view (.subtabs: grouping, multiplexer, kind, state)
//   ⌃1–9  the nth discovered pattern chip (.pattern)
//   hold ⌘, ⌥ or ⌃  badges show the key to press next, like big IDEs
// ⌘ targets carry data-kbd in the markup (the shortcuts themselves live in shortcuts.js).
(function () {
  const visible = el => el.offsetParent !== null;
  const subtabs = () => [...document.querySelectorAll('.subtabs [role="tab"]')].filter(visible).slice(0, 9);
  const patterns = () => [...document.querySelectorAll('.pattern')].filter(visible).slice(0, 9);
  const blocked = () => [...document.querySelectorAll('.modal-overlay')].some(m => m.style.display && m.style.display !== 'none');

  // e.code: ⌥1 types "¡" on a Mac keyboard
  document.addEventListener('keydown', e => {
    const n = +(e.code.match(/^Digit([1-9])$/)?.[1] || 0);
    if (!n || e.metaKey || e.shiftKey || blocked()) return;
    const list = e.altKey && !e.ctrlKey ? subtabs() : e.ctrlKey && !e.altKey ? patterns() : null;
    if (!list?.[n - 1]) return;
    e.preventDefault();
    list[n - 1].click();
    if (shown) requestAnimationFrame(() => show(shown)); // the view re-rendered: badge the new buttons
  });

  // Badges: up the moment a modifier goes down, gone when it comes up.
  // Only the key to press next: the held modifier is already down.
  const MOD = { Meta: 'meta', Alt: 'alt', Control: 'ctrl' };
  let shown = null;
  function show(mod) {
    clear();
    shown = mod;
    document.documentElement.classList.add('kbd-showing');
    const targets = mod === 'meta'
      ? [...document.querySelectorAll('[data-kbd]')].filter(visible).map(el => [el, el.dataset.kbd.replace('⌘', '')])
      : (mod === 'alt' ? subtabs() : patterns()).map((el, i) => [el, String(i + 1)]);
    for (const [el, k] of targets) {
      const b = document.createElement('kbd');
      b.className = 'kbd-badge';
      b.textContent = k;
      (el.tagName === 'INPUT' ? el.parentElement : el).appendChild(b);
    }
  }
  function clear() { document.querySelectorAll('.kbd-badge').forEach(b => b.remove()); }
  function hide() {
    shown = null;
    document.documentElement.classList.remove('kbd-showing');
    clear();
  }
  document.addEventListener('keydown', e => {
    const mod = MOD[e.key];
    if (mod && !e.repeat && shown !== mod && !blocked()) show(mod);
  });
  document.addEventListener('keyup', e => { if (MOD[e.key]) hide(); });
  window.addEventListener('blur', hide);
  document.addEventListener('mousedown', hide);
})();

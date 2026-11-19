// ── Tooltip (replaces slow native title tooltips everywhere) ─────
(function tooltips() {
  const style = document.createElement('style');
  style.textContent = `
.tip {
  position: fixed; z-index: 1000; pointer-events: none; max-width: 420px;
  padding: 6px 9px; border-radius: 7px; font-size: 0.74rem; line-height: 1.45;
  white-space: pre-line; word-break: break-word;
  background: #1f2733; color: #e6eaf0; border: 1px solid rgba(148,163,184,0.25);
  box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  opacity: 0; transform: translateY(2px); transition: opacity 0.08s, transform 0.08s;
}
.tip.show { opacity: 1; transform: none; }
html[data-theme="light"] .tip { background: #1e293b; color: #f1f5f9; }
`;
  document.head.appendChild(style);

  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  let target = null, timer = null;

  function place() {
    const r = target.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';
    const t = tip.getBoundingClientRect();
    let top = r.top - t.height - 8;
    if (top < 6) top = r.bottom + 8;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 6);
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }

  function hide() { clearTimeout(timer); tip.classList.remove('show'); target = null; }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[title], [data-tip]');
    if (el === target) return;
    hide();
    if (!el) return;
    if (el.hasAttribute('title')) { el.dataset.tip = el.title; el.removeAttribute('title'); }
    if (!el.dataset.tip) return;
    target = el;
    timer = setTimeout(() => { tip.textContent = el.dataset.tip; tip.classList.add('show'); place(); }, 120);
  });
  document.addEventListener('mousedown', hide);
  document.addEventListener('scroll', hide, true);
})();

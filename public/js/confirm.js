// ── Confirm dialog (shared by dashboard and history) ─────────────────
// The primary button is focused, so Enter = yes, Esc = no.
document.body.insertAdjacentHTML('beforeend', `
  <div class="modal-overlay confirm-overlay" id="confirmModal" style="display:none;">
    <div class="modal confirm-modal" role="alertdialog" aria-labelledby="confirmMsg">
      <div class="confirm-msg" id="confirmMsg"></div>
      <div class="confirm-detail" id="confirmDetail"></div>
      <input class="search-input confirm-input" id="confirmInput" spellcheck="false" autocomplete="off" style="display:none;">
      <div class="modal-footer">
        <button class="btn-cancel" id="confirmNo">Cancel <kbd>Esc</kbd></button>
        <button class="btn-danger" id="confirmYes">Kill <kbd>&#x21B5;</kbd></button>
      </div>
    </div>
  </div>`);

// With `value` it asks for text instead: resolves to the trimmed text, or null
function confirmDialog(message, detail = '', okLabel = 'Kill', value) {
  const asking = value != null;
  return new Promise(resolve => {
    const input = document.getElementById('confirmInput');
    input.style.display = asking ? '' : 'none';
    input.value = asking ? value : '';
    const modal = document.getElementById('confirmModal');
    const yes = document.getElementById('confirmYes'), no = document.getElementById('confirmNo');
    document.getElementById('confirmMsg').textContent = message;
    document.getElementById('confirmDetail').textContent = detail;
    yes.firstChild.textContent = okLabel + ' ';
    yes.className = asking ? 'btn-primary' : 'btn-danger';
    const done = (ok) => {
      modal.style.display = 'none';
      modal.removeEventListener('keydown', onKey);
      yes.onclick = no.onclick = modal.onclick = null;
      resolve(asking ? (ok && input.value.trim() ? input.value.trim() : null) : ok);
    };
    const onKey = (e) => {
      e.stopPropagation(); // keep page shortcuts out while open
      if (e.key === 'Escape') done(false);
      if (asking && e.key === 'Enter' && e.target === input) done(true);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    modal.addEventListener('keydown', onKey);
    modal.style.display = 'flex';
    if (asking) { input.focus(); input.select(); } else yes.focus();
  });
}

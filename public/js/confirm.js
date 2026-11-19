// ── Confirm dialog (shared by dashboard and history) ─────────────────
// The primary button is focused, so Enter = yes, Esc = no.
document.body.insertAdjacentHTML('beforeend', `
  <div class="modal-overlay confirm-overlay" id="confirmModal" style="display:none;">
    <div class="modal confirm-modal" role="alertdialog" aria-labelledby="confirmMsg">
      <div class="confirm-msg" id="confirmMsg"></div>
      <div class="confirm-detail" id="confirmDetail"></div>
      <div class="modal-footer">
        <button class="btn-cancel" id="confirmNo">Cancel <kbd>Esc</kbd></button>
        <button class="btn-danger" id="confirmYes">Kill <kbd>&#x21B5;</kbd></button>
      </div>
    </div>
  </div>`);

function confirmDialog(message, detail = '', okLabel = 'Kill') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const yes = document.getElementById('confirmYes'), no = document.getElementById('confirmNo');
    document.getElementById('confirmMsg').textContent = message;
    document.getElementById('confirmDetail').textContent = detail;
    yes.firstChild.textContent = okLabel + ' ';
    const done = (ok) => {
      modal.style.display = 'none';
      modal.removeEventListener('keydown', onKey);
      yes.onclick = no.onclick = modal.onclick = null;
      resolve(ok);
    };
    const onKey = (e) => {
      e.stopPropagation(); // keep page shortcuts out while open
      if (e.key === 'Escape') done(false);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    modal.addEventListener('keydown', onKey);
    modal.style.display = 'flex';
    yes.focus();
  });
}

// The completion report is a standalone printable page (no app.js), so it
// gets its own tiny script instead of an inline onclick (blocked by the
// script-src 'self' CSP header sent on every response).
document.querySelectorAll('[data-print]').forEach((el) => {
  el.addEventListener('click', () => window.print());
});

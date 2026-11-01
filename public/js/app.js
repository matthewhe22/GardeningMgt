// --- CSRF: inject the session token into every same-origin POST form ---
const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
document.querySelectorAll('form').forEach((form) => {
  if ((form.method || '').toLowerCase() !== 'post') return;
  if (form.querySelector('input[name="_csrf"]')) return;
  const i = document.createElement('input');
  i.type = 'hidden';
  i.name = '_csrf';
  i.value = CSRF;
  form.appendChild(i);
});

// --- Confirm before destructive actions: <form data-confirm="Sure?"> ---
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});

// --- Auto-submit: selects / file inputs with class "auto-submit" ---
// (Inline onchange handlers are blocked by the Content-Security-Policy.)
document.querySelectorAll('.auto-submit').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.type === 'file' && !el.files.length) return;
    if (el.form) el.form.submit();
  });
});

// --- "Select all" checkboxes: <input type=checkbox data-select-all=".selector"> ---
document.querySelectorAll('input[data-select-all]').forEach((all) => {
  const items = () => document.querySelectorAll(all.dataset.selectAll);
  all.addEventListener('change', () => items().forEach((i) => { i.checked = all.checked; }));
});

// --- Show how many photos were picked on "📷 Add photo" buttons ---
document.querySelectorAll('input[type=file].file-count').forEach((input) => {
  const label = input.closest('label');
  if (!label) return;
  const textNode = [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  const original = textNode ? textNode.textContent : '';
  input.addEventListener('change', () => {
    if (textNode) {
      textNode.textContent = input.files.length ? `📷 ${input.files.length} photo(s) ready` : original;
    }
    label.classList.toggle('has-files', input.files.length > 0);
  });
});

// --- Open the checklist item named in the URL hash (after saving one) ---
function openHashTarget() {
  const el = location.hash && document.getElementById(location.hash.slice(1));
  if (el && el.tagName === 'DETAILS') el.open = true;
}
openHashTarget();
window.addEventListener('hashchange', openHashTarget);

// --- Prevent double-submit: disable submit buttons once a form is submitted ---
document.querySelectorAll('form').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return; // e.g. a cancelled confirm()
    const btn = form.querySelector('button[type="submit"], button:not([type])');
    if (btn) {
      // Let the value still post, just block repeat taps.
      setTimeout(() => { btn.disabled = true; btn.dataset.busy = '1'; }, 0);
    }
  });
});

// --- GPS capture on start/finish timer forms (mobile field use) ---
document.querySelectorAll('form.gps-form').forEach((form) => {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = form.querySelector('input[name="lat"]');
      const lng = form.querySelector('input[name="lng"]');
      if (lat) lat.value = pos.coords.latitude;
      if (lng) lng.value = pos.coords.longitude;
    },
    () => {}, // user denied or unavailable — submit without coordinates
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

// Expose the token for any fetch()-based callers (e.g. GPS pings).
window.CSRF_TOKEN = CSRF;

// Register the service worker for offline app-shell support (PWA).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Lightweight offline indicator so field users know saves won't go through.
function showNet() {
  let bar = document.getElementById('net-offline');
  if (!navigator.onLine) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'net-offline';
      bar.textContent = '⚠ Offline — changes won’t save until you reconnect';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:60;background:#855600;color:#fff;text-align:center;padding:8px;font-size:0.85rem';
      document.body.appendChild(bar);
    }
  } else if (bar) {
    bar.remove();
  }
}
window.addEventListener('online', showNet);
window.addEventListener('offline', showNet);
showNet();

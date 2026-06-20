// --- CSRF: inject the session token into every same-origin POST form ---
const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
document.querySelectorAll('form').forEach((form) => {
  if ((form.method || '').toLowerCase() !== 'post') return;
  if (!form.querySelector('input[name="_csrf"]')) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = '_csrf';
    i.value = CSRF;
    form.appendChild(i);
  }
  // Multipart uploads: the hidden field lands in the (unparsed) body, so also
  // carry the token in the query string where it can be checked before multer
  // buffers the files.
  if ((form.enctype || '').includes('multipart')) {
    try {
      const u = new URL(form.getAttribute('action') || location.href, location.origin);
      u.searchParams.set('_csrf', CSRF);
      form.setAttribute('action', u.pathname + u.search);
    } catch (_) { /* leave action as-is */ }
  }
});

// --- Confirm destructive actions (forms/links marked data-confirm) ---
// Registered before the double-submit guard so a cancelled confirm also
// prevents the button from being disabled.
document.querySelectorAll('[data-confirm]').forEach((el) => {
  const msg = el.getAttribute('data-confirm') || 'Are you sure?';
  const evt = el.tagName === 'FORM' ? 'submit' : 'click';
  el.addEventListener(evt, (e) => { if (!window.confirm(msg)) e.preventDefault(); });
});

// --- Prevent double-submit: disable submit buttons once a form is submitted ---
document.querySelectorAll('form').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return; // e.g. a confirm() was cancelled
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

// --- Photo capture preview: show thumbnails of what was taken/selected ---
// Field gardeners tap "Take photo" / "Choose from library"; this shows the
// chosen photos right away so they can confirm before uploading. The upload
// still works without JS — these are progressive enhancements only.
document.querySelectorAll('form[data-upload]').forEach((form) => {
  const inputs = form.querySelectorAll('input[type="file"]');
  const status = form.querySelector('[data-upload-status]');
  const previews = form.querySelector('[data-upload-previews]');
  let urls = []; // object URLs to revoke between selections

  const render = () => {
    const files = [];
    inputs.forEach((inp) => { for (const f of inp.files || []) files.push(f); });

    if (status) {
      status.hidden = files.length === 0;
      status.textContent = files.length
        ? (files.length === 1 ? '✓ 1 photo ready to upload' : `✓ ${files.length} photos ready to upload`)
        : '';
    }

    if (previews) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
      previews.innerHTML = '';
      previews.hidden = files.length === 0;
      files.forEach((f) => {
        const fig = document.createElement('figure');
        fig.className = 'preview-thumb';
        if (f.type && f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          urls.push(url);
          const img = document.createElement('img');
          img.src = url;
          img.alt = f.name;
          img.loading = 'lazy';
          fig.appendChild(img);
        } else {
          // e.g. iPhone HEIC that the browser can't render — show a placeholder.
          const span = document.createElement('span');
          span.className = 'preview-file';
          span.textContent = '🖼';
          fig.appendChild(span);
        }
        const cap = document.createElement('figcaption');
        cap.textContent = f.name;
        fig.appendChild(cap);
        previews.appendChild(fig);
      });
    }
  };

  inputs.forEach((inp) => inp.addEventListener('change', render));
  render();
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
      // Sit above the bottom tab bar (and the iOS home indicator) so it never
      // hides navigation while a field user is offline.
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:calc(62px + env(safe-area-inset-bottom,0px));z-index:39;background:#855600;color:#fff;text-align:center;padding:8px;font-size:0.85rem';
      document.body.appendChild(bar);
    }
  } else if (bar) {
    bar.remove();
  }
}
window.addEventListener('online', showNet);
window.addEventListener('offline', showNet);
showNet();

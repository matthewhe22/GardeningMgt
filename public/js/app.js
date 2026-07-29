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

// --- Prevent double-submit: disable submit buttons once a form is submitted ---
document.querySelectorAll('form').forEach((form) => {
  form.addEventListener('submit', () => {
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

// --- Mobile: invite the user to add the app to their home screen ---
// Only for phones/tablets that aren't already running the installed app.
// Chrome/Edge on Android can install directly via beforeinstallprompt; iOS
// Safari has no such API, so we show the Share → "Add to Home Screen" steps.
(function addToHomeScreen() {
  const SNOOZE_KEY = 'gmgt.a2hs.snoozed';
  const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // ask again at most fortnightly

  // localStorage throws in some private-browsing modes — never break the page.
  const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const writeStore = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (standalone) return;                                   // already installed
  if (!document.body.classList.contains('authed')) return;  // don't interrupt sign-in

  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a desktop Safari UA, so fall back to touch points.
  const isIOS = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isMobile = isIOS
    || navigator.userAgentData?.mobile === true
    || /Android|Mobi|Silk|Kindle|Tablet|Windows Phone/i.test(ua);
  if (!isMobile) return;

  if (Date.now() - (Number(readStore(SNOOZE_KEY)) || 0) < SNOOZE_MS) return;

  let deferred = null;  // the saved beforeinstallprompt event, when offered
  let banner = null;
  let installBtn = null;
  let stepsEl = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();   // suppress Chrome's mini-infobar; we ask in-app instead
    deferred = e;
    // The event can land after the banner is up: swap the manual steps for the
    // one-tap install button so the copy always matches what's on offer.
    if (banner) {
      installBtn.hidden = false;
      stepsEl.textContent = steps();
    }
    show();
  });
  window.addEventListener('appinstalled', () => { snooze(); close(); });

  if (isIOS) show();
  // Browsers that never fire beforeinstallprompt (Firefox, Samsung, Safari on
  // iPadOS): give the event a moment to arrive, then show manual steps.
  else setTimeout(() => { if (!deferred) show(); }, 1500);

  function steps() {
    if (isIOS) {
      return 'Tap the Share button in the browser toolbar, then choose "Add to Home Screen".';
    }
    if (deferred) {
      return 'Install it for one-tap access and a full-screen view — no app store needed.';
    }
    return 'Open your browser menu (⋮), then choose "Add to Home screen" or "Install app".';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function show() {
    if (banner) return;
    banner = el('div', 'a2hs');
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Add GardeningMgt to your home screen');

    stepsEl = el('p', 'a2hs-steps', steps());
    const body = el('div', 'a2hs-body');
    body.append(el('strong', 'a2hs-title', 'Add GardeningMgt to your home screen'), stepsEl);

    installBtn = button('btn btn-primary', 'Add to home screen', install);
    installBtn.hidden = !deferred;
    const actions = el('div', 'a2hs-actions');
    actions.append(installBtn, button('link-btn', 'Not now', () => { snooze(); close(); }));
    body.appendChild(actions);

    const dismiss = button('a2hs-close', '×', () => { snooze(); close(); });
    dismiss.setAttribute('aria-label', 'Dismiss');

    banner.append(el('div', 'a2hs-icon', '🌱'), body, dismiss);
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('is-open'));
  }

  async function install() {
    if (!deferred) return;
    const evt = deferred;
    deferred = null;
    installBtn.hidden = true;
    evt.prompt();
    // Either way we stop asking: accepted installs it, dismissed means not now.
    try { await evt.userChoice; } catch { /* ignore */ }
    snooze();
    close();
  }

  function snooze() { writeStore(SNOOZE_KEY, String(Date.now())); }
  function close() { if (banner) banner.remove(); banner = null; }
})();

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

// --- Auto-submit a form when a field marked data-autosubmit changes ---
// (an inline onchange="this.form.submit()" attribute is blocked by the
// script-src 'self' CSP header sent on every response)
// Uses requestSubmit() rather than submit(): the latter does NOT dispatch a
// 'submit' event (a long-standing DOM quirk), which would let these forms
// (e.g. the task-status <select>) silently skip the offline-safe submit
// handling installed further down this file.
document.querySelectorAll('[data-autosubmit]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!el.form) return;
    if (el.form.requestSubmit) el.form.requestSubmit();
    else el.form.submit();
  });
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

// --- Never lose a gardener's typed work to a dropped connection ---------
// The problem this fixes: submitting a comment / photo caption / job form
// with no signal used to hand the browser its own "can't reach this page"
// error, with whatever the gardener typed gone for good — nothing was ever
// retried when signal returned. Two independent pieces:
//   1. Every POST form is submitted via fetch() instead of a native
//      navigation, so a real network failure can be caught and shown as an
//      inline message on the same page (with the typed content still right
//      there in the fields) instead of a browser error page.
//   2. Just before that request goes out, any typed text/number/date field is
//      stashed in localStorage (a simple per-form draft, not a queue) and
//      only cleared once the request actually reaches the server. If the
//      page gets reloaded before reconnecting, a banner on that same form
//      offers to restore it.
// This deliberately stops short of a background-sync queue: the goal is
// "the gardener never sees a blank error page with their work silently
// gone", not automatic retry while the tab is closed.
const DRAFT_PREFIX = 'gmgt:draft:';
const DRAFT_FIELD_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'time']);

function draftKeyFor(form) {
  try { return DRAFT_PREFIX + new URL(form.action, location.href).pathname; }
  catch (_) { return DRAFT_PREFIX + (form.getAttribute('action') || location.pathname); }
}

function draftableFields(form) {
  const fields = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const capturable = el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && DRAFT_FIELD_TYPES.has((el.type || '').toLowerCase()));
    if (!capturable) continue;
    if (el.value && el.value.trim()) fields[el.name] = el.value;
  }
  return fields;
}

function saveDraft(form) {
  const fields = draftableFields(form);
  const key = draftKeyFor(form);
  if (Object.keys(fields).length) {
    try { localStorage.setItem(key, JSON.stringify({ fields, ts: Date.now() })); } catch (_) { /* storage full/disabled */ }
  } else {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }
}

function clearDraft(form) {
  try { localStorage.removeItem(draftKeyFor(form)); } catch (_) { /* ignore */ }
}

function netMsgEl(form) {
  let el = form.querySelector('.form-net-msg');
  if (!el) {
    el = document.createElement('p');
    el.className = 'form-net-msg alert alert-error';
    el.hidden = true;
    form.appendChild(el);
  }
  return el;
}

function showNetError(form) {
  const el = netMsgEl(form);
  el.hidden = false;
  el.textContent = "⚠ Couldn't save — your text is kept. Try again when you have signal.";
}

function hideNetError(form) {
  const el = form.querySelector('.form-net-msg');
  if (el) el.hidden = true;
}

function reEnableSubmit(form) {
  delete form.dataset.gmgtSubmitting;
  const btn = form.querySelector('button[type="submit"], button:not([type])');
  if (btn) { btn.disabled = false; delete btn.dataset.busy; }
}

// On load: offer to restore any draft that matches a POST form on this page.
document.querySelectorAll('form').forEach((form) => {
  if ((form.method || '').toLowerCase() !== 'post') return;
  const key = draftKeyFor(form);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { saved = null; }
  if (!saved || !saved.fields || !Object.keys(saved.fields).length) return;

  const label = form.dataset.draftLabel || 'entry';
  const banner = document.createElement('div');
  banner.className = 'alert alert-error draft-banner';
  banner.innerHTML = `You have an unsaved <strong>${label}</strong> from earlier. ` +
    '<button type="button" class="link-btn draft-restore">Restore</button> · ' +
    '<button type="button" class="link-btn draft-discard">Discard</button>';
  form.parentNode.insertBefore(banner, form);

  banner.querySelector('.draft-restore').addEventListener('click', () => {
    for (const [name, value] of Object.entries(saved.fields)) {
      const el = form.elements.namedItem(name);
      if (el && 'value' in el) el.value = value;
    }
    banner.remove();
  });
  banner.querySelector('.draft-discard').addEventListener('click', () => {
    clearDraft(form);
    banner.remove();
  });
});

// --- Fresh GPS position at the moment of submit (mobile field use) ---------
// Previously this only resolved navigator.geolocation.getCurrentPosition once
// when a .gps-form's page first loaded — a gardener who opens the visit page
// while still driving would record whatever (stale, or nothing if the fix
// arrived late) position happened to be current at load time, not when they
// actually tap Start/Complete. Re-requesting right before the real submit
// fixes that, capped to a short timeout so a slow or denied prompt never
// blocks the submission itself — it just goes out without coordinates.
// Returns a promise the fetch-based submit flow below awaits before building
// the request body.
const GPS_SUBMIT_TIMEOUT_MS = 3500;
function refreshGpsForSubmit(form) {
  if (!form.classList.contains('gps-form') || !('geolocation' in navigator)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, GPS_SUBMIT_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const lat = form.querySelector('input[name="lat"]');
        const lng = form.querySelector('input[name="lng"]');
        if (lat) lat.value = pos.coords.latitude;
        if (lng) lng.value = pos.coords.longitude;
        finish();
      },
      () => { clearTimeout(timer); finish(); }, // denied/unavailable — submit without coordinates
      { enableHighAccuracy: true, timeout: GPS_SUBMIT_TIMEOUT_MS, maximumAge: 0 }
    );
  });
}

// Intercept every POST form submit: save a draft, send it via fetch, and
// react to the outcome ourselves instead of letting the browser navigate.
document.querySelectorAll('form').forEach((form) => {
  if ((form.method || '').toLowerCase() !== 'post') return;
  form.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return; // e.g. a data-confirm was cancelled
    // Because this now waits on a network round-trip (and, for .gps-form,
    // a fresh geolocation read first) instead of navigating away
    // immediately, the page stays interactive for that whole window —
    // long enough for two almost-simultaneous taps to both reach here before
    // the existing disable-the-button guard (a setTimeout(0), below) takes
    // effect. Close that gap with a synchronous re-entrancy flag...
    if (form.dataset.gmgtSubmitting === '1') return;
    form.dataset.gmgtSubmitting = '1';
    e.preventDefault();
    hideNetError(form);

    // ...and, belt-and-braces, disable the submit button immediately rather
    // than on the next tick (unlike the older double-submit guard below, a
    // disabled button never dispatches another 'click'/'submit' at all, so
    // this is what actually closes the race — the flag above is the fallback
    // for forms with no visible submit button, e.g. the autosubmit selects).
    const submitBtn = form.querySelector('button[type="submit"], button:not([type])');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.busy = '1'; }

    refreshGpsForSubmit(form).then(() => {
      // Save the draft only once the (possibly lat/lng-updated) fields are
      // final — hidden lat/lng inputs aren't draftable fields themselves
      // (see DRAFT_FIELD_TYPES) so this ordering doesn't change what's saved.
      saveDraft(form);

      // Multipart forms (photo uploads) must stay multipart; everything else
      // must stay application/x-www-form-urlencoded — a plain FormData body
      // is ALWAYS sent as multipart by fetch regardless of the form's own
      // enctype, which would silently break every non-file POST route (their
      // body-parser only understands urlencoded bodies). URLSearchParams
      // bodies are sent as urlencoded automatically.
      const isMultipart = (form.enctype || '').toLowerCase().includes('multipart');
      const body = isMultipart ? new FormData(form) : new URLSearchParams(new FormData(form));

      fetch(form.action, { method: 'POST', body, credentials: 'same-origin' })
        .then((res) => {
          clearDraft(form);
          if (res.redirected) {
            // Normal redirect-after-POST: follow it like a native submit would.
            // fetch() strips the URL fragment from a followed redirect (unlike a
            // real browser navigation), so a server redirect to e.g.
            // "/visits/5#comments" arrives here as plain "/visits/5" — recover
            // the anchor from the section the form itself lives in (this app's
            // views consistently wrap each such form in <section id="...">) so
            // the page still jumps back to the right card instead of the top.
            const section = form.closest('[id]');
            const hash = section ? '#' + section.id : '';
            const target = new URL(res.url, location.href);
            const samePage = target.origin + target.pathname + target.search ===
              location.origin + location.pathname + location.search;
            if (samePage) {
              // Changing only the fragment on the SAME path is a same-document
              // navigation in every browser — it would not reload, so the
              // comment/photo/task that was just saved would never appear.
              // Set the anchor first (harmless, no reload by itself) then force
              // a real reload to pick up the new server-rendered state.
              if (hash) window.location.hash = hash.slice(1);
              window.location.reload();
            } else {
              window.location.href = target.href + hash;
            }
            return;
          }
          // The handler rendered directly (success or an in-page error like an
          // invalid login or a 404) without redirecting — show exactly what it
          // returned, the same way a native form submission would, instead of
          // guessing a URL to navigate to.
          return res.text().then((html) => {
            document.open();
            document.write(html);
            document.close();
          });
        })
        .catch(() => {
          // A real connectivity failure: nothing reached the server. Keep the
          // draft, re-enable the button so the user can retry, and say so
          // in-page rather than showing the browser's own error page.
          reEnableSubmit(form);
          showNetError(form);
        });
    });
  });
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

// --- Periodic GPS ping while a job is running (mobile field use) -----------
// The server already exposes POST /visits/:id/gps for exactly this ("GPS ping
// while working, called periodically by the mobile UI" — src/routes/visits.js)
// but nothing ever called it: only the start/finish timer captured a position.
// While this page shows a running job's timer card (visits/show.ejs stamps it
// with data-gps-ping-visit), ping every few minutes so a long visit leaves a
// trail rather than just two points. Kept simple: no background sync, this
// only runs while the tab stays open on this page.
(function () {
  const GPS_PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const pingEl = document.querySelector('[data-gps-ping-visit]');
  if (!pingEl || !('geolocation' in navigator)) return;
  const visitId = pingEl.getAttribute('data-gps-ping-visit');
  setInterval(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const body = new URLSearchParams({
          lat: String(pos.coords.latitude),
          lng: String(pos.coords.longitude),
          _csrf: window.CSRF_TOKEN,
        });
        fetch(`/visits/${visitId}/gps`, { method: 'POST', body, credentials: 'same-origin' }).catch(() => {});
      },
      () => {}, // no fix this cycle (denied/unavailable/timed out) — just try again next interval
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }, GPS_PING_INTERVAL_MS);
})();

// Lightweight offline indicator so field users know saves won't go through.
function showNet() {
  let bar = document.getElementById('net-offline');
  if (!navigator.onLine) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'net-offline';
      bar.textContent = '⚠ Offline — changes won’t save until you reconnect';
      document.body.appendChild(bar);
    }
    // Sit above the bottom tab bar (and the iOS home indicator) by default —
    // but if a page also has the fixed sticky primary action button (the
    // Start/Complete job CTA on visits/show.ejs), that shares the exact same
    // "above the tab bar" offset, and this bar's higher z-index would sit on
    // top of it, covering the primary action while offline. Measure the CTA
    // (if present) and sit above IT instead, recomputed on every toggle since
    // the CTA's own height can change (e.g. the long-running-job warning).
    const cta = document.querySelector('.mobile-sticky-cta');
    const baseOffset = 'calc(62px + env(safe-area-inset-bottom, 0px))';
    const bottom = cta
      ? `calc(${Math.ceil(cta.getBoundingClientRect().height)}px + ${baseOffset})`
      : baseOffset;
    bar.style.cssText = `position:fixed;left:0;right:0;bottom:${bottom};z-index:39;background:#855600;color:#fff;text-align:center;padding:8px;font-size:0.85rem`;
  } else if (bar) {
    bar.remove();
  }
}
window.addEventListener('online', showNet);
window.addEventListener('offline', showNet);
// The sticky CTA's height can change after load (e.g. a photo-count note
// wrapping to a second line) — recheck shortly after load too, not just on
// network-state changes, so the offline bar (if already showing, e.g. after a
// reload while offline) tracks it.
showNet();
window.addEventListener('resize', () => { if (!navigator.onLine) showNet(); });

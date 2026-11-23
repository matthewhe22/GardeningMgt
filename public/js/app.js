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

// --- Bulk reassign/reschedule on the Jobs list (views/visits/index.ejs) ---
// The per-row checkboxes and the "select all visible" checkbox aren't inside
// the bulk <form> itself (they live inside each day-group's row markup, and
// are associated to the form via the HTML `form="bulk-form"` attribute), so
// wire them up here rather than relying on any form-level change event.
(() => {
  const checks = document.querySelectorAll('[data-bulk-check]');
  if (!checks.length) return;
  const selectAll = document.querySelector('[data-bulk-select-all]');
  const actions = document.querySelector('[data-bulk-actions]');
  const countEl = document.querySelector('[data-bulk-count]');
  const refresh = () => {
    const n = document.querySelectorAll('[data-bulk-check]:checked').length;
    if (countEl) countEl.textContent = String(n);
    if (actions) actions.hidden = n === 0;
    if (selectAll) selectAll.checked = n > 0 && n === checks.length;
  };
  checks.forEach((c) => c.addEventListener('change', refresh));
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      checks.forEach((c) => { c.checked = selectAll.checked; });
      refresh();
    });
  }
  refresh();
})();

// --- Auto-submit: selects / file inputs with class "auto-submit" ---
// (Inline onchange handlers are blocked by the Content-Security-Policy.)
document.querySelectorAll('.auto-submit').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.type === 'file' && !el.files.length) return;
    if (el.form) (el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit());
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

// --- Scope checklist: jump to the item named by ?item= (after a Save) ---
(() => {
  const params = new URLSearchParams(location.search);
  const item = params.get('item');
  if (item) {
    const el = item === 'complete' ? document.querySelector('.timer-card form[action$="/timer/stop"]') || document.getElementById('scope')
      : document.getElementById('check-' + item);
    if (el) {
      if (el.tagName === 'DETAILS') el.open = true;
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    }
    // Drop ?item= so a reload or Back doesn't jump again.
    params.delete('item');
    const qs = params.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (_) { /* ignore */ }
  } else if (location.hash) {
    const el = document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
})();

// --- Task photo buttons upload as soon as the photo is taken ---
document.querySelectorAll('form[data-photo-autoupload] input[type=file]').forEach((input) => {
  input.addEventListener('change', (e) => {
    // Only a real camera pick — not the refresh fired after a failed upload,
    // which would otherwise retry in a loop.
    if (!e.isTrusted || !input.files || !input.files.length || !input.form) return;
    if (input.form.requestSubmit) input.form.requestSubmit(); else input.form.submit();
  });
});

// --- Ticking "Done" saves the item straight away (unless photos are waiting) ---
document.querySelectorAll('input[data-tick-save]').forEach((box) => {
  box.addEventListener('change', () => {
    const form = box.form;
    if (!form) return;
    const pending = [...form.querySelectorAll('input[type=file]')].some((i) => i.files && i.files.length);
    if (pending) return; // the gardener will tap Save to upload the photos too
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  });
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

const WARN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><path d="M12 16.8h.01"/></svg>';
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 5 5L19 7"/></svg>';

function showNetError(form) {
  const el = netMsgEl(form);
  el.hidden = false;
  // Fixed, static markup only — never interpolates user input, so innerHTML here carries no XSS risk.
  el.innerHTML = WARN_ICON_SVG + " Couldn't save — your text is kept. Try again when you have signal.";
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

// --- Shrink phone photos before upload ------------------------------------
// Camera originals are often 3–8 MB; Vercel rejects request bodies over
// ~4.5 MB and they're slow on 4G. Re-encode large JPEG/PNG/WebP images to a
// 1600px JPEG (quality 0.8) in the browser. Anything the browser can't decode
// (e.g. HEIC outside Safari) is sent unchanged.
const PHOTO_MAX_EDGE = 1600;
const PHOTO_SHRINK_OVER = 900 * 1024;
function shrinkOne(file) {
  if (!file || !file.type || !/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || file.size <= PHOTO_SHRINK_OVER) {
    return Promise.resolve(file);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob || blob.size >= file.size) return resolve(file);
        const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
        resolve(new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified }));
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
function shrinkPhotos(fd) {
  const entries = [...fd.entries()];
  return Promise.all(entries.map(([k, v]) => (v instanceof File && v.size ? shrinkOne(v) : Promise.resolve(v))
    .then((nv) => [k, nv]))).then((done) => {
    const out = new FormData();
    for (const [k, v] of done) {
      if (v instanceof File) { if (v.size) out.append(k, v, v.name); } else out.append(k, v);
    }
    return out;
  }).catch(() => fd);
}

// --- Live job photos: validate, compress at high resolution, upload one by one ---
// Forms marked data-photo-endpoint (job evidence photos) don't post their
// photos in the form body. Each photo is instead:
//   1. dated from its own EXIF capture time (read BEFORE compressing, since a
//      canvas re-encode drops EXIF) and rejected on the spot if it's too old;
//   2. re-encoded to a high-resolution JPEG (long edge 2560px, q≈0.85) with the
//      original EXIF block put back (orientation reset) so the server can
//      verify the capture time itself;
//   3. uploaded on its own request with progress — the next photo is being
//      compressed while the current one uploads.
// One photo per request keeps every body well under the host's ~4.5 MB cap no
// matter how many photos are taken, and a failure costs one photo, not all.
const LIVE_MAX_EDGE = 2560;
const LIVE_QUALITY = 0.85;
const LIVE_KEEP_ORIGINAL_UNDER = 1.5 * 1024 * 1024; // small camera JPEGs go as-is
const LIVE_MAX_BYTES = 3.8 * 1024 * 1024;           // per-request safety margin under 4.5 MB

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

function encodeJpeg(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => {
    canvas.width = 0; canvas.height = 0; // release the bitmap memory promptly (iOS)
    resolve(b);
  }, 'image/jpeg', quality));
}

// Returns { file, takenAt } or throws an Error whose message is shown to the gardener.
async function prepareLivePhoto(file, maxAgeHours, maxBytes = LIVE_MAX_BYTES) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const Exif = window.GmgtExif;
  const info = Exif ? Exif.readCapture(bytes) : null;
  const takenAt = (info && Exif.captureTime(info, new Date().getTimezoneOffset())) || file.lastModified || null;
  const now = Date.now();
  if (takenAt && maxAgeHours && takenAt < now - maxAgeHours * 3600 * 1000) {
    throw new Error(`"${file.name}" was taken ${new Date(takenAt).toLocaleString()}. ` +
      `Job photos must be taken with the camera during the job.`);
  }
  const isJpeg = /^image\/jpe?g$/.test(file.type);
  let img = null;
  try { img = await decodeImage(file); } catch (_) { img = null; }
  const small = isJpeg && file.size <= LIVE_KEEP_ORIGINAL_UNDER &&
    (!img || Math.max(img.naturalWidth, img.naturalHeight) <= LIVE_MAX_EDGE);
  if (small || !img) {
    // Already small, or a format this browser can't draw (e.g. HEIC on Android):
    // send unchanged if it fits in one request.
    if (file.size > maxBytes) {
      throw new Error(`"${file.name}" is too large to upload. Set the camera to JPG ("Most Compatible") and retake it.`);
    }
    return { file, takenAt };
  }
  const app1 = Exif && isJpeg ? Exif.extractApp1(bytes) : null;
  let blob = null;
  for (const [edge, q] of [[LIVE_MAX_EDGE, LIVE_QUALITY], [LIVE_MAX_EDGE, 0.75], [2048, 0.75]]) {
    blob = await encodeJpeg(img, edge, q);
    if (blob && blob.size + (app1 ? app1.length : 0) <= LIVE_MAX_BYTES) break;
  }
  if (!blob) throw new Error(`"${file.name}" could not be processed. Retake it and try again.`);
  let out = blob;
  if (app1) {
    const merged = Exif.injectApp1(new Uint8Array(await blob.arrayBuffer()), app1);
    out = new Blob([merged], { type: 'image/jpeg' });
  }
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return { file: new File([out], name, { type: 'image/jpeg', lastModified: file.lastModified }), takenAt };
}

function uploadViaApp(endpoint, prepared, extra, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('_csrf', CSRF);
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') fd.append(k, v);
    if (prepared.takenAt) fd.append('taken_at', String(prepared.takenAt));
    fd.append('tz', String(new Date().getTimezoneOffset()));
    fd.append('photo', prepared.file, prepared.file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${endpoint}?_csrf=${encodeURIComponent(CSRF)}`);
    xhr.setRequestHeader('X-CSRF-Token', CSRF);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (_) { body = null; }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) return resolve(body);
      reject(new Error((body && body.error) || (xhr.status === 413
        ? 'That photo is too large to upload.' : 'Upload failed. Please try again.')));
    };
    xhr.onerror = () => reject(new Error('No connection — photos not uploaded. Try again when you have signal.'));
    xhr.ontimeout = xhr.onerror;
    xhr.timeout = 120000;
    xhr.send(fd);
  });
}

const OFFLINE_MSG = 'No connection — photos not uploaded. Try again when you have signal.';

// JSON POST to the app; resolves the parsed body or throws with its message.
async function postJson(url, data) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(data),
    });
  } catch (_) { throw new Error(OFFLINE_MSG); }
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok || !body || !body.ok) throw new Error((body && body.error) || 'Upload failed. Please try again.');
  return body;
}

// PUT the photo straight to the storage bucket with its presigned URL.
function putToBucket(url, headers, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve()
      : reject(Object.assign(new Error('Upload failed. Please try again.'), { status: xhr.status })));
    // status 0: offline, or the bucket refused the browser (CORS not set up).
    xhr.onerror = () => reject(Object.assign(new Error(OFFLINE_MSG), { status: 0 }));
    xhr.ontimeout = xhr.onerror;
    xhr.timeout = 120000;
    xhr.send(blob);
  });
}

function photoMime(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || '';
}

// Direct-to-bucket upload (presign -> PUT -> complete), falling back to the
// one-photo-per-request app endpoint when the server has no bucket for it or
// this browser can't reach the bucket. Remembered for the rest of the page.
let directUploads = null; // null = not tried yet, false = use the app path
async function uploadLivePhoto(endpoint, prepared, extra, onProgress) {
  if (directUploads !== false) {
    const meta = {
      ...extra, content_type: photoMime(prepared.file), size: prepared.file.size,
      taken_at: prepared.takenAt || '', tz: new Date().getTimezoneOffset(), name: prepared.file.name,
    };
    const pre = await postJson(`${endpoint}/presign`, meta);
    if (pre.direct) {
      try {
        await putToBucket(pre.url, pre.headers, prepared.file, onProgress);
      } catch (err) {
        if (err.status !== 0 || navigator.onLine === false) throw err;
        // Online but the bucket is unreachable from here (usually its CORS
        // rules don't allow this site yet) — send through the app instead.
        console.warn('Direct photo upload unavailable, using the app upload instead.');
        directUploads = false;
        return uploadViaApp(endpoint, prepared, extra, onProgress);
      }
      directUploads = true;
      onProgress(1);
      return postJson(`${endpoint}/complete`, { ...meta, ticket: pre.ticket });
    }
    directUploads = false;
  }
  return uploadViaApp(endpoint, prepared, extra, onProgress);
}

// Upload every selected photo of a data-photo-endpoint form. Resolves true when
// all went up; on failure shows why, keeps the photos not yet uploaded
// selected, and resolves false.
async function uploadLivePhotos(form) {
  const inputs = [...form.querySelectorAll('input[type=file]')];
  const files = [];
  inputs.forEach((inp) => { for (const f of inp.files || []) if (f.size) files.push(f); });
  if (!files.length) return true;
  const status = form.querySelector('[data-upload-status]');
  const say = (msg, isError) => {
    if (!status) return;
    status.hidden = false;
    status.classList.toggle('is-error', !!isError);
    status.textContent = msg;
  };
  const maxAge = Number(form.dataset.photoMaxAgeHours) || 0;
  const extra = {
    check_id: form.dataset.checkId || '',
    task_id: form.dataset.taskId || '',
    caption: form.querySelector('[name=caption]') ? form.querySelector('[name=caption]').value : '',
  };
  const total = files.length;
  let done = 0;
  // Straight to the bucket there's no request-size cap, so a photo the browser
  // can't shrink (e.g. HEIC on Android) can still go up as-is.
  const maxBytes = form.dataset.photoDirect === '1' && directUploads !== false ? 10 * 1024 * 1024 : LIVE_MAX_BYTES;
  let next = prepareLivePhoto(files[0], maxAge, maxBytes);
  try {
    for (let i = 0; i < total; i++) {
      say(`Preparing photo ${i + 1} of ${total}…`);
      const prepared = await next;
      // Compress the following photo while this one uploads.
      next = i + 1 < total ? prepareLivePhoto(files[i + 1], maxAge, maxBytes) : null;
      if (next) next.catch(() => {}); // surfaced when awaited
      await uploadLivePhoto(form.dataset.photoEndpoint, prepared, extra, (p) => {
        say(`Uploading photo ${i + 1} of ${total}… ${Math.round(p * 100)}%`);
      });
      done++;
    }
    say(total === 1 ? 'Photo uploaded.' : `${total} photos uploaded.`);
    inputs.forEach((inp) => { inp.value = ''; });
    return true;
  } catch (err) {
    // Keep only the photos that didn't make it, so a retry doesn't duplicate.
    const remaining = files.slice(done);
    try {
      const dt = new DataTransfer();
      remaining.forEach((f) => dt.items.add(f));
      inputs.forEach((inp, idx) => { inp.files = idx === 0 ? dt.files : new DataTransfer().files; });
      inputs.forEach((inp) => inp.dispatchEvent(new Event('change')));
    } catch (_) {
      inputs.forEach((inp) => { inp.value = ''; });
    }
    say((done ? `${done} of ${total} uploaded. ` : '') + err.message, true);
    return false;
  }
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
      const live = !!form.dataset.photoEndpoint;
      const hadPhotos = live && [...form.querySelectorAll('input[type=file]')].some((i) => i.files && i.files.length);
      const sendForm = (bodyReady) => bodyReady.then((body) => fetch(form.action, { method: 'POST', body, credentials: 'same-origin' }))
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
            const hash = (section && !form.hasAttribute('data-scope-form')) ? '#' + section.id : '';
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

      // Live job photos go up one per request first (see uploadLivePhotos).
      const photosUp = live ? uploadLivePhotos(form) : Promise.resolve(true);

      photosUp.then((ok) => {
        if (!ok) { reEnableSubmit(form); return; }
        // A photos-only form has nothing left to post once its photos are up.
        if (live && hadPhotos && !form.dataset.checkId) { clearDraft(form); window.location.reload(); return; }
        const bodyReady = isMultipart ? shrinkPhotos(new FormData(form))
          : Promise.resolve(new URLSearchParams(new FormData(form)));
        return sendForm(bodyReady);
      });
    });
  });
});

// --- Photo capture preview: show thumbnails of what was taken/selected ---
// Field gardeners tap "Take photo"; this shows the
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
      status.classList.remove('is-error');
      status.hidden = files.length === 0;
      // Count is the only interpolated value (a number, not user text) — safe for innerHTML.
      status.innerHTML = files.length
        ? CHECK_ICON_SVG + (files.length === 1 ? ' 1 photo ready to upload' : ` ${files.length} photos ready to upload`)
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
          span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3l2-2.5h6L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
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
      bar.innerHTML = WARN_ICON_SVG + ' Offline — changes won’t save until you reconnect';
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

  // Sit above whatever is already pinned to the bottom of the viewport — the
  // tab bar, plus a job's fixed action CTA where one is showing. Measured
  // rather than hardcoded so it also lands right on tablets, where the tab bar
  // is hidden and the CTA is an ordinary inline block.
  function bottomOffset() {
    let px = 10; // breathing room from the bottom edge
    const tabbar = document.querySelector('.tabbar');
    if (tabbar && getComputedStyle(tabbar).display !== 'none') {
      px += tabbar.getBoundingClientRect().height;
    }
    const cta = document.querySelector('.mobile-sticky-cta');
    if (cta && getComputedStyle(cta).position === 'fixed') {
      px += cta.getBoundingClientRect().height;
    }
    return `${Math.ceil(px)}px`;
  }

  function show() {
    if (banner) return;
    banner = el('div', 'a2hs');
    banner.style.bottom = bottomOffset();
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

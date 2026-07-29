/**
 * Coarse device classification from a User-Agent header. Used to annotate
 * sign-in activity so admins can see how staff are using the app.
 *
 * The browser does its own, richer detection for the add-to-home-screen
 * prompt (public/js/app.js) because only the client knows whether the app is
 * already running in standalone mode.
 */
function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'unknown device';
  // Android tablets omit "Mobile"; iPads report as iPad (or, since iPadOS 13,
  // as a Mac — indistinguishable server-side, so they fall through to desktop).
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

module.exports = { deviceLabel };

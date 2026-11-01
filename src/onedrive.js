/**
 * OneDrive archiving via Microsoft Graph (client-credentials flow).
 *
 * Admins configure these settings on /admin/settings:
 *   onedrive_tenant_id     Azure AD tenant (Directory) ID
 *   onedrive_client_id     App registration (client) ID
 *   onedrive_client_secret App client secret
 *   onedrive_site_id       SharePoint site ID whose default document library
 *                          receives files, e.g. contoso.sharepoint.com,
 *                          <site-collection-guid>,<web-guid>
 *   onedrive_folder        Root folder for uploads (default "GardeningMgt")
 *
 * The Azure app needs the *application* permission Sites.ReadWrite.All
 * (Microsoft Graph) with admin consent. Uploads are best-effort: callers
 * treat failures as non-fatal and log them.
 */
const { getSettings } = require('./settings');

const SETTING_KEYS = [
  'onedrive_tenant_id', 'onedrive_client_id', 'onedrive_client_secret',
  'onedrive_site_id', 'onedrive_folder',
];

async function getConfig() {
  const s = await getSettings(SETTING_KEYS);
  if (!s.onedrive_tenant_id || !s.onedrive_client_id || !s.onedrive_client_secret || !s.onedrive_site_id) {
    return null; // not configured
  }
  s.onedrive_folder = s.onedrive_folder || 'GardeningMgt';
  return s;
}

async function getAccessToken(cfg) {
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.onedrive_tenant_id)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.onedrive_client_id,
        client_secret: cfg.onedrive_client_secret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

/**
 * Upload one file to the configured SharePoint site's default drive, under
 * folder/path.
 * @param {string} relPath e.g. "job-12-2026-06-18/report.html"
 * @param {Buffer|string} content
 * @param {string} mime
 * @param {{cfg?: object, token?: string}} [ctx] pre-fetched config/token, so a
 *   caller uploading many files in one batch (e.g. archiveToOneDrive) pays for
 *   the settings lookup and OAuth token request once instead of per file.
 */
async function uploadFile(relPath, content, mime, ctx = {}) {
  const cfg = ctx.cfg || await getConfig();
  if (!cfg) return { ok: false, skipped: true, reason: 'OneDrive not configured' };
  const token = ctx.token || await getAccessToken(cfg);
  const drivePath = `${cfg.onedrive_folder}/${relPath}`.split('/').map(encodeURIComponent).join('/');
  const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(cfg.onedrive_site_id)}` +
    `/drive/root:/${drivePath}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
    body: content,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const item = await res.json();
  return { ok: true, webUrl: item.webUrl, id: item.id };
}

/** Verify credentials: fetch a token and the target site drive's metadata. */
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, message: 'Not configured — fill in tenant, client ID, secret and site ID.' };
  try {
    const token = await getAccessToken(cfg);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(cfg.onedrive_site_id)}/drive`,
      { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) return { ok: false, message: `Drive lookup failed: ${data.error?.message || res.status}` };
    return { ok: true, message: `Connected: ${data.driveType} drive "${data.name || cfg.onedrive_site_id}" (${data.quota ? Math.round(data.quota.used / 1e6) + ' MB used' : 'ok'})` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { uploadFile, testConnection, getConfig, getAccessToken, SETTING_KEYS };

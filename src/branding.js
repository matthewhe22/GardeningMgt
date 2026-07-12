const path = require('path');
const sharp = require('sharp');
const { getSetting, setSetting } = require('./settings');
const { sniffOk } = require('./upload');

const SETTING_KEYS = ['brand_logo', 'brand_favicon'];

// Header logo: shown at a few dozen CSS px tall, so this is generous headroom
// for hi-dpi screens without ever storing a huge base64 blob in the settings
// table (it's read on every page render, unlike the other settings here).
const LOGO_BOX = { width: 320, height: 96, fit: 'inside' };
// Browser tab icon: square, small, padded to fill the box (transparent
// letterboxing) rather than stretched, so non-square source logos don't distort.
const FAVICON_BOX = { width: 64, height: 64, fit: 'contain' };

async function getBranding() {
  const [logo, favicon] = await Promise.all([getSetting('brand_logo'), getSetting('brand_favicon')]);
  return { logo, favicon };
}

// Re-encodes to a small PNG data URI so the header partial can drop it
// straight into an <img src>/<link href> with no separate serving route —
// and, just as importantly, decoding-then-re-encoding as pixels strips any
// embedded script/markup a crafted file might carry (relevant since this
// renders unescaped into every page's <head> and nav).
async function imageToDataUri(buffer, { width, height, fit }) {
  const png = await sharp(buffer, { failOn: 'none' })
    .rotate() // apply EXIF orientation before resizing
    .resize({ width, height, fit, withoutEnlargement: true, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function saveBrandImage(key, file, box) {
  if (!file) return { ok: false, message: 'No file received.' };
  if (!sniffOk(file.buffer, path.extname(file.originalname || '').toLowerCase())) {
    return { ok: false, message: 'Unrecognized image file — use JPG, PNG, GIF or WEBP.' };
  }
  let dataUri;
  try {
    dataUri = await imageToDataUri(file.buffer, box);
  } catch (e) {
    return { ok: false, message: 'Could not process that image.' };
  }
  await setSetting(key, dataUri);
  return { ok: true };
}

const saveLogo = (file) => saveBrandImage('brand_logo', file, LOGO_BOX);
// Favicons read best square with the source contained (not cropped), so pad
// rather than reuse the logo's "inside" fit.
const saveFavicon = (file) => saveBrandImage('brand_favicon', file, { ...FAVICON_BOX, fit: 'contain' });

const clearLogo = () => setSetting('brand_logo', null);
const clearFavicon = () => setSetting('brand_favicon', null);

module.exports = { SETTING_KEYS, getBranding, imageToDataUri, saveLogo, saveFavicon, clearLogo, clearFavicon };

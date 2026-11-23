// Minimal JPEG EXIF helpers shared by the browser (window.GmgtExif) and the
// server (require('../public/js/exif.js')). No dependencies.
//
//  readCapture(bytes)        -> { dateTimeOriginal: 'YYYY:MM:DD HH:MM:SS', offset: '+10:00' | null } | null
//  extractApp1(bytes)        -> Uint8Array of the whole EXIF APP1 segment (marker included) | null
//  injectApp1(jpeg, app1)    -> Uint8Array: jpeg with app1 inserted after SOI and its
//                               Orientation reset to 1 (canvas output is already upright)
//  captureTime(info, tzMinutes) -> epoch ms | null. tzMinutes is Date#getTimezoneOffset()
//                               style (minutes WEST of UTC); used only when the
//                               photo carries no OffsetTimeOriginal tag.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GmgtExif = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength));

  /** Locate the EXIF APP1 segment: { start, end, tiff } offsets into bytes, or null. */
  function findApp1(bytes) {
    const b = u8(bytes);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return null; // image data / end: no EXIF before it
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2 || p + 2 + len > b.length) return null;
      if (marker === 0xe1 && len >= 16 &&
          b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
        return { start: p, end: p + 2 + len, tiff: p + 10 };
      }
      p += 2 + len;
    }
    return null;
  }

  function reader(b, tiff, end) {
    const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49; // "II" little endian, "MM" big endian
    const u16 = (o) => (o + 2 > end ? null : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o) => (o + 4 > end ? null
      : (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
        : ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) + b[o] * 0x1000000));
    /** Entries of the IFD at tiff+off: [{ tag, type, count, valueAt }] (valueAt = absolute offset). */
    function ifd(off) {
      const out = [];
      const base = tiff + off;
      const n = u16(base);
      if (n == null || n > 1000) return out;
      for (let i = 0; i < n; i++) {
        const e = base + 2 + i * 12;
        if (e + 12 > end) break;
        const type = u16(e + 2);
        const count = u32(e + 4);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1) * count;
        out.push({ tag: u16(e), type, count, entry: e, valueAt: size <= 4 ? e + 8 : tiff + u32(e + 8) });
      }
      return out;
    }
    const ascii = (en) => {
      if (!en || en.type !== 2 || en.valueAt + en.count > end) return null;
      let s = '';
      for (let i = 0; i < en.count && b[en.valueAt + i]; i++) s += String.fromCharCode(b[en.valueAt + i]);
      return s.trim() || null;
    };
    return { le, u16, u32, ifd, ascii };
  }

  function readCapture(bytes) {
    const b = u8(bytes);
    const seg = findApp1(b);
    if (!seg) return null;
    const r = reader(b, seg.tiff, seg.end);
    if (r.u16(seg.tiff + 2) !== 42) return null;
    const ifd0 = r.ifd(r.u32(seg.tiff + 4));
    const exifPtr = ifd0.find((e) => e.tag === 0x8769);
    const exif = exifPtr ? r.ifd(r.u32(exifPtr.entry + 8)) : [];
    const get = (list, tag) => list.find((e) => e.tag === tag);
    const dto = r.ascii(get(exif, 0x9003)) || r.ascii(get(exif, 0x9004)) || r.ascii(get(ifd0, 0x0132));
    if (!dto || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(dto)) return null;
    const offset = r.ascii(get(exif, 0x9011)) || r.ascii(get(exif, 0x9010));
    return { dateTimeOriginal: dto.slice(0, 19), offset: offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : null };
  }

  function captureTime(info, tzMinutes) {
    if (!info || !info.dateTimeOriginal) return null;
    const m = info.dateTimeOriginal.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (Number.isNaN(asUtc)) return null;
    let offsetMin; // minutes EAST of UTC
    if (info.offset) {
      const sign = info.offset[0] === '-' ? -1 : 1;
      offsetMin = sign * (Number(info.offset.slice(1, 3)) * 60 + Number(info.offset.slice(4, 6)));
    } else if (Number.isFinite(tzMinutes)) {
      offsetMin = -tzMinutes;
    } else {
      return null;
    }
    return asUtc - offsetMin * 60000;
  }

  function extractApp1(bytes) {
    const b = u8(bytes);
    const seg = findApp1(b);
    // Uint8Array#slice copies (Node's Buffer#slice would return a view).
    return seg ? Uint8Array.prototype.slice.call(b, seg.start, seg.end) : null;
  }

  function injectApp1(jpeg, app1) {
    const j = u8(jpeg);
    if (!app1 || j.length < 2 || j[0] !== 0xff || j[1] !== 0xd8) return j;
    const seg = Uint8Array.prototype.slice.call(app1); // copy: we patch orientation in place
    const r = reader(seg, 10, seg.length);
    const ifd0 = r.ifd(r.u32(14) || 0);
    const orient = ifd0.find((e) => e.tag === 0x0112 && e.type === 3);
    if (orient) {
      // SHORT value 1, stored in the first two bytes of the value field.
      seg[orient.valueAt] = r.le ? 1 : 0;
      seg[orient.valueAt + 1] = r.le ? 0 : 1;
    }
    const out = new Uint8Array(j.length + seg.length);
    out.set(j.subarray(0, 2), 0);
    out.set(seg, 2);
    out.set(j.subarray(2), 2 + seg.length);
    return out;
  }

  return { readCapture, captureTime, extractApp1, injectApp1 };
}));

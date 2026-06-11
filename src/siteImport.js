const ExcelJS = require('exceljs');

// Accepted header spellings -> property field. Headers are matched
// case-insensitively with spaces/punctuation stripped.
const HEADER_MAP = {
  name: 'name', site: 'name', sitename: 'name', property: 'name', propertyname: 'name',
  address: 'address', siteaddress: 'address', location: 'address',
  lots: 'lots', noflots: 'lots', oflots: 'lots', nooflots: 'lots',
  numberoflots: 'lots', lotcount: 'lots', numlots: 'lots', totallots: 'lots',
  lat: 'lat', latitude: 'lat',
  lng: 'lng', lon: 'lng', long: 'lng', longitude: 'lng',
  contact: 'contact_name', contactname: 'contact_name',
  phone: 'contact_phone', contactphone: 'contact_phone',
  notes: 'notes', note: 'notes', comments: 'notes',
};

const normalizeHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');

function mapRow(headers, values) {
  const site = {};
  headers.forEach((field, i) => {
    if (!field) return;
    const v = values[i];
    if (v === null || v === undefined || String(v).trim() === '') return;
    site[field] = String(v).trim();
  });
  return site;
}

function validateSites(rawRows) {
  const sites = [];
  const errors = [];
  rawRows.forEach(({ rowNumber, site }) => {
    if (!site.name && !site.address) return; // skip fully blank lines
    if (!site.name) { errors.push(`Row ${rowNumber}: missing site name`); return; }
    if (!site.address) { errors.push(`Row ${rowNumber}: missing address`); return; }
    for (const numField of ['lots', 'lat', 'lng']) {
      if (site[numField] !== undefined && !Number.isFinite(Number(site[numField]))) {
        errors.push(`Row ${rowNumber}: "${site[numField]}" is not a valid ${numField}`);
        delete site[numField];
      }
    }
    sites.push({
      name: site.name,
      address: site.address,
      lots: site.lots !== undefined ? Math.round(Number(site.lots)) : null,
      lat: site.lat !== undefined ? Number(site.lat) : null,
      lng: site.lng !== undefined ? Number(site.lng) : null,
      contact_name: site.contact_name || null,
      contact_phone: site.contact_phone || null,
      notes: site.notes || null,
    });
  });
  return { sites, errors };
}

/** Parse an .xlsx upload (first worksheet, first row = headers). */
async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { sites: [], errors: ['Workbook has no worksheets'] };

  let headers = null;
  const rawRows = [];
  sheet.eachRow((row, rowNumber) => {
    // row.values is 1-based; cell values may be rich objects -> use .text fallback
    const values = (row.values || []).slice(1).map((c) =>
      c && typeof c === 'object' ? (c.text ?? c.result ?? '') : c);
    if (!headers) {
      headers = values.map((h) => HEADER_MAP[normalizeHeader(h)] || null);
      return;
    }
    rawRows.push({ rowNumber, site: mapRow(headers, values) });
  });
  if (!headers || !headers.includes('name')) {
    return { sites: [], errors: ['Could not find a "Site Name" (or "Name") column in the first row'] };
  }
  return validateSites(rawRows);
}

/** Parse a CSV upload (simple quoted-field support). */
function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { sites: [], errors: ['File is empty'] };

  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const headers = splitLine(lines[0]).map((h) => HEADER_MAP[normalizeHeader(h)] || null);
  if (!headers.includes('name')) {
    return { sites: [], errors: ['Could not find a "Site Name" (or "Name") column in the first row'] };
  }
  const rawRows = lines.slice(1).map((line, idx) => ({
    rowNumber: idx + 2,
    site: mapRow(headers, splitLine(line)),
  }));
  return validateSites(rawRows);
}

/** @returns {Promise<{sites: object[], errors: string[]}>} */
async function parseSiteUpload(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(file.buffer);
  return parseXlsx(file.buffer);
}

module.exports = { parseSiteUpload, parseCsv, parseXlsx };

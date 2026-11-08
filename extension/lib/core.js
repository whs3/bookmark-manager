// Pure helpers shared by the background worker, popup and manager.
// No chrome.* calls in here, so everything can be unit-tested in Node.

// ---------- URLs ----------

const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|ref_src)$/i;

/**
 * Canonical form of a URL used for duplicate detection and matching visits.
 * http/https, "www.", default ports, trailing slashes, empty fragments and
 * common tracking parameters are ignored.
 */
export function normalizeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
  const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k));
  const qs = params.length ? '?' + new URLSearchParams(params).toString() : '';
  const host = u.hostname.replace(/^www\./, '');
  const port = u.port ? ':' + u.port : '';
  const path = u.pathname.replace(/\/+$/, '');
  const hash = u.hash.length > 1 ? u.hash : '';
  return `//${host}${port}${path}${qs}${hash}`;
}

export function isParsableUrl(s) {
  try {
    new URL(String(s));
    return true;
  } catch {
    return false;
  }
}

/** Turn user input like "example.com/page" into a full URL, or '' if invalid. */
export function coerceUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^:/]+:\d+(\/|$)/.test(s)) s = 'https://' + s;
  return isParsableUrl(s) ? s : '';
}

// ---------- Tags ----------

/** Accepts an array or a "a, b; c|d" string. Returns lowercase, trimmed, unique tags. */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,;|]/);
  const out = [];
  for (const raw of list) {
    const t = String(raw ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** [[tag, count], ...] sorted by tag name. */
export function tagCounts(bookmarks) {
  const m = new Map();
  for (const b of bookmarks) for (const t of b.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------- Search ----------

const TOKEN_RE = /-?(?:[a-z]+:)?"[^"]*"|\S+/gi;

/**
 * Parse a search string into clauses. Supported syntax:
 *   word          matches name, URL, folder or tag
 *   #tag tag:x    bookmark has a tag starting with x
 *   title:x url:x folder:x
 *   -term         negate any of the above
 *   "two words"   phrase
 */
export function parseQuery(q) {
  const clauses = [];
  for (let tok of String(q ?? '').match(TOKEN_RE) || []) {
    let neg = false;
    if (tok.length > 1 && tok.startsWith('-')) {
      neg = true;
      tok = tok.slice(1);
    }
    let field = 'any';
    const m = tok.match(/^(tag|title|name|url|folder):(.*)$/i);
    if (m) {
      field = m[1].toLowerCase() === 'name' ? 'title' : m[1].toLowerCase();
      tok = m[2];
    } else if (tok.length > 1 && tok.startsWith('#')) {
      field = 'tag';
      tok = tok.slice(1);
    }
    const value = tok.replace(/^"|"$/g, '').trim().toLowerCase();
    if (value) clauses.push({ field, value, neg });
  }
  return clauses;
}

export function matches(b, clauses) {
  for (const { field, value, neg } of clauses) {
    let hit;
    switch (field) {
      case 'tag':
        hit = b.tags.some((t) => t.startsWith(value));
        break;
      case 'title':
        hit = b.title.toLowerCase().includes(value);
        break;
      case 'url':
        hit = b.url.toLowerCase().includes(value);
        break;
      case 'folder':
        hit = b.folder.toLowerCase().includes(value);
        break;
      default:
        hit =
          b.title.toLowerCase().includes(value) ||
          b.url.toLowerCase().includes(value) ||
          b.folder.toLowerCase().includes(value) ||
          b.tags.some((t) => t.includes(value));
    }
    if (hit === neg) return false;
  }
  return true;
}

// ---------- Sorting ----------

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

export const SORTS = {
  lastUsed: { label: 'Last used', cmp: (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || (b.savedAt || 0) - (a.savedAt || 0) },
  savedAt: { label: 'Date saved', cmp: (a, b) => (b.savedAt || 0) - (a.savedAt || 0) },
  title: { label: 'Name', cmp: byTitle },
  url: { label: 'URL', cmp: (a, b) => a.key.localeCompare(b.key) || byTitle(a, b) },
};

export function sortBookmarks(list, key = 'lastUsed') {
  const cmp = (SORTS[key] || SORTS.lastUsed).cmp;
  return [...list].sort(cmp);
}

// ---------- Dates ----------

/** Accepts ms, seconds, microseconds (Firefox), numeric strings or ISO strings. */
export function parseDate(v) {
  if (v == null || v === '') return null;
  let n = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e14) n = n / 1000; // microseconds
  else if (n < 1e11) n = n * 1000; // seconds
  return Math.round(n);
}

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function formatDate(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}

export function formatRelative(ms, now = Date.now()) {
  if (!ms) return '—';
  const s = (now - ms) / 1000;
  if (s < 0) return new Date(ms).toLocaleDateString();
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 2) return 'yesterday';
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------- CSV ----------

export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// ---------- Import / export ----------

export const CSV_COLUMNS = ['title', 'url', 'tags', 'folder', 'dateAdded', 'lastUsed'];

const CSV_ALIASES = {
  title: ['title', 'name'],
  url: ['url', 'href', 'link', 'address'],
  tags: ['tags', 'tag', 'labels', 'groups'],
  folder: ['folder', 'path', 'group'],
  savedAt: ['dateadded', 'added', 'saved', 'savedat', 'created', 'datesaved'],
  lastUsed: ['lastused', 'lastvisited', 'lastopened', 'used'],
};

export function toExportRecord(b) {
  return {
    title: b.title,
    url: b.url,
    tags: [...b.tags],
    folder: b.folder,
    dateAdded: iso(b.savedAt),
    lastUsed: iso(b.lastUsed),
  };
}

export function exportJSON(bookmarks, now = new Date()) {
  return JSON.stringify(
    {
      format: 'bookmark-manager',
      version: 1,
      exportedAt: now.toISOString(),
      count: bookmarks.length,
      bookmarks: bookmarks.map(toExportRecord),
    },
    null,
    2,
  );
}

export function exportCSV(bookmarks) {
  const rows = bookmarks.map((b) => {
    const r = toExportRecord(b);
    return [r.title, r.url, r.tags.join(';'), r.folder, r.dateAdded ?? '', r.lastUsed ?? ''];
  });
  return '﻿' + toCSV([CSV_COLUMNS, ...rows]);
}

/**
 * Parse an exported file. Format is chosen by extension, else by content.
 * Returns { records: [{title,url,tags,folder,savedAt,lastUsed}], errors: [string] }.
 */
export function parseImport(text, filename = '') {
  const body = String(text).replace(/^﻿/, '').trim();
  if (!body) return { records: [], errors: [] };
  const isJson = /\.json$/i.test(filename) || (!/\.csv$/i.test(filename) && /^[[{]/.test(body));
  let raw;
  if (isJson) {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
    raw = Array.isArray(data) ? data : Array.isArray(data?.bookmarks) ? data.bookmarks : null;
    if (!raw) throw new Error('JSON must be an array of bookmarks or an object with a "bookmarks" array.');
  } else {
    const rows = parseCSV(body);
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
    const cols = {};
    for (const [key, names] of Object.entries(CSV_ALIASES)) {
      const i = header.findIndex((h) => names.includes(h));
      if (i >= 0) cols[key] = i;
    }
    if (cols.url === undefined) throw new Error('CSV needs a header row with a "url" column.');
    raw = rows.slice(1).map((r) => Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, r[i] ?? ''])));
  }

  const records = [];
  const errors = [];
  raw.forEach((r, i) => {
    const where = isJson ? `Entry ${i + 1}` : `Row ${i + 2}`;
    if (!r || typeof r !== 'object') {
      errors.push(`${where}: not an object`);
      return;
    }
    const url = String(r.url ?? r.href ?? r.uri ?? '').trim();
    if (!url || !isParsableUrl(url)) {
      errors.push(`${where}: invalid URL "${url}"`);
      return;
    }
    const folder = Array.isArray(r.folder) ? r.folder.join('/') : String(r.folder ?? r.path ?? '');
    records.push({
      title: String(r.title ?? r.name ?? '').trim() || url,
      url,
      tags: normalizeTags(r.tags ?? []),
      folder: folder.trim(),
      savedAt: parseDate(r.dateAdded ?? r.savedAt ?? r.added),
      lastUsed: parseDate(r.lastUsed ?? r.lastVisited),
    });
  });
  return { records, errors };
}

// ---------- Durable copy of metadata inside the bookmarks tree ----------
//
// Extension storage is wiped when the extension is removed, so tags and dates
// are mirrored into a bookmarks folder. Each bookmark in it carries a chunk of
// base64url JSON in the fragment of a URL on the reserved ".invalid" TLD
// (never resolvable; data: URLs are rejected by Firefox's bookmarks API):
//   https://bookmark-manager-data.invalid/<writeId>/<index>/<count>#<chunk>
// Mirror entries are keyed by normalized URL (bookmark IDs differ per device):
//   { g: tags, ga: when tags were last edited, u: lastUsed, s: imported/edited savedAt,
//     da: when the dates were last edited by hand }

export const DATA_FOLDER_TITLE = 'Bookmark Manager data';
export const DATA_HOST = 'bookmark-manager-data.invalid';
const CHUNK_CHARS = 30000;
const LAST_USED_SLACK = 3600e3; // don't rewrite the mirror for last-used changes under an hour

export const isDataUrl = (url) => {
  try {
    return new URL(url).hostname === DATA_HOST;
  } catch {
    return false;
  }
};

export function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

/** entries → [{ url, title }] chunk bookmarks. */
export function encodeMirror(entries, writeId = Date.now().toString(36)) {
  const b64 = toBase64Url(JSON.stringify({ v: 1, e: entries }));
  const parts = [];
  for (let i = 0; i < b64.length || i === 0; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));
  return parts.map((p, i) => ({
    url: `https://${DATA_HOST}/${writeId}/${i}/${parts.length}#${p}`,
    title: `${i + 1}/${parts.length} · Tags and dates for the Bookmark Manager extension — do not edit`,
  }));
}

/**
 * Decode chunk-bookmark URLs (possibly from several writes/folders).
 * Returns { entries, complete } — complete=false if any write is missing chunks
 * or corrupt (e.g. still syncing), in which case the mirror must not be overwritten.
 */
export function decodeMirror(urls) {
  const groups = new Map();
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const [, id, i, n] = u.pathname.split('/');
    if (u.hostname !== DATA_HOST || !id) continue;
    if (!groups.has(id)) groups.set(id, { n: Number(n), parts: [] });
    groups.get(id).parts[Number(i)] = u.hash.slice(1);
  }
  let entries = {};
  let complete = true;
  for (const { n, parts } of groups.values()) {
    if (parts.filter((p) => p !== undefined).length !== n) {
      complete = false;
      continue;
    }
    try {
      const data = JSON.parse(fromBase64Url(parts.join('')));
      entries = mergeMirrorEntries(entries, data.e || {});
    } catch {
      complete = false;
    }
  }
  return { entries, complete, writes: groups.size };
}

const sameTags = (a = [], b = []) => a.length === b.length && a.every((t, i) => t === b[i]);

function compactEntry({ g = [], ga = 0, u = 0, s = 0, da = 0 }) {
  const e = {};
  if (g.length) e.g = g;
  if (ga) e.ga = ga;
  if (u) e.u = u;
  if (s) e.s = s;
  if (da) e.da = da;
  return e;
}

/**
 * Merge two entries; `a` wins ties.
 *  - Tags: the side edited most recently (ga) wins.
 *  - Dates: if one side's dates were edited by hand more recently (da), its values win —
 *    except that a visit (u) newer than that edit still counts. Otherwise the latest visit
 *    wins and an imported/edited savedAt is kept.
 */
function mergeEntry(a = {}, b = {}) {
  const ad = a.da || 0;
  const bd = b.da || 0;
  let u;
  let s;
  if (bd > ad) {
    u = Math.max(b.u || 0, (a.u || 0) > bd ? a.u : 0);
    s = b.s || 0;
  } else if (ad > bd) {
    u = Math.max(a.u || 0, (b.u || 0) > ad ? b.u : 0);
    s = a.s || 0;
  } else {
    u = Math.max(a.u || 0, b.u || 0);
    s = a.s || b.s || 0;
  }
  return compactEntry({
    g: (b.ga || 0) > (a.ga || 0) ? b.g : a.g,
    ga: Math.max(a.ga || 0, b.ga || 0),
    u,
    s,
    da: Math.max(ad, bd),
  });
}

const sameEntry = (x = {}, y = {}, slack = 0) =>
  (x.ga || 0) === (y.ga || 0) &&
  (x.s || 0) === (y.s || 0) &&
  (x.da || 0) === (y.da || 0) &&
  sameTags(x.g, y.g) &&
  Math.abs((x.u || 0) - (y.u || 0)) <= slack;

export function mergeMirrorEntries(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = mergeEntry(out[k], v);
  return out;
}

function mirrorDiffers(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return true;
  return ka.some((k) => !b[k] || !sameEntry(a[k], b[k], LAST_USED_SLACK));
}

/**
 * Two-way merge of local metadata with the mirror (rules in mergeEntry; local wins ties).
 *   local:    Map normalizedUrl → { id, tags, tagsAt, lastUsed, savedAt, datesAt } for every bookmark
 *   mirror:   entries decoded from the bookmarks folder
 *   removals: normalized URLs whose bookmarks were deleted since the last sync
 * Entries for URLs not bookmarked here are kept (another device may still have them).
 */
export function mergeMeta(local, mirror, removals = []) {
  const next = { ...mirror };
  for (const k of removals) if (!local.has(k)) delete next[k];
  const localWrites = {};
  for (const [key, L] of local) {
    const mine = compactEntry({ g: L.tags, ga: L.tagsAt, u: L.lastUsed, s: L.savedAt, da: L.datesAt });
    const merged = mergeEntry(mine, mirror[key]);
    if (!sameEntry(mine, merged)) {
      localWrites[L.id] = {
        tags: merged.g || [],
        tagsAt: merged.ga || 0,
        lastUsed: merged.u || null,
        savedAt: merged.s || null,
        ...(merged.da ? { datesAt: merged.da } : {}),
      };
    }
    if (Object.keys(merged).length) next[key] = merged;
    else delete next[key];
  }
  return { localWrites, mirror: next, changed: mirrorDiffers(mirror, next) };
}

/** Split a folder path like "Bookmarks bar / Dev / JS" into segments. */
export function splitFolderPath(path) {
  return String(path ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

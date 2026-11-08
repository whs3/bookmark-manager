// Data layer over chrome.bookmarks (the real browser bookmarks) and
// chrome.storage.local (the extra metadata: tags, last used, imported dates).
//
// Metadata is kept per bookmark under the key "m:<bookmarkId>":
//   { tags: string[], tagsAt: ms (last tag edit), lastUsed: ms|null, savedAt?: ms,
//     datesAt?: ms (last manual edit of savedAt/lastUsed) }
// A durable copy lives in the bookmarks tree — see lib/mirror.js.
// savedAt is only set when an import carried an original date or it was edited
// by hand; otherwise the browser's own dateAdded is used.

import { normalizeUrl, normalizeTags, splitFolderPath, DATA_FOLDER_TITLE } from './core.js';

export const META_PREFIX = 'm:';
const DEFAULT_SETTINGS = { blockDuplicates: true, sort: 'lastUsed', historyBannerDismissed: false };

export class DuplicateError extends Error {
  constructor(existing) {
    super(`Already bookmarked as “${existing.title}”${existing.folder ? ` in ${existing.folder}` : ''}.`);
    this.name = 'DuplicateError';
    this.existing = existing;
  }
}

// ---------- Settings ----------

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------- Reading ----------

export async function getTree() {
  return (await chrome.bookmarks.getTree())[0];
}

export function flattenTree(root, stored = {}) {
  const bookmarks = [];
  const folders = [];
  const walk = (node, path) => {
    for (const child of node.children || []) {
      if (child.type === 'separator') continue;
      if (!child.url && child.title === DATA_FOLDER_TITLE) continue; // our hidden data folder
      if (child.url) {
        const meta = stored[META_PREFIX + child.id] || {};
        bookmarks.push({
          id: child.id,
          parentId: child.parentId,
          index: child.index,
          title: child.title || '',
          url: child.url,
          key: normalizeUrl(child.url),
          folder: path.join(' / '),
          savedAt: meta.savedAt ?? child.dateAdded ?? null,
          lastUsed: meta.lastUsed ?? null,
          tags: meta.tags ?? [],
        });
      } else {
        const p = [...path, child.title || '(untitled)'];
        folders.push({ id: child.id, path: p.join(' / '), depth: p.length - 1 });
        walk(child, p);
      }
    }
  };
  walk(root, []);
  return { bookmarks, folders };
}

export async function loadAll() {
  const [root, stored] = await Promise.all([getTree(), chrome.storage.local.get(null)]);
  return flattenTree(root, stored);
}

export async function findDuplicate(url, excludeId) {
  const key = normalizeUrl(url);
  const { bookmarks } = flattenTree(await getTree());
  return bookmarks.find((b) => b.key === key && b.id !== excludeId) || null;
}

/** The folder new bookmarks go to by default ("Other bookmarks" in Chrome). */
export function defaultRoot(roots) {
  return roots.find((r) => r.id === '2' || r.id === 'unfiled_____') || roots[roots.length - 1];
}

// ---------- Metadata ----------

export async function patchMeta(id, patch) {
  const k = META_PREFIX + id;
  const cur = (await chrome.storage.local.get(k))[k] || {};
  if ('tags' in patch) patch = { ...patch, tagsAt: Date.now() };
  await chrome.storage.local.set({ [k]: { ...cur, ...patch } });
}

export async function removeMeta(ids) {
  if (ids.length) await chrome.storage.local.remove(ids.map((id) => META_PREFIX + id));
}

export const markUsed = (id, when = Date.now()) => patchMeta(id, { lastUsed: when });

/** Apply fn(currentTags) => newTags to many bookmarks in one write. */
export async function modifyTags(ids, fn) {
  const keys = ids.map((id) => META_PREFIX + id);
  const cur = await chrome.storage.local.get(keys);
  const out = {};
  for (const k of keys) {
    const m = cur[k] || {};
    out[k] = { ...m, tags: normalizeTags(fn(m.tags || [])), tagsAt: Date.now() };
  }
  await chrome.storage.local.set(out);
}

/** Rename a tag everywhere, or remove it when `to` is null. Returns affected count. */
export async function renameTag(from, to) {
  const stored = await chrome.storage.local.get(null);
  const out = {};
  for (const [k, m] of Object.entries(stored)) {
    if (!k.startsWith(META_PREFIX) || !m.tags?.includes(from)) continue;
    const tags = m.tags.flatMap((t) => (t === from ? (to ? [to] : []) : [t]));
    out[k] = { ...m, tags: normalizeTags(tags), tagsAt: Date.now() };
  }
  await chrome.storage.local.set(out);
  return Object.keys(out).length;
}

// ---------- Writing bookmarks ----------

export async function addBookmark({ title, url, tags = [], parentId }) {
  const dup = await findDuplicate(url);
  if (dup) throw new DuplicateError(dup);
  const node = await chrome.bookmarks.create({ title: title || url, url, ...(parentId ? { parentId } : {}) });
  const t = normalizeTags(tags);
  if (t.length) await patchMeta(node.id, { tags: t });
  return node;
}

/**
 * Update any attribute. Omitted fields are left alone.
 * savedAt: ms, or null to fall back to the browser's own "date added".
 * lastUsed: ms, or null for "never".
 */
export async function updateBookmark(id, { title, url, tags, parentId, savedAt, lastUsed }) {
  const [node] = await chrome.bookmarks.get(id);
  if (url !== undefined && normalizeUrl(url) !== normalizeUrl(node.url)) {
    const dup = await findDuplicate(url, id);
    if (dup) throw new DuplicateError(dup);
  }
  const changes = {};
  if (title !== undefined && title !== node.title) changes.title = title;
  if (url !== undefined && url !== node.url) changes.url = url;
  if (Object.keys(changes).length) await chrome.bookmarks.update(id, changes);
  if (parentId && parentId !== node.parentId) await chrome.bookmarks.move(id, { parentId });

  const k = META_PREFIX + id;
  const meta = (await chrome.storage.local.get(k))[k] || {};
  const patch = {};
  if (tags !== undefined) {
    const t = normalizeTags(tags);
    if (t.join('\n') !== (meta.tags || []).join('\n')) Object.assign(patch, { tags: t, tagsAt: Date.now() });
  }
  // Manual date edits are timestamped so a sync from another device doesn't undo them.
  if (savedAt !== undefined) Object.assign(patch, { savedAt: savedAt || null, datesAt: Date.now() });
  if (lastUsed !== undefined) Object.assign(patch, { lastUsed: lastUsed || null, datesAt: Date.now() });
  if (Object.keys(patch).length) await chrome.storage.local.set({ [k]: { ...meta, ...patch } });
}

export async function deleteBookmarks(ids) {
  for (const id of ids) {
    try {
      await chrome.bookmarks.remove(id);
    } catch {
      /* already gone */
    }
  }
  await removeMeta(ids);
}

/** Re-create bookmarks captured before deletion (undo). */
export async function restoreBookmarks(snapshots) {
  const writes = {};
  for (const s of snapshots) {
    if (await findDuplicate(s.url)) continue;
    let node;
    try {
      node = await chrome.bookmarks.create({ parentId: s.parentId, index: s.index, title: s.title, url: s.url });
    } catch {
      node = await chrome.bookmarks.create({ title: s.title, url: s.url });
    }
    writes[META_PREFIX + node.id] = { ...s.meta, tagsAt: Date.now() };
  }
  await chrome.storage.local.set(writes);
}

export async function openBookmark(b, mode = 'new') {
  await markUsed(b.id);
  if (mode === 'current') await chrome.tabs.update({ url: b.url });
  else await chrome.tabs.create({ url: b.url, active: mode !== 'background' });
}

export async function openManager(params = '') {
  const base = chrome.runtime.getURL('manager.html');
  const url = params ? `${base}?${params}` : base;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(base));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, ...(params ? { url } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------- Bulk operations ----------

// While a bulk operation runs, the background worker skips its duplicate
// check for each created bookmark (we de-duplicate up front instead).
const setBulk = (on) => chrome.storage.local.set({ bulkUntil: on ? Date.now() + 60_000 : 0 });

async function ensureFolder(root, path, cache) {
  const segs = splitFolderPath(path);
  const roots = root.children || [];
  let parent = segs.length && roots.find((r) => r.title.toLowerCase() === segs[0].toLowerCase());
  if (parent) segs.shift();
  else parent = defaultRoot(roots);
  let id = parent.id;
  let cacheKey = id;
  for (const seg of segs) {
    cacheKey += '/' + seg.toLowerCase();
    if (cache.has(cacheKey)) {
      id = cache.get(cacheKey);
      continue;
    }
    const kids = await chrome.bookmarks.getChildren(id);
    const found = kids.find((k) => !k.url && k.title.toLowerCase() === seg.toLowerCase());
    id = found ? found.id : (await chrome.bookmarks.create({ parentId: id, title: seg })).id;
    cache.set(cacheKey, id);
  }
  return id;
}

/**
 * Import parsed records. Records whose URL is already bookmarked are not
 * added again; their tags are merged into the existing bookmark instead.
 */
export async function importRecords(records, onProgress) {
  const root = await getTree();
  const stored = await chrome.storage.local.get(null);
  const { bookmarks } = flattenTree(root, stored);
  const byKey = new Map(bookmarks.map((b) => [b.key, b]));
  const folderCache = new Map();
  const writes = {};
  const result = { added: 0, merged: 0, duplicates: 0, failed: [] };

  await setBulk(true);
  try {
    for (const [i, r] of records.entries()) {
      if (i % 50 === 0) await setBulk(true);
      const key = normalizeUrl(r.url);
      const existing = byKey.get(key);
      if (existing) {
        const tags = normalizeTags([...existing.tags, ...r.tags]);
        if (tags.length > existing.tags.length) {
          const k = META_PREFIX + existing.id;
          writes[k] = { ...(writes[k] ?? stored[k] ?? {}), tags, tagsAt: Date.now() };
          existing.tags = tags;
          result.merged++;
        } else result.duplicates++;
      } else {
        try {
          const parentId = await ensureFolder(root, r.folder, folderCache);
          const node = await chrome.bookmarks.create({ parentId, title: r.title, url: r.url });
          const meta = { tags: r.tags, ...(r.tags.length ? { tagsAt: Date.now() } : {}) };
          if (r.savedAt) meta.savedAt = r.savedAt;
          if (r.lastUsed) meta.lastUsed = r.lastUsed;
          writes[META_PREFIX + node.id] = meta;
          byKey.set(key, { id: node.id, key, tags: r.tags });
          result.added++;
        } catch (e) {
          result.failed.push(`${r.url}: ${e.message}`);
        }
      }
      onProgress?.(i + 1, records.length);
    }
    await chrome.storage.local.set(writes);
  } finally {
    await setBulk(false);
  }
  return result;
}

/** Fill in "last used" from the browser history's last visit time. */
export async function seedLastUsedFromHistory() {
  const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 100000 });
  const last = new Map();
  for (const it of items) {
    if (!it.lastVisitTime) continue;
    const k = normalizeUrl(it.url);
    if ((last.get(k) || 0) < it.lastVisitTime) last.set(k, it.lastVisitTime);
  }
  const stored = await chrome.storage.local.get(null);
  const { bookmarks } = flattenTree(await getTree(), stored);
  const writes = {};
  for (const b of bookmarks) {
    const t = last.get(b.key);
    if (t && (!b.lastUsed || t > b.lastUsed)) writes[META_PREFIX + b.id] = { ...stored[META_PREFIX + b.id], lastUsed: Math.round(t) };
  }
  await chrome.storage.local.set(writes);
  return Object.keys(writes).length;
}

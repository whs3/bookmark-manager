// Keeps a durable copy of tags / dates inside the bookmarks tree, so they
// survive removing the extension and travel with browser bookmark sync.
// Runs in the background worker; the encoding and merge rules are in core.js.

import { DATA_FOLDER_TITLE, encodeMirror, decodeMirror, mergeMeta } from './core.js';
import { getTree, flattenTree, defaultRoot, META_PREFIX } from './store.js';

function findDataFolders(root) {
  const found = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.url) continue;
      if (c.title === DATA_FOLDER_TITLE) found.push(c);
      else walk(c);
    }
  };
  walk(root);
  return found;
}

async function writeMirror(root, folders, entries) {
  const chunks = encodeMirror(entries);
  let folder = folders[0];
  if (!folder) folder = await chrome.bookmarks.create({ parentId: defaultRoot(root.children).id, title: DATA_FOLDER_TITLE });
  const existing = folder.children || [];
  for (const [i, c] of chunks.entries()) {
    const old = existing[i];
    if (old?.url) await chrome.bookmarks.update(old.id, c);
    else await chrome.bookmarks.create({ parentId: folder.id, ...c });
  }
  for (const extra of existing.slice(chunks.length)) await chrome.bookmarks.removeTree(extra.id);
  // Two devices may each have created the folder before syncing: fold into one.
  for (const dup of folders.slice(1)) await chrome.bookmarks.removeTree(dup.id);
}

async function doSync() {
  const [root, stored] = await Promise.all([getTree(), chrome.storage.local.get(null)]);
  const folders = findDataFolders(root);
  const urls = folders.flatMap((f) => (f.children || []).map((c) => c.url).filter(Boolean));
  const { entries, complete, writes } = decodeMirror(urls);

  const local = new Map();
  for (const b of flattenTree(root, stored).bookmarks) {
    if (local.has(b.key)) continue;
    const m = stored[META_PREFIX + b.id] || {};
    local.set(b.key, { id: b.id, tags: m.tags || [], tagsAt: m.tagsAt || 0, lastUsed: m.lastUsed || null, savedAt: m.savedAt || null, datesAt: m.datesAt || 0 });
  }
  const removals = stored.mirrorRemovals || [];
  const { localWrites, mirror, changed } = mergeMeta(local, entries, removals);

  // Re-read right before writing and skip anything edited while we were merging.
  const keys = Object.keys(localWrites).map((id) => META_PREFIX + id);
  const fresh = keys.length ? await chrome.storage.local.get(keys) : {};
  const out = {};
  for (const [id, meta] of Object.entries(localWrites)) {
    const k = META_PREFIX + id;
    if (JSON.stringify(fresh[k]) !== JSON.stringify(stored[k])) continue;
    out[k] = { ...stored[k], ...meta };
  }
  if (Object.keys(out).length) await chrome.storage.local.set(out);

  // Never overwrite a mirror we couldn't fully read (e.g. sync still delivering chunks).
  if (!complete) return { restored: Object.keys(out).length, wrote: false };
  if (changed || folders.length > 1 || writes > 1) await writeMirror(root, folders, mirror);
  if (removals.length) {
    const { mirrorRemovals = [] } = await chrome.storage.local.get('mirrorRemovals');
    await chrome.storage.local.set({ mirrorRemovals: mirrorRemovals.filter((k) => !removals.includes(k)) });
  }
  return { restored: Object.keys(out).length, wrote: changed };
}

let running = null;
let again = false;

/** Merge local metadata with the bookmarks-folder copy (both directions). Serialized. */
export function syncMirror() {
  if (running) {
    again = true;
    return running;
  }
  running = doSync()
    .catch((e) => console.error('Bookmark Manager: metadata sync failed', e))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        syncMirror();
      }
    });
  return running;
}

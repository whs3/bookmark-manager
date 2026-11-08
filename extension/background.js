// Background worker:
//  - records "last used" whenever a tab finishes loading a bookmarked URL
//  - blocks duplicate bookmarks created anywhere (including the browser's star)
//  - cleans up metadata when bookmarks are deleted
//  - handles the global keyboard shortcuts
//  - keeps the durable copy of tags/dates in the bookmarks tree up to date

import { normalizeUrl, isDataUrl } from './lib/core.js';
import { getSettings, patchMeta, removeMeta, addBookmark, DuplicateError, getTree, flattenTree, openManager, META_PREFIX } from './lib/store.js';
import { syncMirror } from './lib/mirror.js';

// ----- In-memory URL index (rebuilt lazily after any bookmark change) -----

let index = null;
let generation = 0;

async function getIndex() {
  if (index) return index;
  const gen = generation;
  const { bookmarks } = flattenTree(await getTree());
  const built = new Map();
  for (const b of bookmarks) {
    if (!built.has(b.key)) built.set(b.key, []);
    built.get(b.key).push(b);
  }
  if (gen === generation) index = built;
  return built;
}

function invalidate() {
  generation++;
  index = null;
}

// ----- Notifications -----

function notify(title, message) {
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

// ----- Last-used tracking -----

chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !/^(https?|file|ftp):/i.test(tab.url)) return;
  const matches = (await getIndex()).get(normalizeUrl(tab.url));
  if (!matches) return;
  const now = Date.now();
  await Promise.all(matches.map((b) => patchMeta(b.id, { lastUsed: now })));
});

// ----- Duplicate prevention -----

let browserImporting = false;
chrome.bookmarks.onImportBegan?.addListener(() => (browserImporting = true));
chrome.bookmarks.onImportEnded?.addListener(() => {
  browserImporting = false;
  invalidate();
});

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  invalidate();
  if (!node.url || browserImporting || isDataUrl(node.url)) return;
  const [settings, { bulkUntil = 0 }] = await Promise.all([getSettings(), chrome.storage.local.get('bulkUntil')]);
  if (!settings.blockDuplicates || bulkUntil > Date.now()) return;
  const others = ((await getIndex()).get(normalizeUrl(node.url)) || []).filter((b) => b.id !== id);
  if (!others.length) return;
  await chrome.bookmarks.remove(id);
  const o = others[0];
  notify('Duplicate bookmark blocked', `Already saved as “${o.title}”${o.folder ? ` in ${o.folder}` : ''}.`);
});

chrome.bookmarks.onRemoved.addListener(async (id, info) => {
  invalidate();
  const ids = [];
  const urls = [];
  const collect = (n) => {
    ids.push(n.id);
    if (n.url && !isDataUrl(n.url)) urls.push(normalizeUrl(n.url));
    n.children?.forEach(collect);
  };
  if (info?.node) collect(info.node);
  else ids.push(id);
  await removeMeta(ids);
  // Tell the next sync to drop these from the durable copy too.
  if (urls.length) {
    const { mirrorRemovals = [] } = await chrome.storage.local.get('mirrorRemovals');
    await chrome.storage.local.set({ mirrorRemovals: [...new Set([...mirrorRemovals, ...urls])] });
    schedulePush();
  }
});

chrome.bookmarks.onChanged.addListener(invalidate);
chrome.bookmarks.onMoved.addListener(invalidate);

// ----- Keyboard shortcuts -----

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-manager') return openManager();
  if (command === 'quick-add') {
    tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.url || !/^(https?|file|ftp):/i.test(tab.url)) return notify('Cannot bookmark this page', 'Only web pages can be bookmarked.');
    try {
      await addBookmark({ title: tab.title, url: tab.url });
      notify('Bookmarked', tab.title || tab.url);
    } catch (e) {
      notify(e instanceof DuplicateError ? 'Already bookmarked' : 'Could not bookmark', e.message);
    }
  }
});

// ----- Durable copy of tags/dates in the bookmarks tree (see lib/mirror.js) -----

const schedulePush = () => chrome.alarms.create('mirror-push', { delayInMinutes: 0.5 });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mirror-pull', { periodInMinutes: 5 });
  syncMirror(); // restores tags after a reinstall
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('mirror-pull', { periodInMinutes: 5 });
  syncMirror();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith('mirror-')) syncMirror();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(META_PREFIX))) schedulePush();
});

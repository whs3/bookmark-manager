// The durable copy of tags/dates kept in the bookmarks tree (lib/mirror.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from './fake-chrome.js';
import { encodeMirror, decodeMirror, mergeMeta, DATA_FOLDER_TITLE } from '../extension/lib/core.js';

let store;
let syncMirror;
beforeEach(async () => {
  globalThis.chrome = fakeChrome();
  store = await import('../extension/lib/store.js');
  ({ syncMirror } = await import('../extension/lib/mirror.js'));
});

const tagsOf = async (url) => (await store.loadAll()).bookmarks.find((b) => b.url === url)?.tags;
const reinstall = () => chrome._setLocal({});

test('encode/decode round trip, including unicode and multiple chunks', () => {
  const entries = {};
  for (let i = 0; i < 3000; i++) entries[`//site${i}.test/päge`] = { g: ['日本', 'work'], ga: i + 1, u: 5 };
  const chunks = encodeMirror(entries, 'w1');
  assert.ok(chunks.length > 1);
  const { entries: back, complete } = decodeMirror(chunks.map((c) => c.url));
  assert.ok(complete);
  assert.deepEqual(back, entries);
  assert.equal(decodeMirror(chunks.slice(1).map((c) => c.url)).complete, false, 'missing chunk detected');
});

test('mergeMeta: newest tag edit wins, last used takes the latest, cleared tags propagate', () => {
  const local = new Map([
    ['a', { id: '1', tags: ['old'], tagsAt: 10, lastUsed: 500, savedAt: null }],
    ['b', { id: '2', tags: [], tagsAt: 30, lastUsed: null, savedAt: null }],
    ['c', { id: '3', tags: [], tagsAt: 0, lastUsed: null, savedAt: null }],
  ]);
  const mirror = { a: { g: ['new'], ga: 20, u: 100 }, b: { g: ['stale'], ga: 25 }, c: { g: ['restored'], ga: 5, s: 42 } };
  const { localWrites, mirror: next } = mergeMeta(local, mirror);
  assert.deepEqual(localWrites['1'], { tags: ['new'], tagsAt: 20, lastUsed: 500, savedAt: null });
  assert.equal(localWrites['2'], undefined, 'local clear is newer; nothing to change locally');
  assert.deepEqual(next.b, { ga: 30 }, 'tag removal is recorded so other devices drop it too');
  assert.deepEqual(localWrites['3'], { tags: ['restored'], tagsAt: 5, lastUsed: null, savedAt: 42 });
});

test('tags survive removing and re-adding the extension', async () => {
  await store.addBookmark({ title: 'A', url: 'https://a.test/', tags: ['work', 'read'] });
  await store.addBookmark({ title: 'B', url: 'https://b.test/' });
  await store.markUsed((await store.loadAll()).bookmarks[1].id, 1234);
  await syncMirror();

  const tree = (await chrome.bookmarks.getTree())[0];
  const other = tree.children.find((c) => c.id === '2');
  assert.ok(other.children.some((c) => c.title === DATA_FOLDER_TITLE), 'data folder created under Other bookmarks');
  const visible = await store.loadAll();
  assert.equal(visible.bookmarks.length, 2, 'data folder is hidden from the extension');
  assert.ok(!visible.folders.some((f) => f.path.includes(DATA_FOLDER_TITLE)));

  reinstall();
  assert.deepEqual(await tagsOf('https://a.test/'), []);
  await syncMirror();
  assert.deepEqual(await tagsOf('https://a.test/'), ['work', 'read']);
  assert.equal((await store.loadAll()).bookmarks.find((b) => b.url === 'https://b.test/').lastUsed, 1234);
});

test('edits on two devices: newest wins; deletions and cleared tags propagate', async () => {
  const a = await store.addBookmark({ url: 'https://a.test/', tags: ['x'] });
  const b = await store.addBookmark({ url: 'https://b.test/', tags: ['keep'] });
  await syncMirror();
  const deviceA = chrome._getLocal();

  // "Device B": same synced bookmarks, its own extension storage.
  chrome._setLocal({});
  await syncMirror();
  await new Promise((r) => setTimeout(r, 5));
  await store.updateBookmark(a.id, { tags: ['y'] });
  await store.updateBookmark(b.id, { tags: [] });
  await syncMirror();

  chrome._setLocal(deviceA);
  await syncMirror();
  assert.deepEqual(await tagsOf('https://a.test/'), ['y']);
  assert.deepEqual(await tagsOf('https://b.test/'), []);

  // Deleting a bookmark removes its entry from the durable copy (background queues the removal).
  await store.deleteBookmarks([a.id]);
  await chrome.storage.local.set({ mirrorRemovals: ['//a.test'] });
  await syncMirror();
  chrome._setLocal({});
  await store.addBookmark({ url: 'https://a.test/' });
  await syncMirror();
  assert.deepEqual(await tagsOf('https://a.test/'), [], 'old tags not resurrected after delete');
});

test('an incomplete (still syncing) data folder is never overwritten', async () => {
  await store.addBookmark({ url: 'https://a.test/', tags: ['x'] });
  await syncMirror();
  const folder = (await chrome.bookmarks.getTree())[0].children[1].children.find((c) => c.title === DATA_FOLDER_TITLE);
  // Pretend a second chunk from another device's write hasn't arrived yet.
  await chrome.bookmarks.update(folder.children[0].id, { url: folder.children[0].url.replace(/\/0\/1#/, '/0/2#') });
  const before = (await chrome.bookmarks.getChildren(folder.id)).map((c) => c.url);
  await store.updateBookmark((await store.loadAll()).bookmarks[0].id, { tags: ['changed'] });
  await syncMirror();
  assert.deepEqual((await chrome.bookmarks.getChildren(folder.id)).map((c) => c.url), before);
});

test('mergeMeta: a manual date edit beats an older visit, but a later visit still counts', () => {
  const local = new Map([
    ['a', { id: '1', tags: [], tagsAt: 0, lastUsed: null, savedAt: 1000, datesAt: 50 }], // cleared "last used" at t=50
    ['b', { id: '2', tags: [], tagsAt: 0, lastUsed: 40, savedAt: null, datesAt: 0 }],
  ]);
  const mirror = {
    a: { u: 30, s: 5 }, // older visit from another device
    b: { u: 20, s: 7, da: 60 }, // another device set dates by hand at t=60...
  };
  const { localWrites, mirror: next } = mergeMeta(local, mirror);
  assert.equal(localWrites['1'], undefined, 'cleared last-used and edited saved date stick');
  assert.deepEqual(next.a, { s: 1000, da: 50 });
  assert.deepEqual(localWrites['2'], { tags: [], tagsAt: 0, lastUsed: 20, savedAt: 7, datesAt: 60 }, '...and wins over our older visit');

  const later = mergeMeta(new Map([['a', { id: '1', tags: [], tagsAt: 0, lastUsed: null, datesAt: 50 }]]), { a: { u: 70 } });
  assert.equal(later.localWrites['1'].lastUsed, 70, 'a visit after the manual edit wins');
});

test('edited dates survive a reinstall', async () => {
  const node = await store.addBookmark({ url: 'https://a.test/' });
  await store.markUsed(node.id, 5000);
  await syncMirror();
  await store.updateBookmark(node.id, { savedAt: 1234, lastUsed: null });
  await syncMirror();
  reinstall();
  await syncMirror();
  const b = (await store.loadAll()).bookmarks[0];
  assert.equal(b.savedAt, 1234);
  assert.equal(b.lastUsed, null);
});

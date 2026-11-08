// Exercises lib/store.js against an in-memory fake of chrome.bookmarks / chrome.storage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from './fake-chrome.js';

let store;
beforeEach(async () => {
  globalThis.chrome = fakeChrome();
  store = await import('../extension/lib/store.js');
});

test('addBookmark stores tags and blocks duplicates', async () => {
  await store.addBookmark({ title: 'Ex', url: 'https://example.com/', tags: ['Work', 'work', 'read'] });
  const { bookmarks } = await store.loadAll();
  assert.equal(bookmarks.length, 1);
  assert.deepEqual(bookmarks[0].tags, ['work', 'read']);
  assert.equal(bookmarks[0].folder, 'Other bookmarks');
  await assert.rejects(store.addBookmark({ url: 'http://www.example.com' }), store.DuplicateError);
});

test('updateBookmark renames, moves, retags, and refuses to create a duplicate', async () => {
  const a = await store.addBookmark({ title: 'A', url: 'https://a.test' });
  await store.addBookmark({ title: 'B', url: 'https://b.test' });
  await store.updateBookmark(a.id, { title: 'A2', tags: ['x'], parentId: '1' });
  let b = (await store.loadAll()).bookmarks.find((x) => x.id === a.id);
  assert.equal(b.title, 'A2');
  assert.equal(b.folder, 'Bookmarks bar');
  assert.deepEqual(b.tags, ['x']);
  await assert.rejects(store.updateBookmark(a.id, { url: 'https://b.test/' }), /Already bookmarked/);
});

test('import creates folders, keeps dates, merges tags into existing, skips in-file dups', async () => {
  const existing = await store.addBookmark({ title: 'E', url: 'https://e.test', tags: ['old'] });
  const res = await store.importRecords([
    { title: 'N1', url: 'https://n1.test', tags: ['a'], folder: 'Bookmarks bar / Dev / JS', savedAt: 1000, lastUsed: 2000 },
    { title: 'N1 again', url: 'http://n1.test/', tags: [], folder: '', savedAt: null, lastUsed: null },
    { title: 'E', url: 'https://e.test/', tags: ['new'], folder: '', savedAt: null, lastUsed: null },
    { title: 'N2', url: 'https://n2.test', tags: [], folder: 'Imported', savedAt: null, lastUsed: null },
  ]);
  assert.deepEqual({ ...res, failed: res.failed.length }, { added: 2, merged: 1, duplicates: 1, failed: 0 });
  const { bookmarks } = await store.loadAll();
  const n1 = bookmarks.find((b) => b.title === 'N1');
  assert.equal(n1.folder, 'Bookmarks bar / Dev / JS');
  assert.equal(n1.savedAt, 1000);
  assert.equal(n1.lastUsed, 2000);
  assert.equal(bookmarks.find((b) => b.title === 'N2').folder, 'Other bookmarks / Imported');
  assert.deepEqual(bookmarks.find((b) => b.id === existing.id).tags, ['old', 'new']);
  const { bulkUntil } = await chrome.storage.local.get('bulkUntil');
  assert.equal(bulkUntil, 0);
});

test('renameTag / remove tag / modifyTags / delete + restore', async () => {
  const a = await store.addBookmark({ url: 'https://a.test', tags: ['x', 'y'] });
  const b = await store.addBookmark({ url: 'https://b.test', tags: ['x'] });
  assert.equal(await store.renameTag('x', 'z'), 2);
  await store.renameTag('y', null);
  await store.modifyTags([b.id], (t) => [...t, 'q']);
  let all = (await store.loadAll()).bookmarks;
  assert.deepEqual(all.find((x) => x.id === a.id).tags, ['z']);
  assert.deepEqual(all.find((x) => x.id === b.id).tags, ['z', 'q']);

  const snap = all.map((x) => ({ parentId: x.parentId, title: x.title, url: x.url, meta: { tags: x.tags, savedAt: 5, lastUsed: 7 } }));
  await store.deleteBookmarks(all.map((x) => x.id));
  assert.equal((await store.loadAll()).bookmarks.length, 0);
  assert.deepEqual(Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('m:')), []);
  await store.restoreBookmarks(snap);
  all = (await store.loadAll()).bookmarks;
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => x.savedAt === 5 && x.lastUsed === 7));
});

test('updateBookmark edits every attribute, and dates can be reset', async () => {
  const a = await store.addBookmark({ title: 'A', url: 'https://a.test', tags: ['x'] });
  const before = (await chrome.storage.local.get('m:' + a.id))['m:' + a.id];
  await store.updateBookmark(a.id, { title: 'Renamed', url: 'https://a2.test/', tags: ['x'], parentId: '1', savedAt: 1000, lastUsed: 2000 });
  let b = (await store.loadAll()).bookmarks[0];
  assert.deepEqual(
    { title: b.title, url: b.url, tags: b.tags, folder: b.folder, savedAt: b.savedAt, lastUsed: b.lastUsed },
    { title: 'Renamed', url: 'https://a2.test/', tags: ['x'], folder: 'Bookmarks bar', savedAt: 1000, lastUsed: 2000 },
  );
  const meta = (await chrome.storage.local.get('m:' + a.id))['m:' + a.id];
  assert.equal(meta.tagsAt, before.tagsAt, 'unchanged tags are not re-stamped');
  assert.ok(meta.datesAt > 0);

  await store.updateBookmark(a.id, { savedAt: null, lastUsed: null });
  b = (await store.loadAll()).bookmarks[0];
  assert.notEqual(b.savedAt, null, 'falls back to the browser date added');
  assert.notEqual(b.savedAt, 1000);
  assert.equal(b.lastUsed, null);
});

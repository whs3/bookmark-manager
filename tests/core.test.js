import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl, coerceUrl, normalizeTags, parseQuery, matches, sortBookmarks, parseCSV, toCSV,
  parseImport, exportCSV, exportJSON, parseDate, tagCounts,
} from '../extension/lib/core.js';

const bm = (o) => ({ id: '1', title: '', url: 'https://x.test', key: '', folder: '', tags: [], savedAt: 0, lastUsed: null, ...o });

test('normalizeUrl treats trivial variants as the same bookmark', () => {
  const same = [
    'https://example.com/docs/',
    'http://example.com/docs',
    'https://www.example.com/docs?utm_source=x&utm_medium=y',
    'https://EXAMPLE.com:443/docs#',
  ];
  const keys = new Set(same.map(normalizeUrl));
  assert.equal(keys.size, 1);
  assert.notEqual(normalizeUrl('https://example.com/docs?page=2'), normalizeUrl('https://example.com/docs'));
  assert.notEqual(normalizeUrl('https://example.com/a#x'), normalizeUrl('https://example.com/a'));
  assert.notEqual(normalizeUrl('https://example.com:8080/'), normalizeUrl('https://example.com/'));
});

test('coerceUrl adds a scheme and rejects junk', () => {
  assert.equal(coerceUrl('example.com/x'), 'https://example.com/x');
  assert.equal(coerceUrl('localhost:3000'), 'https://localhost:3000');
  assert.equal(coerceUrl('http://a.b'), 'http://a.b');
  assert.equal(coerceUrl('   '), '');
  assert.equal(coerceUrl('https://exa mple.com'), '');
});

test('normalizeTags', () => {
  assert.deepEqual(normalizeTags(' Work, #reading;work | Read  Later ,'), ['work', 'reading', 'read later']);
  assert.deepEqual(normalizeTags(['A', 'a', '']), ['a']);
});

test('search matches name, url, tags and supports fields/negation', () => {
  const b = bm({ title: 'React Hooks Guide', url: 'https://react.dev/learn', folder: 'Dev / JS', tags: ['frontend', 'docs'] });
  const q = (s) => matches(b, parseQuery(s));
  assert.ok(q('hooks'));
  assert.ok(q('react.dev'));
  assert.ok(q('#front'));
  assert.ok(q('tag:docs guide'));
  assert.ok(q('folder:js'));
  assert.ok(q('"hooks guide"'));
  assert.ok(!q('vue'));
  assert.ok(!q('-#docs'));
  assert.ok(!q('title:react.dev'));
  assert.ok(q(''));
});

test('sort by last used puts most recent first and never-used last', () => {
  const list = [bm({ id: 'a', lastUsed: 100 }), bm({ id: 'b', lastUsed: null, savedAt: 5 }), bm({ id: 'c', lastUsed: 300 })];
  assert.deepEqual(sortBookmarks(list, 'lastUsed').map((b) => b.id), ['c', 'a', 'b']);
});

test('CSV round-trips quotes, commas and newlines', () => {
  const rows = [['title', 'url'], ['He said "hi", then\nleft', 'https://a.test/?q=1,2']];
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
});

test('export → import round trip (CSV and JSON)', () => {
  const list = [
    bm({ title: 'A, "quoted"', url: 'https://a.test/', folder: 'Bookmarks bar / Dev', tags: ['x', 'y'], savedAt: Date.UTC(2024, 0, 2), lastUsed: Date.UTC(2025, 5, 6) }),
    bm({ title: 'B', url: 'https://b.test/', tags: [], savedAt: Date.UTC(2023, 1, 1) }),
  ];
  for (const [text, name] of [[exportCSV(list), 'f.csv'], [exportJSON(list), 'f.json']]) {
    const { records, errors } = parseImport(text, name);
    assert.deepEqual(errors, []);
    assert.equal(records.length, 2);
    assert.equal(records[0].title, 'A, "quoted"');
    assert.deepEqual(records[0].tags, ['x', 'y']);
    assert.equal(records[0].folder, 'Bookmarks bar / Dev');
    assert.equal(records[0].savedAt, Date.UTC(2024, 0, 2));
    assert.equal(records[0].lastUsed, Date.UTC(2025, 5, 6));
    assert.equal(records[1].lastUsed, null);
  }
});

test('import tolerates other column names and reports bad rows', () => {
  const csv = 'Name,Link,Labels\nOne,https://one.test,a|b\nBad,not a url,\n';
  const { records, errors } = parseImport(csv, 'x.csv');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].tags, ['a', 'b']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Row 3/);
  assert.throws(() => parseImport('title\nfoo', 'x.csv'), /url/);
  assert.throws(() => parseImport('{"nope":1}', 'x.json'), /bookmarks/);
});

test('parseDate handles seconds, ms, microseconds and ISO', () => {
  const ms = Date.UTC(2024, 0, 1);
  assert.equal(parseDate(ms), ms);
  assert.equal(parseDate(ms / 1000), ms);
  assert.equal(parseDate(ms * 1000), ms);
  assert.equal(parseDate(String(ms)), ms);
  assert.equal(parseDate('2024-01-01T00:00:00Z'), ms);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('garbage'), null);
});

test('tagCounts', () => {
  assert.deepEqual(tagCounts([bm({ tags: ['b', 'a'] }), bm({ tags: ['a'] })]), [['a', 2], ['b', 1]]);
});

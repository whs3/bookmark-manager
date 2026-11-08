import {
  parseQuery, matches, sortBookmarks, SORTS, formatRelative, formatDate, normalizeTags, tagCounts,
  parseImport, exportJSON, exportCSV, coerceUrl,
} from './lib/core.js';
import * as store from './lib/store.js';
import { checkLinks } from './lib/linkcheck.js';
import { h, fill, favicon, toast, download } from './lib/dom.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  search: $('#search'), sort: $('#sort'), list: $('#list'), tags: $('#tags'), status: $('#status'),
  empty: $('#empty'), bulk: $('#bulkbar'), bulkCount: $('#bulk-count'), file: $('#file'),
  banner: $('#banner'), selectAll: $('#select-all'),
};

const UNTAGGED = Symbol('untagged');
const SORT_ORDER = Object.keys(SORTS);

const state = {
  all: [], folders: [], view: [], byId: new Map(),
  clauses: [], tag: null, sort: 'lastUsed', cursor: 0, selected: new Set(),
  settings: {}, undo: null, busy: false,
};

// =====================================================================
// Data
// =====================================================================

async function reload(keepId = state.view[state.cursor]?.id) {
  const { bookmarks, folders } = await store.loadAll();
  state.all = bookmarks;
  state.folders = folders;
  state.byId = new Map(bookmarks.map((b) => [b.id, b]));
  for (const id of state.selected) if (!state.byId.has(id)) state.selected.delete(id);
  if (typeof state.tag === 'string' && !bookmarks.some((b) => b.tags.includes(state.tag))) state.tag = null;
  applyView(keepId);
}

let reloadTimer;
function scheduleReload() {
  if (state.busy) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload(), 200);
}

function applyView(keepId) {
  let v = state.all;
  if (state.tag === UNTAGGED) v = v.filter((b) => !b.tags.length);
  else if (state.tag) v = v.filter((b) => b.tags.includes(state.tag));
  if (state.clauses.length) v = v.filter((b) => matches(b, state.clauses));
  state.view = sortBookmarks(v, state.sort);
  const i = keepId ? state.view.findIndex((b) => b.id === keepId) : -1;
  state.cursor = i >= 0 ? i : Math.max(0, Math.min(state.cursor, state.view.length - 1));
  render();
}

const current = () => state.view[state.cursor];
const selectedItems = () => state.view.filter((b) => state.selected.has(b.id));
/** What an action applies to: the selection if any, else the cursor row. */
const targets = () => (state.selected.size ? [...state.selected].map((id) => state.byId.get(id)).filter(Boolean) : current() ? [current()] : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// =====================================================================
// Rendering
// =====================================================================

function render() {
  renderTags();
  renderList();
  renderChrome();
}

function renderTags() {
  const counts = tagCounts(state.all);
  const untagged = state.all.filter((b) => !b.tags.length).length;
  const item = (label, value, count, actions) =>
    h('div', { class: 'tagitem' + (state.tag === value ? ' active' : '') },
      h('button', { class: 'tagbtn', onclick: () => setTag(value), title: label }, h('span', { class: 'name' }, label), h('span', { class: 'count' }, count)),
      actions);
  fill(
    els.tags,
    h('div', { class: 'side-title' }, 'Groups'),
    item('All bookmarks', null, state.all.length),
    item('Untagged', UNTAGGED, untagged),
    h('div', { class: 'side-title' }, 'Tags'),
    counts.map(([t, n]) =>
      item('#' + t, t, n, h('span', { class: 'tagactions' },
        h('button', { title: `Rename #${t}`, 'aria-label': `Rename tag ${t}`, onclick: () => renameTag(t) }, '✎'),
        h('button', { title: `Remove #${t} from all bookmarks`, 'aria-label': `Delete tag ${t}`, onclick: () => deleteTag(t) }, '×')))),
    counts.length ? null : h('p', { class: 'hint' }, 'No tags yet. Select bookmarks and press T to tag them.'),
  );
}

function rowFor(b, i) {
  const sel = state.selected.has(b.id);
  const openLink = (e) => {
    e.preventDefault();
    if (e.type === 'auxclick' && e.button !== 1) return;
    setCursor(i, false);
    store.openBookmark(b, e.type === 'auxclick' || e.ctrlKey || e.metaKey || e.shiftKey ? 'background' : 'new');
  };
  const row = h('div', { class: 'row', role: 'option', id: 'row-' + b.id, 'aria-selected': String(sel) },
    h('input', { type: 'checkbox', checked: sel, tabindex: '-1', 'aria-label': 'Select', onchange: (e) => setSelected(b.id, e.target.checked) }),
    h('div', { class: 'main' },
      favicon(b.url),
      h('div', { class: 'text' },
        h('a', { class: 'title', href: b.url, tabindex: '-1', onclick: openLink, onauxclick: openLink }, b.title || b.url),
        h('div', { class: 'url', title: b.url }, b.url))),
    h('div', { class: 'tags' }, b.tags.map((t) => h('button', { class: 'chip', tabindex: '-1', title: `Show #${t}`, onclick: () => setTag(t) }, t))),
    h('div', { class: 'folder', title: b.folder }, b.folder),
    h('div', { class: 'date saved', title: 'Saved ' + formatDate(b.savedAt) }, formatRelative(b.savedAt)),
    h('div', { class: 'date', title: b.lastUsed ? 'Last used ' + formatDate(b.lastUsed) : 'Never opened' }, b.lastUsed ? formatRelative(b.lastUsed) : '—'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'icon-btn', tabindex: '-1', title: 'Edit name, URL, tags, folder and dates (E)', 'aria-label': `Edit ${b.title || b.url}`, onclick: () => { setCursor(i, false); openEditor(b); } }, '✎')),
  );
  row.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input')) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) setSelected(b.id, !state.selected.has(b.id));
    setCursor(i, false);
  });
  row.addEventListener('dblclick', (e) => {
    if (!e.target.closest('a, button, input')) openEditor(b);
  });
  return row;
}

function renderList() {
  const frag = document.createDocumentFragment();
  state.view.forEach((b, i) => frag.append(rowFor(b, i)));
  els.list.replaceChildren(frag);
  els.empty.hidden = state.view.length > 0;
  els.empty.textContent = state.all.length ? 'No bookmarks match this search.' : 'No bookmarks yet — press N to add one or I to import.';
  highlight(false);
}

function renderChrome() {
  const n = state.selected.size;
  els.bulk.hidden = n === 0;
  els.bulkCount.textContent = `${n} selected`;
  const visibleSel = selectedItems().length;
  els.selectAll.checked = visibleSel > 0 && visibleSel === state.view.length;
  els.selectAll.indeterminate = visibleSel > 0 && visibleSel < state.view.length;

  els.sort.value = state.sort;
  document.querySelectorAll('.list-head [data-sort]').forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sort));

  const filter = state.tag === UNTAGGED ? 'untagged' : state.tag ? `#${state.tag}` : '';
  const parts = [`${state.view.length === state.all.length ? '' : `${state.view.length} of `}${plural(state.all.length, 'bookmark')}`];
  if (filter) parts.push(`group ${filter}`);
  if (state.clauses.length) parts.push(`matching “${els.search.value.trim()}”`);
  parts.push(`sorted by ${SORTS[state.sort].label.toLowerCase()}`);
  if (n) parts.push(`${n} selected`);
  els.status.textContent = parts.join(' · ');

  els.banner.hidden = !(state.all.length && !state.settings.historyBannerDismissed && !state.all.some((b) => b.lastUsed));
}

function highlight(scroll = true) {
  els.list.querySelector('.row.cursor')?.classList.remove('cursor');
  const row = els.list.children[state.cursor];
  if (!row) return els.list.removeAttribute('aria-activedescendant');
  row.classList.add('cursor');
  els.list.setAttribute('aria-activedescendant', row.id);
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

function setCursor(i, scroll = true) {
  if (!state.view.length) return;
  state.cursor = Math.max(0, Math.min(state.view.length - 1, i));
  highlight(scroll);
}
const move = (d) => setCursor(state.cursor + d);
const pageSize = () => Math.max(1, Math.floor(els.list.clientHeight / (els.list.firstElementChild?.offsetHeight || 44)) - 1);

function setSelected(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  const row = document.getElementById('row-' + id);
  if (row) {
    row.setAttribute('aria-selected', String(on));
    row.querySelector('input[type=checkbox]').checked = on;
  }
  renderChrome();
}

function selectAllVisible(on = true) {
  for (const b of state.view) setSelected(b.id, on);
}

function clearSelection() {
  for (const id of [...state.selected]) setSelected(id, false);
}

// =====================================================================
// Filtering & sorting
// =====================================================================

// Changing the search or tag group starts a fresh selection, so bulk actions
// only ever apply to bookmarks you can see.
function onSearch() {
  const clauses = parseQuery(els.search.value);
  if (JSON.stringify(clauses) === JSON.stringify(state.clauses)) return;
  state.clauses = clauses;
  state.selected.clear();
  state.cursor = 0;
  applyView(null);
}

function setTag(value) {
  state.tag = state.tag === value && value !== null ? null : value;
  state.selected.clear();
  state.cursor = 0;
  applyView(null);
}

function cycleTag(dir) {
  const groups = [null, UNTAGGED, ...tagCounts(state.all).map(([t]) => t)];
  const i = groups.indexOf(state.tag);
  state.tag = groups[(i + dir + groups.length) % groups.length];
  state.selected.clear();
  state.cursor = 0;
  applyView(null);
}

async function setSort(key) {
  state.sort = key;
  applyView(current()?.id);
  state.settings = await store.saveSettings({ sort: key });
}
const cycleSort = () => setSort(SORT_ORDER[(SORT_ORDER.indexOf(state.sort) + 1) % SORT_ORDER.length]);

// =====================================================================
// Dialog helpers
// =====================================================================

const anyDialogOpen = () => !!document.querySelector('dialog[open]');

/** Confirm (returns true/null) or prompt (input: initial value → returns string/null). */
function ask({ title, message = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const dlg = $('#ask');
  const form = $('#ask-form');
  const inp = $('#ask-input');
  const okBtn = $('#ask-ok');
  const cancelBtn = $('#ask-cancel');
  $('#ask-title').textContent = title;
  $('#ask-msg').textContent = message;
  $('#ask-msg').hidden = !message;
  inp.hidden = input === null;
  inp.value = input ?? '';
  okBtn.textContent = ok;
  okBtn.className = danger ? 'primary danger-bg' : 'primary';
  cancelBtn.hidden = cancel === null;
  cancelBtn.textContent = cancel ?? '';
  return new Promise((resolve) => {
    const done = (v) => {
      form.onsubmit = cancelBtn.onclick = dlg.oncancel = null;
      dlg.close();
      resolve(v);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      done(input !== null ? inp.value : true);
    };
    cancelBtn.onclick = () => done(null);
    dlg.oncancel = (e) => {
      e.preventDefault();
      done(null);
    };
    dlg.showModal();
    if (input !== null) {
      inp.focus();
      inp.select();
    } else okBtn.focus();
  });
}

const info = (title, message) => ask({ title, message, cancel: null });

// =====================================================================
// Add / edit
// =====================================================================

const editDlg = $('#edit');
const editForm = $('#edit-form');
const F = editForm.elements;
let editing = null;
let suggestions = [];

function defaultFolderId() {
  const roots = state.folders.filter((f) => f.depth === 0);
  return store.defaultRoot(roots.length ? roots : state.folders)?.id;
}

/** ms → "YYYY-MM-DDTHH:MM" in local time, the format <input type="datetime-local"> uses. */
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function openEditor(b, focusField = 'title') {
  editing = b;
  $('#edit-heading').textContent = b ? 'Edit bookmark' : 'New bookmark';
  F.title.value = b?.title ?? '';
  F.url.value = b?.url ?? '';
  const presetTags = b ? b.tags : typeof state.tag === 'string' ? [state.tag] : [];
  F.tags.value = presetTags.length ? presetTags.join(', ') + ', ' : '';
  F.folder.replaceChildren(...state.folders.map((f) => h('option', { value: f.id }, ' '.repeat(f.depth) + f.path.split(' / ').pop())));
  F.folder.value = b?.parentId ?? defaultFolderId();
  // Dates only make sense for an existing bookmark (a new one is saved "now").
  $('#edit-dates').hidden = $('#edit-meta').hidden = !b;
  F.savedAt.value = toLocalInput(b?.savedAt);
  F.lastUsed.value = toLocalInput(b?.lastUsed);
  $('#edit-error').replaceChildren();
  updateSuggest();
  editDlg.showModal();
  const input = F[b ? focusField : 'url'];
  input.focus();
  if (focusField === 'tags') input.setSelectionRange(input.value.length, input.value.length);
  else input.select();
}

function editorError(msg, existing) {
  fill(
    $('#edit-error'),
    msg,
    existing ? ' ' : null,
    existing ? h('button', { type: 'button', class: 'link', onclick: () => { editDlg.close(); jumpTo(existing.id); openEditor(state.byId.get(existing.id) ?? existing); } }, 'Edit that one') : null,
  );
}

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = coerceUrl(F.url.value);
  if (!url) return editorError('Enter a valid URL.');
  const data = { title: F.title.value.trim() || url, url, tags: normalizeTags(F.tags.value), parentId: F.folder.value };
  if (editing) {
    // Only send dates the user actually changed (inputs have minute precision).
    for (const field of ['savedAt', 'lastUsed']) {
      if (F[field].value === toLocalInput(editing[field])) continue;
      const ms = F[field].value ? new Date(F[field].value).getTime() : null;
      if (Number.isNaN(ms)) return editorError('Enter a valid date.');
      if (ms > Date.now() + 60_000) return editorError(`“${field === 'savedAt' ? 'Saved' : 'Last used'}” can’t be in the future.`);
      data[field] = ms;
    }
  }
  try {
    let id = editing?.id;
    if (editing) await store.updateBookmark(editing.id, data);
    else id = (await store.addBookmark(data)).id;
    editDlg.close();
    toast(editing ? 'Saved' : 'Bookmark added');
    await reload(id);
    highlight();
  } catch (err) {
    editorError(err.message, err instanceof store.DuplicateError ? err.existing : null);
  }
});
$('#edit-cancel').addEventListener('click', () => editDlg.close());

// Tag autocomplete in the editor
function tagFragment() {
  const parts = F.tags.value.split(/[,;]/);
  return { parts, frag: parts.at(-1).trim().replace(/^#/, '').toLowerCase() };
}
function updateSuggest() {
  const { parts, frag } = tagFragment();
  const have = new Set(normalizeTags(parts.slice(0, -1)));
  suggestions = tagCounts(state.all)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter((t) => !have.has(t) && t !== frag && (!frag || t.includes(frag)))
    .sort((a, b) => (frag ? b.startsWith(frag) - a.startsWith(frag) : 0))
    .slice(0, 12);
  $('#tag-suggest').replaceChildren(...suggestions.map((t) => h('button', { type: 'button', class: 'chip', tabindex: '-1', onclick: () => acceptSuggestion(t) }, '+ ' + t)));
}
function acceptSuggestion(t) {
  const { parts } = tagFragment();
  parts[parts.length - 1] = t;
  F.tags.value = normalizeTags(parts).join(', ') + ', ';
  F.tags.focus();
  updateSuggest();
}
F.tags.addEventListener('input', updateSuggest);
F.tags.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && tagFragment().frag && suggestions.length) {
    e.preventDefault();
    acceptSuggestion(suggestions[0]);
  }
});

function jumpTo(id) {
  if (!state.view.some((b) => b.id === id)) {
    state.tag = null;
    els.search.value = '';
    state.clauses = [];
    state.selected.clear();
  }
  applyView(id);
  highlight();
}

// =====================================================================
// Delete & undo
// =====================================================================

async function deleteItems(items) {
  if (!items.length) return;
  if (items.length > 1) {
    const ok = await ask({ title: `Delete ${plural(items.length, 'bookmark')}?`, message: 'You can undo this right afterwards with Ctrl+Z.', ok: 'Delete', danger: true });
    if (!ok) return;
  }
  const snapshot = items.map((b) => ({ parentId: b.parentId, index: b.index, title: b.title, url: b.url, meta: { tags: b.tags, savedAt: b.savedAt, lastUsed: b.lastUsed } }));
  state.busy = true;
  try {
    await store.deleteBookmarks(items.map((b) => b.id));
  } finally {
    state.busy = false;
  }
  items.forEach((b) => state.selected.delete(b.id));
  await reload(state.view[state.cursor + 1]?.id ?? state.view[state.cursor - 1]?.id);
  state.undo = async () => {
    state.undo = null;
    await store.restoreBookmarks(snapshot);
    await reload();
    toast(`Restored ${plural(snapshot.length, 'bookmark')}`);
  };
  toast(`Deleted ${items.length === 1 ? `“${items[0].title}”` : plural(items.length, 'bookmark')}`, { action: 'Undo', onAction: () => state.undo?.(), timeout: 8000 });
}

// =====================================================================
// Tags
// =====================================================================

async function addTagsTo(items) {
  if (!items.length) return;
  const v = await ask({ title: `Add tags to ${plural(items.length, 'bookmark')}`, message: 'Comma separated, e.g. work, read later', input: typeof state.tag === 'string' ? state.tag : '', ok: 'Add' });
  const tags = normalizeTags(v ?? '');
  if (!tags.length) return;
  await store.modifyTags(items.map((b) => b.id), (cur) => [...cur, ...tags]);
  toast(`Tagged ${plural(items.length, 'bookmark')} with ${tags.map((t) => '#' + t).join(' ')}`);
}

async function removeTagFrom(items) {
  if (!items.length) return;
  const present = [...new Set(items.flatMap((b) => b.tags))];
  if (!present.length) return info('No tags', 'The selected bookmarks have no tags.');
  const v = await ask({ title: `Remove a tag from ${plural(items.length, 'bookmark')}`, message: `Tags on these: ${present.join(', ')}`, input: typeof state.tag === 'string' ? state.tag : present[0], ok: 'Remove' });
  const tags = normalizeTags(v ?? '');
  if (!tags.length) return;
  await store.modifyTags(items.map((b) => b.id), (cur) => cur.filter((t) => !tags.includes(t)));
}

function tagAction() {
  if (state.selected.size) addTagsTo(targets());
  else if (current()) openEditor(current(), 'tags');
}

async function renameTag(t) {
  const v = await ask({ title: `Rename tag #${t}`, input: t, ok: 'Rename' });
  const to = normalizeTags(v ?? '')[0];
  if (!to || to === t) return;
  const n = await store.renameTag(t, to);
  if (state.tag === t) state.tag = to;
  toast(`Renamed #${t} to #${to} on ${plural(n, 'bookmark')}`);
}

async function deleteTag(t) {
  const n = state.all.filter((b) => b.tags.includes(t)).length;
  if (!(await ask({ title: `Remove tag #${t}?`, message: `It will be removed from ${plural(n, 'bookmark')}. The bookmarks themselves are kept.`, ok: 'Remove tag', danger: true }))) return;
  await store.renameTag(t, null);
  if (state.tag === t) state.tag = null;
}

// =====================================================================
// Import / export
// =====================================================================

els.file.addEventListener('change', async () => {
  const file = els.file.files[0];
  els.file.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = parseImport(await file.text(), file.name);
  } catch (e) {
    return info('Import failed', e.message);
  }
  const { records, errors } = parsed;
  const errText = errors.length ? `\n\n${plural(errors.length, 'row')} will be skipped:\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? '\n…' : ''}` : '';
  if (!records.length) return info('Nothing to import', `No valid bookmarks found in ${file.name}.${errText}`);
  const rootName = state.folders.find((f) => f.id === defaultFolderId())?.path ?? 'Other bookmarks';
  const ok = await ask({
    title: `Import ${plural(records.length, 'bookmark')}?`,
    message: `From ${file.name}. URLs you already have are not duplicated — their tags are merged instead. Missing folders are created; entries without a folder go to “${rootName}”.${errText}`,
    ok: 'Import',
  });
  if (!ok) return;
  state.busy = true;
  let res;
  try {
    res = await store.importRecords(records, (i, n) => (els.status.textContent = `Importing ${i} / ${n}…`));
  } finally {
    state.busy = false;
  }
  await reload();
  const failed = res.failed.length ? `\n\n${res.failed.length} failed:\n${res.failed.slice(0, 5).join('\n')}` : '';
  info('Import complete', `${plural(res.added, 'bookmark')} added\n${res.merged} existing bookmarks got new tags\n${plural(res.duplicates, 'duplicate')} skipped${failed}`);
});

function openExport() {
  const n = state.view.length;
  $('#export-all').textContent = `All bookmarks (${state.all.length})`;
  $('#export-view').textContent = `Only what’s shown now (${n})`;
  $('#export-form').elements.scope.value = n < state.all.length ? 'view' : 'all';
  $('#export').showModal();
}
$('#export-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const list = f.scope.value === 'view' ? state.view : sortBookmarks(state.all, 'title');
  const stamp = new Date().toISOString().slice(0, 10);
  if (f.format.value === 'csv') download(`bookmarks-${stamp}.csv`, exportCSV(list), 'text/csv;charset=utf-8');
  else download(`bookmarks-${stamp}.json`, exportJSON(list), 'application/json');
  $('#export').close();
  toast(`Exported ${plural(list.length, 'bookmark')}`);
});
$('#export-cancel').addEventListener('click', () => $('#export').close());

// =====================================================================
// Broken link checker
// =====================================================================

let checkAbort = null;

function runCheck() {
  const list = state.view.filter((b) => /^https?:/i.test(b.url));
  if (!list.length) return toast('No web bookmarks to check here.');
  // Must be called straight from the click/keypress (user gesture).
  chrome.permissions.request({ origins: ['<all_urls>'] }).then(
    (granted) => (granted ? startCheck(list) : info('Permission needed', 'Checking links needs permission to contact the bookmarked websites. Nothing is sent except a normal request for each page.')),
    (e) => info('Permission error', e.message),
  );
}

async function startCheck(list) {
  const dlg = $('#check');
  const status = $('#check-status');
  const progress = $('#check-progress');
  const results = $('#check-results');
  const stopBtn = $('#check-stop');
  results.replaceChildren();
  progress.value = 0;
  progress.max = list.length;
  progress.hidden = false;
  stopBtn.hidden = false;
  const scope = list.length === state.all.length ? 'all' : 'the shown';
  status.textContent = `Checking ${scope} ${plural(list.length, 'bookmark')}…`;
  dlg.showModal();

  checkAbort = new AbortController();
  let broken = 0;
  let warn = 0;
  let checked = 0;
  await checkLinks(list, {
    signal: checkAbort.signal,
    onResult: (r, done, total) => {
      checked = done;
      progress.value = done;
      if (r.status === 'broken') broken++;
      if (r.status === 'warn') warn++;
      status.textContent = `Checked ${done} of ${total} · ${broken} broken · ${warn} to check`;
      if (r.status === 'ok') return;
      results.append(
        h('label', { class: 'check-row', dataset: { id: r.bm.id } },
          h('input', { type: 'checkbox', checked: r.status === 'broken' }),
          h('span', { class: 't' }, h('div', {}, r.bm.title || r.bm.url), h('div', { class: 'u', title: r.bm.url }, r.bm.url)),
          h('span', { class: `badge ${r.status}`, title: r.reason }, `${r.status === 'broken' ? 'Broken' : 'Check'} · ${r.reason}`)),
      );
    },
  });
  const stopped = checkAbort.signal.aborted;
  checkAbort = null;
  stopBtn.hidden = true;
  progress.hidden = true;
  status.textContent = `${stopped ? 'Stopped after' : 'Done:'} ${plural(checked, 'bookmark')} checked · ${broken} broken · ${warn} to check.` + (broken + warn ? ' Review the list, then delete or tag the selected ones.' : ' Everything works. 🎉');
}

const checkedIds = () => [...$('#check-results').querySelectorAll('.check-row')].filter((r) => r.querySelector('input').checked).map((r) => r.dataset.id);

$('#check-stop').addEventListener('click', () => checkAbort?.abort());
$('#check').addEventListener('close', () => checkAbort?.abort());
$('#check-close').addEventListener('click', () => $('#check').close());
$('#check-delete').addEventListener('click', async () => {
  const items = checkedIds().map((id) => state.byId.get(id)).filter(Boolean);
  if (!items.length) return toast('Select bookmarks to delete first.');
  $('#check').close();
  await deleteItems(items);
});
$('#check-tag').addEventListener('click', async () => {
  const ids = checkedIds();
  if (!ids.length) return toast('Select bookmarks to tag first.');
  await store.modifyTags(ids, (cur) => [...cur, 'broken']);
  $('#check').close();
  toast(`Tagged ${plural(ids.length, 'bookmark')} #broken — press ] to browse groups`);
});

// =====================================================================
// History seeding, help, settings
// =====================================================================

function fillFromHistory() {
  chrome.permissions.request({ permissions: ['history'] }).then(async (granted) => {
    if (!granted) return;
    const n = await store.seedLastUsedFromHistory();
    state.settings = await store.saveSettings({ historyBannerDismissed: true });
    toast(`Filled “last used” for ${plural(n, 'bookmark')} from your history`);
  }, (e) => info('Permission error', e.message));
}

const COMMAND_LABELS = { _execute_action: 'Search popup', _execute_browser_action: 'Search popup', 'open-manager': 'Open this manager', 'quick-add': 'Bookmark current page' };

/** Show the browser-wide shortcuts as actually assigned (the browser may skip ones that clash). */
async function renderGlobalShortcuts() {
  const commands = await chrome.commands.getAll();
  fill(
    $('#global-shortcuts'),
    commands
      .filter((c) => COMMAND_LABELS[c.name])
      .map((c) => [
        h('dt', {}, c.shortcut ? c.shortcut.split('+').map((k, i) => [i ? '+' : null, h('kbd', {}, k)]) : h('span', { class: 'error' }, 'Not set')),
        h('dd', {}, COMMAND_LABELS[c.name]),
      ]),
  );
}

function openHelp() {
  renderGlobalShortcuts();
  $('#set-dupes').checked = state.settings.blockDuplicates;
  $('#help').showModal();
  $('#help-close').focus();
}

$('#set-dupes').addEventListener('change', async (e) => {
  state.settings = await store.saveSettings({ blockDuplicates: e.target.checked });
});
$('#help-close').addEventListener('click', () => $('#help').close());
$('#help-history').addEventListener('click', fillFromHistory);
$('#help-shortcuts').addEventListener('click', () => {
  const firefox = navigator.userAgent.includes('Firefox');
  if (firefox) info('Change shortcuts', 'Open about:addons, click the gear icon and choose “Manage Extension Shortcuts”.');
  else chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('#banner-fill').addEventListener('click', fillFromHistory);
$('#banner-dismiss').addEventListener('click', async () => {
  state.settings = await store.saveSettings({ historyBannerDismissed: true });
  renderChrome();
});

// =====================================================================
// Toolbar & bulk bar wiring
// =====================================================================

els.search.addEventListener('input', onSearch);
els.sort.addEventListener('change', () => setSort(els.sort.value));
document.querySelectorAll('.list-head [data-sort]').forEach((b) => b.addEventListener('click', () => setSort(b.dataset.sort)));
els.selectAll.addEventListener('change', (e) => selectAllVisible(e.target.checked));
$('#btn-add').addEventListener('click', () => openEditor(null));
$('#btn-import').addEventListener('click', () => els.file.click());
$('#btn-export').addEventListener('click', openExport);
$('#btn-check').addEventListener('click', runCheck);
$('#btn-help').addEventListener('click', openHelp);
$('#bulk-tag').addEventListener('click', () => addTagsTo(targets()));
$('#bulk-untag').addEventListener('click', () => removeTagFrom(targets()));
$('#bulk-delete').addEventListener('click', () => deleteItems(targets()));
$('#bulk-clear').addEventListener('click', clearSelection);

// =====================================================================
// Keyboard
// =====================================================================

function openCurrent(e) {
  const b = current();
  if (b) store.openBookmark(b, e.shiftKey ? 'background' : 'new');
}

function onEscape() {
  if (state.selected.size) clearSelection();
  else if (state.tag !== null) setTag(null);
  else if (els.search.value) {
    els.search.value = '';
    onSearch();
  }
}

async function copyUrl() {
  const b = current();
  if (!b) return;
  await navigator.clipboard.writeText(b.url);
  toast('URL copied');
}

const withCurrent = (fn) => () => current() && fn(current());

const KEYS = {
  '/': () => { els.search.focus(); els.search.select(); },
  ArrowDown: () => move(1), j: () => move(1),
  ArrowUp: () => move(-1), k: () => move(-1),
  PageDown: () => move(pageSize()), PageUp: () => move(-pageSize()),
  Home: () => setCursor(0), End: () => setCursor(state.view.length - 1),
  Enter: openCurrent,
  e: withCurrent((b) => openEditor(b, 'title')),
  F2: withCurrent((b) => openEditor(b, 'title')),
  t: tagAction,
  c: copyUrl,
  x: withCurrent((b) => setSelected(b.id, !state.selected.has(b.id))),
  ' ': withCurrent((b) => setSelected(b.id, !state.selected.has(b.id))),
  Delete: () => deleteItems(targets()),
  Backspace: () => deleteItems(targets()),
  Escape: onEscape,
  s: cycleSort,
  n: () => openEditor(null),
  i: () => els.file.click(),
  o: openExport,
  b: runCheck,
  '[': () => cycleTag(-1),
  ']': () => cycleTag(1),
  '?': openHelp,
};

document.addEventListener('keydown', (e) => {
  if (anyDialogOpen() || e.altKey || e.isComposing) return;
  const t = e.target;
  const mod = e.ctrlKey || e.metaKey;

  if (t === els.search) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      KEYS[e.key]();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openCurrent(e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (els.search.value) {
        els.search.value = '';
        onSearch();
      } else els.list.focus();
    }
    return;
  }
  if (t.matches('input:not([type=checkbox]), select, textarea')) return;
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('button, a')) return;

  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'a') { e.preventDefault(); selectAllVisible(true); }
    else if (k === 'f') { e.preventDefault(); KEYS['/'](); }
    else if (k === 'z' && state.undo) { e.preventDefault(); state.undo(); }
    return;
  }
  const fn = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (fn) {
    e.preventDefault();
    fn(e);
  }
});

// =====================================================================
// Live sync with changes made elsewhere (browser UI, popup, other tabs)
// =====================================================================

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) chrome.bookmarks[ev]?.addListener(scheduleReload);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) state.settings = { ...state.settings, ...changes.settings.newValue };
  if (Object.keys(changes).some((k) => k.startsWith(store.META_PREFIX))) scheduleReload();
  else if (changes.settings) renderChrome();
});

// =====================================================================
// Start
// =====================================================================

(async () => {
  state.settings = await store.getSettings();
  state.sort = SORTS[state.settings.sort] ? state.settings.sort : 'lastUsed';
  await reload();
  const editId = new URLSearchParams(location.search).get('edit');
  if (editId && state.byId.has(editId)) {
    history.replaceState(null, '', location.pathname);
    jumpTo(editId);
    openEditor(state.byId.get(editId));
  } else {
    els.search.focus();
  }
})();

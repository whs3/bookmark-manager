import { parseQuery, matches, sortBookmarks, formatRelative, normalizeUrl, normalizeTags } from './lib/core.js';
import * as store from './lib/store.js';
import { h, favicon } from './lib/dom.js';

const MAX_RESULTS = 80;
const $search = document.getElementById('search');
const $results = document.getElementById('results');
const $current = document.getElementById('current');
const $empty = document.getElementById('empty');

let all = [];
let view = [];
let cursor = 0;
let tab = null;
let adding = false;

const isBookmarkable = (url) => /^(https?|file|ftp):/i.test(url || '');
const currentBookmark = () => (tab && all.find((b) => b.key === normalizeUrl(tab.url))) || null;

async function init() {
  const [[activeTab], data] = await Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), store.loadAll()]);
  tab = activeTab;
  all = data.bookmarks;
  renderCurrent();
  update();
  $search.focus();
}

// ----- Current page: "bookmark this page" -----

function renderCurrent() {
  adding = false;
  if (!tab || !isBookmarkable(tab.url)) {
    $current.hidden = true;
    return;
  }
  const existing = currentBookmark();
  if (existing) {
    const tags = existing.tags.map((t) => '#' + t).join(' ');
    $current.replaceChildren(
      h('span', { class: 'star on', 'aria-hidden': 'true' }, '★'),
      h('span', { class: 'cur-text', title: existing.folder }, 'Saved', tags && ` · ${tags}`, existing.folder && ` · ${existing.folder}`),
      h('button', { onclick: () => editInManager(existing), title: 'Edit name, URL, tags, folder and dates' }, 'Edit'),
    );
  } else {
    $current.replaceChildren(
      h('button', { class: 'addbtn', onclick: showAddForm }, h('span', {}, '☆  Bookmark this page'), h('kbd', {}, 'Alt+A')),
    );
  }
}

function showAddForm() {
  const existing = currentBookmark();
  if (existing) return editInManager(existing);
  if (!tab || !isBookmarkable(tab.url)) return;
  adding = true;
  const msg = h('p', { class: 'msg muted' }, 'Enter to save · Esc to cancel');
  const title = h('input', { name: 'title', value: tab.title || tab.url, 'aria-label': 'Name' });
  const tags = h('input', { name: 'tags', placeholder: 'Tags, comma separated', 'aria-label': 'Tags', autocomplete: 'off' });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await store.addBookmark({ title: title.value.trim(), url: tab.url, tags: normalizeTags(tags.value) });
          all = (await store.loadAll()).bookmarks;
          renderCurrent();
          update();
          $search.focus();
        } catch (err) {
          msg.className = 'msg error';
          msg.textContent = err.message;
        }
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          renderCurrent();
          $search.focus();
        }
      },
    },
    title,
    tags,
    h('button', { class: 'primary' }, 'Save'),
    msg,
  );
  $current.replaceChildren(h('span', { class: 'star', 'aria-hidden': 'true' }, '☆'), form);
  tags.focus();
}

function editInManager(b) {
  store.openManager(`edit=${encodeURIComponent(b.id)}`);
  window.close();
}

// ----- Search results -----

function update() {
  const clauses = parseQuery($search.value);
  view = sortBookmarks(clauses.length ? all.filter((b) => matches(b, clauses)) : all, 'lastUsed');
  cursor = 0;
  renderList();
}

function renderList() {
  const shown = view.slice(0, MAX_RESULTS);
  $results.replaceChildren(
    ...shown.map((b, i) =>
      h(
        'div',
        {
          class: 'item' + (i === cursor ? ' cursor' : ''),
          role: 'option',
          id: 'r' + i,
          title: b.url,
          onclick: (e) => open(b, e.shiftKey ? 'current' : e.ctrlKey || e.metaKey ? 'background' : 'new'),
          onauxclick: (e) => e.button === 1 && open(b, 'background'),
        },
        favicon(b.url),
        h('span', { class: 'title' }, b.title || b.url),
        h('span', { class: 'used', title: 'Last used' }, b.lastUsed ? formatRelative(b.lastUsed) : ''),
        h('div', { class: 'sub' }, h('span', { class: 'url' }, b.url.replace(/^https?:\/\/(www\.)?/, '')), b.tags.slice(0, 3).map((t) => h('span', { class: 'chip' }, t))),
        h('button', {
          class: 'edit',
          tabindex: '-1',
          title: 'Edit (Alt+E)',
          'aria-label': `Edit ${b.title || b.url}`,
          onclick: (e) => {
            e.stopPropagation();
            editInManager(b);
          },
        }, '✎'),
      ),
    ),
  );
  $empty.hidden = view.length > 0;
  $empty.textContent = all.length ? 'No bookmarks match.' : 'No bookmarks yet.';
  if (view.length > MAX_RESULTS) $results.append(h('p', { class: 'empty' }, `${view.length - MAX_RESULTS} more — refine your search or open the manager.`));
  moveCursor(0);
}

function moveCursor(delta) {
  const n = Math.min(view.length, MAX_RESULTS);
  if (!n) return;
  $results.querySelector('.item.cursor')?.classList.remove('cursor');
  cursor = Math.max(0, Math.min(n - 1, cursor + delta));
  const el = document.getElementById('r' + cursor);
  el.classList.add('cursor');
  el.scrollIntoView({ block: 'nearest' });
  $search.setAttribute('aria-activedescendant', el.id);
}

async function open(b, mode) {
  await store.openBookmark(b, mode);
  if (mode !== 'background') window.close();
}

$search.addEventListener('input', update);

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (key === 'a') {
      e.preventDefault();
      showAddForm();
    } else if (key === 'm') {
      e.preventDefault();
      store.openManager();
      window.close();
    } else if (key === 'e' && view[cursor]) {
      e.preventDefault();
      editInManager(view[cursor]);
    }
    return;
  }
  if (adding && e.target !== $search) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'ArrowDown' || (ctrl && (key === 'n' || key === 'j'))) {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === 'ArrowUp' || (ctrl && (key === 'p' || key === 'k'))) {
    e.preventDefault();
    moveCursor(-1);
  } else if (e.key === 'PageDown') {
    e.preventDefault();
    moveCursor(8);
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    moveCursor(-8);
  } else if (e.key === 'Enter' && view[cursor]) {
    e.preventDefault();
    open(view[cursor], e.shiftKey ? 'current' : ctrl ? 'background' : 'new');
  } else if (e.key === 'Escape' && $search.value) {
    e.preventDefault();
    $search.value = '';
    update();
  } else if (e.target !== $search && e.key.length === 1 && !ctrl) {
    $search.focus(); // typing anywhere goes to the search box
  }
});

document.getElementById('open-manager').addEventListener('click', () => {
  store.openManager();
  window.close();
});

init();

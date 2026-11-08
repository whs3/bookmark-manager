# Bookmark Manager (browser extension)

A keyboard-driven manager for your **real** browser bookmarks: search, tag groups,
"last used" tracking, duplicate blocking, broken-link cleanup, and CSV/JSON import/export.

## Install (Chrome, Edge, Brave)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension and press **Alt+K** to open the search popup.

**Firefox (121+):** open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
pick `extension/manifest.json`. Favicons aren't shown in Firefox.

## Features

| Feature | How |
|---|---|
| Search by name, URL, or tag | Type in the popup or manager. `#work`, `tag:`, `title:`, `url:`, `folder:`, `-exclude`, `"phrases"` |
| Tag groups | Tags show in the manager sidebar with counts; click one (or `[` / `]`) to filter. Rename or delete tags from the sidebar |
| Saved / last used dates | Saved = browser's date added (or the imported date). Last used is recorded when you open the bookmark from the extension **or** visit its URL in any tab. Use **Fill from history** to backfill it |
| No duplicates | Adding, editing, importing and the browser's own ☆ button are all checked. URLs count as the same when they differ only by http/https, `www.`, a trailing slash, or `utm_*` tracking parameters. You can turn this off in Help (`?`) |
| Edit / rename / delete | ✎ button on any row (manager or popup), double-click, or `e` / `F2`: edit name, URL, tags, folder, saved date and last-used date. `Del` deletes, with undo (`Ctrl+Z`). Bulk tag and delete for selections |
| Sort by last used | Default sort. `s` cycles through last used, date saved, name, and URL |
| Broken bookmarks | `b` checks the bookmarks currently shown. 404/410 and unreachable sites are pre-selected. 403s and timeouts are marked "Check". You can then delete them or tag them `#broken` |
| Import / export | `i` / `o`. JSON or CSV with columns `title,url,tags,folder,dateAdded,lastUsed` (tags separated by `;`). Imports create missing folders and merge tags into existing bookmarks instead of making duplicates |

## Keyboard shortcuts

**Anywhere in the browser** (change these at `chrome://extensions/shortcuts`):
`Alt+K` search popup · `Alt+Shift+M` manager · `Alt+Shift+D` bookmark the current page

**Popup:** type to search · `↑↓` move · `Enter` open in a new tab · `Shift+Enter` open in this tab ·
`Ctrl+Enter` open in a background tab · `Alt+A` bookmark this page · `Alt+E` edit · `Alt+M` manager

**Manager:** press `?` to see all of them. `/` search · `j/k` or arrows · `Enter` open · `n` new ·
`e` edit · `t` tag · `x` select · `Ctrl+A` select all · `Del` delete · `s` sort · `[ ]` tag groups ·
`c` copy URL · `i`/`o` import/export · `b` check links · `Esc` clear

## Where data lives

- Bookmarks themselves are normal browser bookmarks, so browser sync still works.
- Tags and last-used times are kept in extension storage for speed, and copied (within ~30 s,
  and every 5 minutes) into a bookmarks folder **Bookmark Manager data** under *Other bookmarks*.
  That copy survives removing/re-adding the extension (it's restored automatically) and travels
  to your other devices with browser bookmark sync. The manager hides the folder; don't edit or
  delete it. While developing, prefer the **reload** button over remove/re-add anyway.
- Optional permissions are requested only when needed: *all sites* for the link checker,
  and *history* for "Fill from history".

## Development

```
npm test          # unit tests (core logic + data layer against a fake chrome API)
npm run check     # syntax-check all scripts and validate the manifest
npm run package   # zip extension/ for the Chrome Web Store / AMO
```

Layout: `extension/lib/core.js` (pure logic) · `lib/store.js` (bookmarks and storage) ·
`lib/linkcheck.js` · `background.js` (last-used tracking, duplicate blocking, shortcuts) ·
`popup.*` · `manager.*`

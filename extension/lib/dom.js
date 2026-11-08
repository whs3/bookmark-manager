// Tiny DOM helpers. Everything is built with textContent, never innerHTML,
// so bookmark titles and URLs can't inject markup.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...toNodes(children));
  return el;
}

/** Flatten nested arrays and drop null/undefined/false, so they never render as text. */
function toNodes(children) {
  return children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c)));
}

/** Like el.replaceChildren(), but accepts arrays and skips empty values. */
export function fill(el, ...children) {
  el.replaceChildren(...toNodes(children));
  return el;
}

const IS_CHROME = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);

export function favicon(pageUrl) {
  if (!IS_CHROME || !/^https?:/i.test(pageUrl)) return h('span', { class: 'fav fav-blank', 'aria-hidden': 'true' });
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  const img = h('img', { class: 'fav', src: u.href, alt: '', loading: 'lazy', width: 16, height: 16 });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'fav fav-blank', 'aria-hidden': 'true' })), { once: true });
  return img;
}

let toastTimer;
/** Show a toast. Options: { action: 'Undo', onAction: fn, timeout: ms } */
export function toast(message, { action, onAction, timeout = 4000 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  clearTimeout(toastTimer);
  fill(
    el,
    h('span', {}, message),
    action &&
      h('button', {
        class: 'toast-action',
        onclick: () => {
          el.hidden = true;
          onAction?.();
        },
      }, action),
  );
  el.hidden = false;
  if (timeout) toastTimer = setTimeout(() => (el.hidden = true), timeout);
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

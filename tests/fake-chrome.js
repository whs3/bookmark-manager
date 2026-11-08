// In-memory fake of the parts of chrome.bookmarks / chrome.storage the extension uses.
export function fakeChrome() {
  let nextId = 10;
  const nodes = new Map();
  const add = (n) => (nodes.set(n.id, { children: n.url ? undefined : [], dateAdded: Date.now(), ...n }), nodes.get(n.id));
  const root = add({ id: '0', title: '' });
  for (const [id, title] of [['1', 'Bookmarks bar'], ['2', 'Other bookmarks']]) root.children.push(add({ id, title, parentId: '0' }));
  const clone = (n) => ({ ...n, children: n.children?.map((c) => clone(c)) });
  let local = {};
  const fakeRemove = (id) => {
    const n = nodes.get(id);
    const p = nodes.get(n.parentId);
    p.children = p.children.filter((c) => c.id !== id);
    nodes.delete(id);
  };
  return {
    bookmarks: {
      getTree: async () => [clone(root)],
      get: async (id) => [clone(nodes.get(id))],
      getChildren: async (id) => nodes.get(id).children.map(clone),
      create: async ({ parentId = '2', title, url }) => {
        const n = add({ id: String(nextId++), parentId, title, url });
        nodes.get(parentId).children.push(n);
        return clone(n);
      },
      update: async (id, ch) => Object.assign(nodes.get(id), ch),
      move: async (id, { parentId }) => {
        const n = nodes.get(id);
        const old = nodes.get(n.parentId);
        old.children = old.children.filter((c) => c.id !== id);
        nodes.get(parentId).children.push(n);
        n.parentId = parentId;
      },
      remove: async (id) => fakeRemove(id),
      removeTree: async (id) => fakeRemove(id),
    },
    // Test hooks: swap extension storage to simulate a reinstall or another device.
    _getLocal: () => local,
    _setLocal: (o) => (local = o),
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return structuredClone(local);
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in local).map((k) => [k, structuredClone(local[k])]));
        },
        set: async (o) => void Object.assign(local, structuredClone(o)),
        remove: async (ks) => ks.forEach((k) => delete local[k]),
      },
    },
  };
}

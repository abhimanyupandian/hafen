// A small IndexedDB wrapper: the app's own database ("hafen"), with object stores keyed by "_id".
// Runs are kept here (they can be large), as the Runs section lists them; and conversations, as the
// Conversations section does.

const NAME = "hafen";
const VERSION = 2;
const STORES = ["runs", "conversations"];
let db = null;

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function openDatabase() {
  const req = indexedDB.open(NAME, VERSION);
  req.onupgradeneeded = () => {
    for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "_id" });
  };
  return done(req);
}

function open() {
  db ??= openDatabase();
  return db;
}

async function request(store, mode, act) {
  const tx = (await open()).transaction(store, mode);
  const req = act(tx.objectStore(store));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    // (a write the browser refuses as it commits, the storage full, aborts without an error event)
    tx.onabort = () => reject(tx.error ?? new Error("the browser didn't keep it (its storage may be full)"));
  });
}

export const put = (store, value) => request(store, "readwrite", (s) => s.put(value));
export const get = (store, id) => request(store, "readonly", (s) => s.get(id));
export const all = (store) => request(store, "readonly", (s) => s.getAll());
export const remove = (store, id) => request(store, "readwrite", (s) => s.delete(id));
export const clear = (store) => request(store, "readwrite", (s) => s.clear());

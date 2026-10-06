// A small IndexedDB wrapper: the app's own database ("hafen"), with object stores keyed by "_id".
// Runs are kept here (they can be large), as the Runs section lists them; and conversations, as the
// Conversations section does.

const NAME = "hafen";
const VERSION = 2;
const STORES = ["runs", "conversations"];
// Before the app was Hafen its database was "hafen-eval": what that holds is copied over (a record
// already here stays as it is), then it's deleted. Until that's done, it's tried again each time.
export const LEGACY = "hafen-eval";
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

// The legacy database's records, copied in; true once it's gone. (Only where the browser can list
// its databases: opening one to look would make it.)
export async function carryOver(into) {
  if (!indexedDB.databases || !(await indexedDB.databases()).some((d) => d.name === LEGACY)) return false;
  const old = await done(indexedDB.open(LEGACY));
  try {
    for (const name of STORES.filter((s) => old.objectStoreNames.contains(s))) {
      const records = await done(old.transaction(name, "readonly").objectStore(name).getAll());
      if (!records.length) continue;
      const tx = into.transaction(name, "readwrite");
      const store = tx.objectStore(name);
      for (const record of records) {
        // add(): a record that's here already (copied before, or newer) is kept, not written over
        store.add(record).onerror = (e) => { e.preventDefault(); e.stopPropagation(); };
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
  } finally {
    old.close();
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(LEGACY);
    // (Open in another tab of the old app: it's deleted once that closes it)
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  return true;
}

function open() {
  db ??= openDatabase().then(async (opened) => {
    try {
      await carryOver(opened);
    } catch (err) {
      console.error(`couldn't copy the runs and conversations kept before the app was Hafen: ${err.message}`);
    }
    return opened;
  });
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

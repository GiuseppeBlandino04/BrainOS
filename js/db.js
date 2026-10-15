// Archivio locale del telefono (IndexedDB): funziona offline e sopravvive alla chiusura dell'app.
// Negozi: kv (impostazioni e pacchetto), events (diario da inviare), uploads (file da inviare),
// materials (materiale scaricato per l'offline), log (registro).
const DB_NAME = 'brainos';
const STORES = { kv: { keyPath: 'k' }, events: { keyPath: 'seq' }, uploads: { keyPath: 'id' },
  materials: { keyPath: 'id' }, log: { keyPath: 'id', autoIncrement: true },
  // il cervello del telefono (v2): documenti, frammenti, conversazioni, carte e note proprie
  docs: { keyPath: 'id' }, chunks: { keyPath: 'id' }, chats: { keyPath: 'id' }, mycards: { keyPath: 'id' }, mynotes: { keyPath: 'id' } };

let dbp = null;
const mem = globalThis.__BRAINOS_MEMDB ? Object.fromEntries(Object.keys(STORES).map(s => [s, new Map()])) : null;
let memAuto = 1;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      for (const [name, opts] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, opts);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const clone = v => (v === undefined ? v : structuredClone(v));

export async function get(store, key) {
  if (mem) return clone(mem[store].get(key));
  return tx(store, 'readonly', s => req(s.get(key)));
}
export async function put(store, value) {
  if (mem) {
    if (STORES[store].autoIncrement && value.id === undefined) value = { ...value, id: memAuto++ };
    mem[store].set(value[STORES[store].keyPath], clone(value));
    return value[STORES[store].keyPath];
  }
  return tx(store, 'readwrite', s => req(s.put(value)));
}
export async function del(store, key) {
  if (mem) { mem[store].delete(key); return; }
  return tx(store, 'readwrite', s => req(s.delete(key)));
}
export async function all(store) {
  if (mem) return [...mem[store].values()].map(clone);
  return tx(store, 'readonly', s => req(s.getAll()));
}
export async function clear(store) {
  if (mem) { mem[store].clear(); return; }
  return tx(store, 'readwrite', s => req(s.clear()));
}
export async function kget(k, dflt = null) { const r = await get('kv', k); return r ? r.v : dflt; }
export async function kset(k, v) { return put('kv', { k, v }); }

// scritture in blocco (molti frammenti in una transazione sola)
export async function putMany(store, values) {
  if (mem) { for (const v of values) await put(store, v); return; }
  return tx(store, 'readwrite', s => { for (const v of values) s.put(v); });
}
// cancella le chiavi che iniziano con un prefisso (es. i frammenti "doc:0", "doc:1"…): veloce anche con
// decine di migliaia di frammenti, perché non scorre tutto il magazzino
export async function delPrefix(store, prefix) {
  if (mem) { for (const k of [...mem[store].keys()]) if (String(k).startsWith(prefix)) mem[store].delete(k); return; }
  return tx(store, 'readwrite', s => req(s.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))));
}
export async function delWhere(store, pred) {
  if (mem) { for (const [k, v] of mem[store]) if (pred(v)) mem[store].delete(k); return; }
  return tx(store, 'readwrite', s => new Promise(res => {
    const c = s.openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(); if (pred(cur.value)) cur.delete(); cur.continue(); };
  }));
}

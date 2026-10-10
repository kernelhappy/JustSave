// One IndexedDB store written by the service worker (background.js) and read by the result tab (result.js), for handing a finished capture across.
export const idb = (mode, fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open('justsave', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('files');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    // Settle on the transaction, not the request: a big put can still fail at commit (quota).
    const db = open.result, tx = db.transaction('files', mode), req = fn(tx.objectStore('files'));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? req.error); };
  };
});

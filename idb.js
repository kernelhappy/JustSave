// One IndexedDB store shared by the popup and service worker, for handing the finished capture to the popup.
export const idb = (mode, fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open('justsave', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('files');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = fn(open.result.transaction('files', mode).objectStore('files'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  };
});

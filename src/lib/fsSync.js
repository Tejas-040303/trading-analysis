// File System Access API glue for the MT5 "Sync folder" (Chrome/Edge only).
//
// The user picks the folder the local helper writes `latest.json` into; we persist
// the directory handle in IndexedDB so future syncs are one click (just a
// permission re-grant), and read latest.json from it on demand. Browser-only —
// guard callers with isFsSyncSupported(). No data leaves the machine.

const DB_NAME = "tj_fs";
const STORE = "handles";
const KEY = "mt5SyncDir";
const FILENAME = "latest.json";

export function isFsSyncSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

// Prompt for a directory and remember it. Throws AbortError if the user cancels.
export async function pickSyncFolder() {
  const handle = await window.showDirectoryPicker({ id: "tj-mt5-sync", mode: "read" });
  try {
    await idbPut(KEY, handle);
  } catch {
    /* handle still usable this session even if persistence fails */
  }
  return handle;
}

// The previously-chosen directory handle, or null. Permission is re-checked at
// read time (a fresh session shows "prompt" until the user re-grants).
export async function getSavedFolder() {
  try {
    return await idbGet(KEY);
  } catch {
    return null;
  }
}

async function ensureReadPermission(handle) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

// Read latest.json's text from the folder. Throws a user-facing Error on any
// problem (no folder, denied permission, missing file).
export async function readLatest(handle) {
  if (!handle) throw new Error("No sync folder chosen yet.");
  if (!(await ensureReadPermission(handle))) {
    throw new Error("Permission to read the sync folder was denied.");
  }
  let fileHandle;
  try {
    fileHandle = await handle.getFileHandle(FILENAME);
  } catch {
    throw new Error(`No ${FILENAME} in that folder yet — run the MT5 sync helper first.`);
  }
  const file = await fileHandle.getFile();
  return file.text();
}

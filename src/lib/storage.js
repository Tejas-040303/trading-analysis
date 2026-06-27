// localStorage wrapper — standalone-hosting replacement for the Claude-artifact
// `window.storage` API used by the original prototype (see spec §9).
// Synchronous; values are JSON-serialized on write and parsed on read.
export const storage = {
  get(key) {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  },
};

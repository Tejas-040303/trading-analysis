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
  // Returns true on success, false if the write failed (e.g. quota exceeded).
  // Callers should check the return value so a full disk surfaces to the user
  // instead of silently dropping data.
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // QuotaExceededError is reported differently across browsers — match by
      // name, legacy name, or numeric code rather than relying on one of them.
      const quota =
        e &&
        (e.name === "QuotaExceededError" ||
          e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
          e.code === 22 ||
          e.code === 1014);
      if (!quota) {
        // Non-quota failures (e.g. serialization) are unexpected — surface in console.
        console.error("storage.set failed:", e);
      }
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

// Approximate localStorage usage for this app's keys, in bytes. Sums the
// UTF-16 length (×2) of every `tj_*` key and value so the Settings panel can
// warn before the ~5 MB browser quota is hit.
export function estimateUsageBytes() {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("tj_")) continue;
      const v = localStorage.getItem(k) || "";
      bytes += (k.length + v.length) * 2;
    }
  } catch {
    return 0;
  }
  return bytes;
}

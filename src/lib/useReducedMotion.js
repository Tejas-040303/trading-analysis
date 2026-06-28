import { useState, useEffect } from "react";

// Tracks the OS-level "prefers reduced motion" accessibility setting, updating
// live if the user changes it. Recharts animations are SVG/rAF-driven (not CSS
// transitions), so the global media query in index.css can't reach them — pass
// the returned flag to `isAnimationActive` on chart series instead.
export function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [reduced, setReduced] = useState(() => (supported ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!supported) return;
    const mq = window.matchMedia(query);
    const onChange = (e) => setReduced(e.matches);
    // addEventListener is the modern API; addListener is the Safari < 14 fallback.
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, [supported]);

  return reduced;
}

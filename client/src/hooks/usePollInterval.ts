// === W48 perf (PERF-FE-5): polling discipline ===
// Visibility-gated refetchInterval: returns `false` (no polling) while the
// tab is hidden, so background tabs stop hammering the API. React Query only
// re-evaluates refetchInterval on state changes, so we track visibility in
// state to flip the interval as soon as the tab hides/shows.
import { useEffect, useState } from "react";

export function usePollInterval(ms: number): number | false {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible"
  );

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return visible ? ms : false;
}

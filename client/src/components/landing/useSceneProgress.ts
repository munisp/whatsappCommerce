import { useEffect, useRef } from "react";

/**
 * How far the page has scrolled through a tall scene, as 0 to 1. Written to the --p CSS variable
 * rather than React state, so scrolling doesn't re-render the scene on every frame.
 */
export function useSceneProgress<T extends HTMLElement>(onProgress?: (progress: number) => void) {
  const ref = useRef<T>(null);
  const callback = useRef(onProgress);
  callback.current = onProgress;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const { top, height } = element.getBoundingClientRect();
      const travel = height - window.innerHeight;
      const progress = travel > 0 ? Math.min(1, Math.max(0, -top / travel)) : 0;
      element.style.setProperty("--p", progress.toFixed(4));
      callback.current?.(progress);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return ref;
}

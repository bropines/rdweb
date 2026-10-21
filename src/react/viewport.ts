import { useEffect, type RefObject } from "react";

/**
 * Keeps a full-screen element inside the visual viewport, so on-screen
 * keyboards shrink it instead of covering its bottom (Chrome on Android and
 * Safari only resize the visual viewport by default).
 */
export function useVisualViewport(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const apply = () => {
      el.style.height = `${vv.height}px`;
      el.style.transform = `translateY(${vv.offsetTop}px)`;
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, [ref]);
}

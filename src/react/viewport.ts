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

/**
 * Turns off the browser's pull-to-refresh and overscroll bounce while the
 * component is mounted: a downward swipe in a full-screen session must not
 * reload the page.
 */
export function useNoPullToRefresh(): void {
  useEffect(() => {
    const els = [document.documentElement, document.body];
    const before = els.map((el) => el.style.overscrollBehavior);
    for (const el of els) el.style.overscrollBehavior = "none";
    return () => els.forEach((el, i) => (el.style.overscrollBehavior = before[i] ?? ""));
  }, []);
}

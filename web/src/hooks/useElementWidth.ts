import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The element's own width (`clientWidth`) up to `ceiling`, kept current by a ResizeObserver (and the window's resize where there is none); `null` until
 * it is measured (the first time before paint, so a phone's first frame is already fitted) and while it measures 0 (not laid out: a test DOM, a hidden
 * tab), so a caller never acts on a width that is not real. A width past `ceiling` is stored AS `ceiling`: a caller that only cares about being below it
 * re-renders on no resize at wider sizes (the Timeline does not re-render per pixel, `timeline.md`).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>, ceiling: number): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => setWidth(element.clientWidth > 0 ? Math.min(element.clientWidth, ceiling) : null);
    update();
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [ref, ceiling]);
  return width;
}

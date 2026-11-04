import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * A client-side navigation keeps the focus on the link that was clicked (or drops it on `body` when that link unmounts), so a keyboard or
 * screen-reader user would have to find the new page again. On a PATHNAME change the shell hands the focus to `#main-content`
 * (`tabIndex={-1}`, no ring: `index.css`), so the next Tab lands in the page's first control and the reader starts at its top.
 *
 * - Only the pathname counts: a query-string change (`?baseline=`), a filter or a sort never moves the focus, and neither does a history entry
 *   for the same path. The first render is skipped (a reload or a fresh sign-in leaves the document start alone; the skip link is then the
 *   first Tab stop), which the remembered previous pathname gives for free.
 * - A page that already owns the focus keeps it: when the active element is inside main (a field with `autoFocus` mounted in the same commit
 *   - React focuses it before this passive effect runs), nothing moves. A lazy page that mounts after this effect finds main focused and its
 *   own `autoFocus` takes the focus from there.
 * - `preventScroll`: the move is for the keyboard's sake, not the viewport's; the window keeps the scroll position the navigation gave it.
 */
export function useFocusMainOnNavigation() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const main = document.getElementById("main-content");
    if (main === null || main.contains(document.activeElement)) return;
    main.focus({ preventScroll: true });
  }, [pathname]);
}

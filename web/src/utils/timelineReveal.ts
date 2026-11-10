import classes from "../theme.module.css";

/**
 * A focused cell, bar or handle must not sit UNDER the sticky parts. The browser scrolls a focused element only when it is not (partly)
 * visible, and it does not know that the sticky columns and header cover part of the scroller (`scroll-margin` is only honoured when it
 * decides to scroll at all): a bar half under the columns took focus with its ring hidden (found by the 1,000-row measurement). So the
 * grid measures the focus target against the part of the scroller that is really shown (inside its border, so a classic scrollbar is
 * not counted) and scrolls the difference — never further than the target's own start edge reaching the sticky parts, so a bar wider
 * than the visible track shows its START (and a handle never bounces). Only keyboard-style focus (`:focus-visible`) reveals: a mouse
 * press on a bar must not move the grid under the pointer — unless the page forced it (`focusRow`: a focus it moved itself after a click).
 * Left cells are sticky themselves and need no horizontal correction. `head` is the sticky header's height, `leftWidth` the sticky columns' width.
 */
export function revealFocused(scroller: HTMLElement | null, target: HTMLElement, head: number, leftWidth: number, force = false): void {
  if (scroller === null || target.closest("[data-grid-pos]") === null || !(force || target.matches(":focus-visible"))) return;
  const box = target.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const viewTop = view.top + scroller.clientTop;
  const viewBottom = viewTop + scroller.clientHeight;
  const clearTop = viewTop + head;
  if (box.top < clearTop) scroller.scrollTop -= clearTop - box.top;
  else if (box.bottom > viewBottom) scroller.scrollTop += Math.min(box.bottom - viewBottom, box.top - clearTop);
  if (target.closest(`.${classes.timelineLeft}`) !== null) return;
  const viewLeft = view.left + scroller.clientLeft;
  const viewRight = viewLeft + scroller.clientWidth;
  const clearLeft = viewLeft + leftWidth;
  if (box.left < clearLeft) scroller.scrollLeft -= clearLeft - box.left;
  else if (box.right > viewRight) scroller.scrollLeft += Math.min(box.right - viewRight, box.left - clearLeft);
}

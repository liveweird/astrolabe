import { useEffect, useRef, type RefObject } from "react";

type Pending = { kind: "unpin"; next: string | null; key: string } | { kind: "row"; key: string; from: string };

/**
 * Where the keyboard focus goes after a change that takes its element away, for the two such changes of the Plan page (each is set BEFORE the change
 * and acted on once the render after it is committed, as `useDeleteConfirm` does):
 *  - an Unpin pressed in the pinned section removes the button that held the focus: the next pinned root's Unpin button, else the previous one's,
 *    else the node's own row menu in the tree, else the page title;
 *  - a step back up the breadcrumb: the row of the node that was focused (its first control), else the title - acted on only once the ADDRESS has
 *    changed (`address`), because the row's own controls change with the focus (its root has no disclosure button) and the page says "Showing…"
 *    in a render of its own before the router has moved.
 */
export function usePlanFocusReturn(titleRef: RefObject<HTMLElement | null>, address: string) {
  const pending = useRef<Pending | null>(null);
  useEffect(() => {
    const target = pending.current;
    if (target === null || (target.kind === "row" && target.from === address)) return;
    pending.current = null;
    const find = (selector: string) => document.querySelector<HTMLElement>(selector);
    const element =
      target.kind === "unpin"
        ? ((target.next === null ? null : find(`[data-unpin-for="${target.next}"]`)) ?? find(`[data-operations-for="tree:${target.key}"]`))
        : find(`tr[data-scope="tree"][data-key="${target.key}"] :is(button, a)`);
    (element ?? titleRef.current)?.focus({ preventScroll: false });
  });
  return {
    /** An Unpin of the pinned root `key` is about to run; `roots` are the pinned roots in order. */
    afterUnpin: (roots: readonly string[], key: string) => {
      const at = roots.indexOf(key);
      pending.current = { kind: "unpin", next: roots[at + 1] ?? roots[at - 1] ?? null, key };
    },
    /** The focus is about to change: afterwards it goes to the row of `key`. */
    afterRow: (key: string) => {
      pending.current = { kind: "row", key, from: address };
    },
  };
}

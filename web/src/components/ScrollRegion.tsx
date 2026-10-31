import type { ReactNode, Ref } from "react";
import { Table } from "@mantine/core";
import classes from "../theme.module.css";

/**
 * The one scroller for a table that can outgrow its box (wider than the page, or capped by
 * `maxHeight`): a native scroller that is itself a focusable, labelled region, so the keyboard can
 * reach and scroll it (axe: scrollable-region-focusable) and assistive technology names it. `label`
 * is the table's own accessible name. Never reach for a bare `Table.ScrollContainer`.
 */
export default function ScrollRegion({
  label,
  minWidth,
  maxHeight,
  scrollRef,
  children,
}: {
  label: string;
  minWidth: number;
  maxHeight?: number | string;
  /** The scroller element itself, for a caller that drives scrolling (the Timeline's virtualiser and its Today button). */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <Table.ScrollContainer
      ref={scrollRef}
      type="native"
      minWidth={minWidth}
      maxHeight={maxHeight}
      className={classes.tableScroll}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </Table.ScrollContainer>
  );
}

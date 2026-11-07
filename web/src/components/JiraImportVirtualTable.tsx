import { Fragment, useRef, type CSSProperties, type ReactNode } from "react";
import { Table } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import ScrollRegion from "./ScrollRegion";

/** More rows than this are virtualised (the Timeline's rule); fewer are all mounted, which is what the small previews and the tests see. */
const VIRTUALIZE_FROM = 80;
const OVERSCAN_ROWS = 12;
/** The sticky header row, so the first row's offset (and `scrollToIndex`) lands below it. */
const HEAD_HEIGHT = 41;

/** What a row needs from its table: the 1-based `aria-rowindex` (the header row, which the caller indexes 1, comes first) and the fixed height the virtualiser relies on. */
export type VirtualRowProps = { "aria-rowindex": number; style: CSSProperties };

/**
 * A real `<table>` in the shared focusable `ScrollRegion` whose body virtualises above `VIRTUALIZE_FROM` rows (TanStack Virtual, as the
 * Timeline does): only a window of rows is mounted, two spacer rows keep the scroll height true, and `aria-rowcount`/`aria-rowindex`
 * tell assistive technology how many rows there really are. Rows have ONE fixed height (`rowHeight`: cells clamp their text), which is
 * what makes the offsets exact without measuring. Used for the import preview (up to 2,000 rows) and the outcome's skipped list.
 */
export default function JiraImportVirtualTable({
  label,
  count,
  rowHeight,
  minWidth,
  maxHeight,
  columns,
  header,
  renderRow,
}: {
  label: string;
  count: number;
  rowHeight: number;
  minWidth: number;
  maxHeight: number;
  columns: number;
  header: ReactNode;
  renderRow: (index: number, rowProps: VirtualRowProps) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = count > VIRTUALIZE_FROM;
  // TanStack Virtual returns a stable mutable instance the React compiler cannot memoise around; nothing here is memoised on it.
  // eslint-disable-next-line react-hooks/incompatible-library -- see above
  const virtualizer = useVirtualizer({
    count: virtual ? count : 0,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
    scrollMargin: HEAD_HEIGHT,
    scrollPaddingStart: HEAD_HEIGHT,
  });
  const windowItems = virtual ? virtualizer.getVirtualItems() : [];
  const first = windowItems[0];
  const last = windowItems[windowItems.length - 1];
  const before = first === undefined ? 0 : first.start - HEAD_HEIGHT;
  const after = last === undefined ? 0 : virtualizer.getTotalSize() - (last.end - HEAD_HEIGHT);
  const indexes = virtual ? windowItems.map((item) => item.index) : Array.from({ length: count }, (_, index) => index);

  return (
    <ScrollRegion label={label} minWidth={minWidth} maxHeight={maxHeight} scrollRef={scrollRef}>
      <Table stickyHeader aria-label={label} aria-rowcount={count + 1} verticalSpacing={0}>
        <Table.Thead>{header}</Table.Thead>
        <Table.Tbody>
          {before > 0 && <Spacer height={before} columns={columns} />}
          {indexes.map((index) => (
            <Fragment key={index}>{renderRow(index, { "aria-rowindex": index + 2, style: { height: rowHeight } })}</Fragment>
          ))}
          {after > 0 && <Spacer height={after} columns={columns} />}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

/** Stands for the unmounted rows above or below the window; hidden from assistive technology (it is not a row of the data). */
function Spacer({ height, columns }: { height: number; columns: number }) {
  return (
    <Table.Tr aria-hidden="true" style={{ height }}>
      <Table.Td colSpan={columns} p={0} style={{ border: 0 }} />
    </Table.Tr>
  );
}

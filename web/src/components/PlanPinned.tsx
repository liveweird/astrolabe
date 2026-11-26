import type { Ref } from "react";
import { Table, Text, Title, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import classes from "../theme.module.css";
import type { PlanActions, PlanViewActions } from "../utils/planActions";
import type { PinnedRow } from "../utils/planPins";
import type { NodeRow } from "../utils/planTree";
import PlanTableHead from "./PlanTableHead";
import PlanTreeRow from "./PlanTreeRow";
import ScrollRegion from "./ScrollRegion";

/**
 * The "Pinned" section above the plan table: the nodes the user pinned, each with what is under it, whatever the filters and the focus show. A plain
 * wrapper (no landmark) that sticks under the app header, with its own height limit and scroll (`ScrollRegion`), so a pin stays in reach while the
 * tree below scrolls; below 48em it is static. The heading holds the section's own fold button. The rows are the tree's row (`scope="pinned"`): no
 * handle, no Move items, a root has a visible Unpin button, every name wrapped "(pinned)". It is no content on paper (`data-print="hide"`).
 */
export default function PlanPinned({
  rows,
  count,
  open,
  onOpen,
  actions,
  view,
  onToggle,
  outerRef,
}: {
  rows: readonly PinnedRow[];
  /** How many pinned roots there are. */
  count: number;
  open: boolean;
  onOpen: (open: boolean) => void;
  actions: PlanActions;
  view: PlanViewActions;
  onToggle: (row: NodeRow & { root: string }) => void;
  /** The wrapper, for the page to measure (the tree's rows keep clear of it when they take the focus). */
  outerRef: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const label = t("plan.pin.tableAria");
  return (
    <div ref={outerRef} className={classes.planPinned} data-print="hide">
      <div className={classes.planPinnedInner}>
        <Title order={3} size="h4">
          <UnstyledButton className={classes.planTreeToggle} aria-expanded={open} onClick={() => onOpen(!open)}>
            {open ? <IconChevronDown size={16} aria-hidden="true" /> : <IconChevronRight size={16} aria-hidden="true" />}
            {t("plan.pin.title")}{" "}
            <Text span size="xs" c="dimmed" fw={400}>
              {t("plan.pin.count", { count })}
            </Text>
          </UnstyledButton>
        </Title>
        {open && (
          <ScrollRegion label={label} minWidth={800} maxHeight="min(40vh, 20rem)">
            <Table layout="fixed" aria-label={label} className={classes.planTreeTable}>
              <PlanTableHead hidden />
              <Table.Tbody>
                {rows.map((row) => (
                  <PlanTreeRow
                    key={`pin:${row.root}>${row.key}`}
                    row={row}
                    scope="pinned"
                    root={row.root}
                    actions={actions}
                    view={view}
                    highlight=""
                    onToggle={(node) => onToggle({ ...node, root: row.root })}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        )}
      </div>
    </div>
  );
}

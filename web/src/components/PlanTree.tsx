import { Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import classes from "../theme.module.css";
import type { PlanActions, PlanViewActions } from "../utils/planActions";
import type { NodeRow, PlanTreeRow as Row } from "../utils/planTree";
import PlanTableHead from "./PlanTableHead";
import PlanTreeRow from "./PlanTreeRow";
import ScrollRegion from "./ScrollRegion";

/**
 * The plan as ONE table: a column header row once, then a row per visible node (the rows arrive in the server's order with the folds, the filters and
 * the focus applied, `utils/planTree.ts`). A plain table with row headers and disclosure buttons, not a `treegrid`: its links, "+" buttons and menus
 * stay ordinary controls. Below the page's width the table scrolls inside the house `ScrollRegion`; the columns keep their widths so a name never
 * shrinks below legibility.
 */
export default function PlanTree({
  rows,
  actions,
  view,
  highlight,
  onToggle,
}: {
  rows: readonly Row[];
  actions: PlanActions;
  view: PlanViewActions;
  /** The name search's text, marked in the names. */
  highlight: string;
  onToggle: (row: NodeRow) => void;
}) {
  const { t } = useTranslation();
  const label = t("plan.tree.tableAria");
  return (
    <ScrollRegion label={label} minWidth={800}>
      <Table layout="fixed" aria-label={label} className={classes.planTreeTable}>
        <PlanTableHead />
        <Table.Tbody>
          {rows.map((row) => (
            <PlanTreeRow key={`tree:${row.key}`} row={row} scope="tree" actions={actions} view={view} highlight={highlight} onToggle={onToggle} />
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

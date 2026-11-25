import { Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import classes from "../theme.module.css";
import type { PlanActions } from "../utils/planActions";
import type { NodeRow, PlanTreeRow as Row } from "../utils/planTree";
import PlanTreeRow from "./PlanTreeRow";
import ScrollRegion from "./ScrollRegion";

/**
 * The plan as ONE table: a column header row once, then a row per visible node (the rows arrive in the server's order with the folds applied,
 * `utils/planTree.ts`). A plain table with row headers and disclosure buttons, not a `treegrid`: its links, "+" buttons and menus stay ordinary
 * controls. Below the page's width the table scrolls inside the house `ScrollRegion`; the columns keep their widths so a name never shrinks
 * below legibility.
 */
export default function PlanTree({ rows, actions, onToggle }: { rows: readonly Row[]; actions: PlanActions; onToggle: (row: NodeRow) => void }) {
  const { t } = useTranslation();
  const label = t("plan.tree.tableAria");
  return (
    <ScrollRegion label={label} minWidth={800}>
      <Table layout="fixed" aria-label={label} className={classes.planTreeTable}>
        <colgroup>
          <col />
          <col style={{ width: "11rem" }} />
          <col style={{ width: "14rem" }} />
          <col style={{ width: "5.5rem" }} data-print="hide" />
        </colgroup>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">{t("plan.column.name")}</Table.Th>
            <Table.Th scope="col">{t("common.field.owner")}</Table.Th>
            <Table.Th scope="col">{t("plan.column.dates")}</Table.Th>
            <Table.Th scope="col" aria-label={t("common.table.operations")} data-print="hide" className={`${classes.planTreeActions} ${classes.planTreeActionsHead}`} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <PlanTreeRow key={`tree:${row.key}`} row={row} scope="tree" actions={actions} onToggle={onToggle} />
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

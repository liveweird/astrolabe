import { Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import classes from "../theme.module.css";

/**
 * The columns of a Plan table (the tree's and the pinned section's share them, so a row lines up in both): a `colgroup` and the header row.
 * `hidden` draws the header for assistive technology only (the pinned section: one header, the tree's, is ever seen).
 */
export default function PlanTableHead({ hidden = false }: { hidden?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <colgroup>
        <col />
        <col style={{ width: "11rem" }} />
        <col style={{ width: "14rem" }} />
        <col style={{ width: "6.5rem" }} data-print="hide" />
      </colgroup>
      <Table.Thead className={hidden ? classes.planTreeHeadHidden : undefined}>
        <Table.Tr>
          <Table.Th scope="col">{t("plan.column.name")}</Table.Th>
          <Table.Th scope="col">{t("common.field.owner")}</Table.Th>
          <Table.Th scope="col">{t("plan.column.dates")}</Table.Th>
          <Table.Th scope="col" aria-label={t("common.table.operations")} data-print="hide" className={`${classes.planTreeActions} ${classes.planTreeActionsHead}`} />
        </Table.Tr>
      </Table.Thead>
    </>
  );
}

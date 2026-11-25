import { Fragment, type ReactNode } from "react";
import { Menu } from "@mantine/core";
import { IconArrowsExchange, IconFileImport, IconLock, IconLockOpen, IconPencil, IconTrash } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { PlanActions } from "../utils/planActions";
import { rowName, type PlanTreeRow } from "../utils/planTree";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";

/**
 * The one row menu of the Plan table, for every kind of row: a list of GROUPS, each only when something in it is allowed, with a divider between
 * the groups that are there. Today: edit (the editor, close / reopen, "Move to…", the Jira import), then delete. The view group (show only this,
 * pin) goes before and the order group (move up, move down) after it; a row with no allowed item has no menu at all. Nothing here decides rights:
 * the node's `can` flags and the page's actions do.
 */
export default function PlanRowMenu({ row, actions }: { row: PlanTreeRow; actions: PlanActions }) {
  const { t } = useTranslation();
  const name = rowName(row);
  const groups = (
    [
      ["edit", editGroup(row, actions, t)],
      ["delete", deleteGroup(row, actions, t)],
    ] as const
  ).filter(([, items]) => items.length > 0);
  if (groups.length === 0) return null;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name })}>
      {groups.map(([id, items], index) => (
        <Fragment key={id}>
          {index > 0 && <Menu.Divider />}
          {items}
        </Fragment>
      ))}
    </RowActionsMenu>
  );
}

/** Edit, close or reopen (a work stream), "Move to…" and the Jira import: what changes the node or sends it elsewhere. */
function editGroup(row: PlanTreeRow, actions: PlanActions, t: TFunction): ReactNode[] {
  const items: ReactNode[] = [];
  if (row.kind === "workStream") {
    const { stream } = row;
    const closed = stream.endDate !== null;
    if (stream.can.edit) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editWorkStream(stream)} aria-label={t("common.action.editAria", { name: stream.name })}>
          {t("common.action.edit")}
        </Menu.Item>,
        <Menu.Item
          key="close"
          leftSection={closed ? <IconLockOpen size={14} /> : <IconLock size={14} />}
          onClick={() => actions.setWorkStreamClosed(stream, !closed)}
          aria-label={t(closed ? "plan.workStream.reopenAria" : "plan.workStream.closeAria", { name: stream.name })}
        >
          {t(closed ? "plan.workStream.reopen" : "plan.workStream.close")}
        </Menu.Item>,
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importFromJira(stream)} aria-label={t("jira.import.entryAria", { name: stream.name })}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  } else if (row.kind === "program") {
    const { stream, program } = row;
    if (program.can.edit) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editProgram(stream, program)} aria-label={t("common.action.editAria", { name: program.name })}>
          {t("common.action.edit")}
        </Menu.Item>,
      );
    }
    if (actions.canMoveProgram(program)) {
      items.push(
        <Menu.Item key="move" leftSection={<IconArrowsExchange size={14} />} onClick={() => actions.moveProgram(program)} aria-label={t("plan.move.programAria", { name: program.name })}>
          {t("plan.move.action")}
        </Menu.Item>,
      );
    }
    if (actions.canImportChildren(program)) {
      items.push(
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importChildren(program)} aria-label={t("jira.import.entryRootAria", { name: program.name })}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  } else {
    const { program, project } = row;
    // The fields (`can.edit`) and the target window (`can.editTargetWindow`) are two rights; the editor offers whichever the caller holds.
    if (project.can.edit || project.can.editTargetWindow) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editProject(program, project)} aria-label={t("common.action.editAria", { name: project.name })}>
          {t("common.action.edit")}
        </Menu.Item>,
      );
    }
    if (actions.canMoveProject(project)) {
      items.push(
        <Menu.Item key="move" leftSection={<IconArrowsExchange size={14} />} onClick={() => actions.moveProject(project)} aria-label={t("plan.move.projectAria", { name: project.name })}>
          {t("plan.move.action")}
        </Menu.Item>,
      );
    }
    if (actions.canImportMilestones(project)) {
      items.push(
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importMilestones(project)} aria-label={t("jira.import.entryRootAria", { name: project.name })}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  }
  return items;
}

/** Delete, alone in its group so the divider sets it apart. */
function deleteGroup(row: PlanTreeRow, actions: PlanActions, t: TFunction): ReactNode[] {
  const node = row.kind === "workStream" ? row.stream : row.kind === "program" ? row.program : row.project;
  if (!node.can.delete) return [];
  const remove = () => (row.kind === "workStream" ? actions.deleteWorkStream(row.stream) : row.kind === "program" ? actions.deleteProgram(row.program) : actions.deleteProject(row.project));
  return [
    <DestructiveMenuItem key="delete" leftSection={<IconTrash size={14} />} onClick={remove} aria-label={t("common.action.deleteAria", { name: node.name })}>
      {t("common.action.delete")}
    </DestructiveMenuItem>,
  ];
}

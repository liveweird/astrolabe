import { Fragment, type ReactNode } from "react";
import { Menu } from "@mantine/core";
import { IconArrowsExchange, IconFileImport, IconFocus2, IconLock, IconLockOpen, IconPencil, IconPin, IconPinnedOff, IconTrash } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { PlanActions, PlanViewActions } from "../utils/planActions";
import { scopedLabel, type PlanScope } from "../utils/planPins";
import { rowName, type PlanTreeRow } from "../utils/planTree";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";

/** A scope's spelling of an accessible name (`scopedLabel`): the pinned copy of a row wraps every name. */
type Label = (text: string) => string;

/**
 * The one row menu of the Plan table, for every kind of row: a list of GROUPS, each only when something in it is allowed, with a divider between
 * the groups that are there: view (Show only this, a real link, for a work stream or program; Pin or Unpin, in the tree), edit (the editor, close /
 * reopen, "Move to…", the Jira import), then delete. The order group (move up, move down) goes after the view group. Everyone may pin and focus, so
 * every row has a menu. Nothing here decides rights: the node's `can` flags and the page's actions do. In the pinned section every name is wrapped
 * (`scopedLabel`) and the Pin item is left out (a pinned root has its own Unpin button). `opsId` is the scope-qualified id of the menu button
 * (`tree:pg:12`, `pin:ws:3>pg:12`): the same node is on the page twice once it is pinned.
 */
export default function PlanRowMenu({ row, scope, opsId, actions, view }: { row: PlanTreeRow; scope: PlanScope; opsId: string; actions: PlanActions; view: PlanViewActions }) {
  const { t } = useTranslation();
  const name = rowName(row);
  const label: Label = (text) => scopedLabel(t, scope, text);
  const groups = (
    [
      ["view", viewGroup(row, scope, view, t, label)],
      ["edit", editGroup(row, actions, t, label)],
      ["delete", deleteGroup(row, actions, t, label)],
    ] as const
  ).filter(([, items]) => items.length > 0);
  if (groups.length === 0) return null;
  return (
    <RowActionsMenu label={label(t("common.table.operationsAria", { name }))} trigger={{ tabIndex: 0, "data-operations-for": opsId }}>
      {groups.map(([id, items], index) => (
        <Fragment key={id}>
          {index > 0 && <Menu.Divider />}
          {items}
        </Fragment>
      ))}
    </RowActionsMenu>
  );
}

/** Show only this (a link: the address with the focus set) and Pin or Unpin: what changes how the plan is looked at, never the plan. */
function viewGroup(row: PlanTreeRow, scope: PlanScope, view: PlanViewActions, t: TFunction, label: Label): ReactNode[] {
  const items: ReactNode[] = [];
  const name = rowName(row);
  if (row.kind !== "project" && !row.locked) {
    items.push(
      <Menu.Item key="focus" component={RouterLink} to={view.focusHref(row)} leftSection={<IconFocus2 size={14} />} onClick={(event) => view.focused(row, event)} aria-label={label(t("plan.focus.showOnlyAria", { name }))}>
        {t("plan.focus.showOnly")}
      </Menu.Item>,
    );
  }
  if (scope === "tree") {
    const pinned = view.isPinned(row.key);
    items.push(
      <Menu.Item
        key="pin"
        leftSection={pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
        onClick={() => (pinned ? view.unpin(row.key, name) : view.pin(row))}
        aria-label={t(pinned ? "plan.pin.unpinAria" : "plan.pin.actionAria", { name })}
      >
        {t(pinned ? "plan.pin.unpin" : "plan.pin.action")}
      </Menu.Item>,
    );
  }
  return items;
}

/** Edit, close or reopen (a work stream), "Move to…" and the Jira import: what changes the node or sends it elsewhere. */
function editGroup(row: PlanTreeRow, actions: PlanActions, t: TFunction, label: Label): ReactNode[] {
  const items: ReactNode[] = [];
  if (row.kind === "workStream") {
    const { stream } = row;
    const closed = stream.endDate !== null;
    if (stream.can.edit) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editWorkStream(stream)} aria-label={label(t("common.action.editAria", { name: stream.name }))}>
          {t("common.action.edit")}
        </Menu.Item>,
        <Menu.Item
          key="close"
          leftSection={closed ? <IconLockOpen size={14} /> : <IconLock size={14} />}
          onClick={() => actions.setWorkStreamClosed(stream, !closed)}
          aria-label={label(t(closed ? "plan.workStream.reopenAria" : "plan.workStream.closeAria", { name: stream.name }))}
        >
          {t(closed ? "plan.workStream.reopen" : "plan.workStream.close")}
        </Menu.Item>,
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importFromJira(stream)} aria-label={label(t("jira.import.entryAria", { name: stream.name }))}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  } else if (row.kind === "program") {
    const { stream, program } = row;
    if (program.can.edit) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editProgram(stream, program)} aria-label={label(t("common.action.editAria", { name: program.name }))}>
          {t("common.action.edit")}
        </Menu.Item>,
      );
    }
    if (actions.canMoveProgram(program)) {
      items.push(
        <Menu.Item key="move" leftSection={<IconArrowsExchange size={14} />} onClick={() => actions.moveProgram(program)} aria-label={label(t("plan.move.programAria", { name: program.name }))}>
          {t("plan.move.action")}
        </Menu.Item>,
      );
    }
    if (actions.canImportChildren(program)) {
      items.push(
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importChildren(program)} aria-label={label(t("jira.import.entryRootAria", { name: program.name }))}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  } else {
    const { program, project } = row;
    // The fields (`can.edit`) and the target window (`can.editTargetWindow`) are two rights; the editor offers whichever the caller holds.
    if (project.can.edit || project.can.editTargetWindow) {
      items.push(
        <Menu.Item key="edit" leftSection={<IconPencil size={14} />} onClick={() => actions.editProject(program, project)} aria-label={label(t("common.action.editAria", { name: project.name }))}>
          {t("common.action.edit")}
        </Menu.Item>,
      );
    }
    if (actions.canMoveProject(project)) {
      items.push(
        <Menu.Item key="move" leftSection={<IconArrowsExchange size={14} />} onClick={() => actions.moveProject(project)} aria-label={label(t("plan.move.projectAria", { name: project.name }))}>
          {t("plan.move.action")}
        </Menu.Item>,
      );
    }
    if (actions.canImportMilestones(project)) {
      items.push(
        <Menu.Item key="import" leftSection={<IconFileImport size={14} />} onClick={() => actions.importMilestones(project)} aria-label={label(t("jira.import.entryRootAria", { name: project.name }))}>
          {t("jira.import.entry")}
        </Menu.Item>,
      );
    }
  }
  return items;
}

/** Delete, alone in its group so the divider sets it apart. */
function deleteGroup(row: PlanTreeRow, actions: PlanActions, t: TFunction, label: Label): ReactNode[] {
  const node = row.kind === "workStream" ? row.stream : row.kind === "program" ? row.program : row.project;
  if (!node.can.delete) return [];
  const remove = () => (row.kind === "workStream" ? actions.deleteWorkStream(row.stream) : row.kind === "program" ? actions.deleteProgram(row.program) : actions.deleteProject(row.project));
  return [
    <DestructiveMenuItem key="delete" leftSection={<IconTrash size={14} />} onClick={remove} aria-label={label(t("common.action.deleteAria", { name: node.name }))}>
      {t("common.action.delete")}
    </DestructiveMenuItem>,
  ];
}

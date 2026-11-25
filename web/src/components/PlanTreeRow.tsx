import type { CSSProperties } from "react";
import { ActionIcon, Anchor, Badge, Group, Table, Text, Tooltip, UnstyledButton, VisuallyHidden } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { PlanActions } from "../utils/planActions";
import { projectPath } from "../utils/planLinks";
import { rowName, type NodeRow, type PlanTreeRow } from "../utils/planTree";
import classes from "../theme.module.css";
import PlanRowMenu from "./PlanRowMenu";

/** Where a row is drawn: the tree itself, or (later) the pinned section above it, which reuses this row. */
export type PlanScope = "tree" | "pinned";

/** The weight of a name by level: work stream 600, program 500, project 400. */
const WEIGHT = { workStream: 600, program: 500, project: 400 } as const;

/**
 * One row of the Plan table, whatever its level: a row header (indent, the name as a disclosure button when the node has children, the count of
 * what it holds, a "Closed" badge, one clamped dimmed description line), the owner, the dates, and the actions (a "+" for a new child, the row
 * menu). The row decides nothing: what is offered comes from the node's `can` flags through `PlanRowMenu` and the page's `actions`.
 */
export default function PlanTreeRow({ row, scope, actions, onToggle }: { row: PlanTreeRow; scope: PlanScope; actions: PlanActions; onToggle: (row: NodeRow) => void }) {
  const { t } = useTranslation();
  const node = row.kind === "workStream" ? row.stream : row.kind === "program" ? row.program : row.project;
  return (
    <Table.Tr
      className={classes.planTreeRow}
      data-scope={scope}
      data-key={row.key}
      data-parent={row.parentKey ?? undefined}
      data-kind={row.kind}
      data-context={row.context ? "true" : undefined}
    >
      <Table.Th scope="row" className={classes.planTreeName}>
        <div className={classes.planTreeIndent} style={{ "--plan-depth": row.depth } as CSSProperties}>
          <div className={classes.planTreeHead}>
            <RowName row={row} onToggle={onToggle} />
            {row.kind !== "project" && (
              <Text span size="xs" c="dimmed">
                {t(row.kind === "workStream" ? "plan.tree.programs" : "plan.tree.projects", { count: row.childCount })}
              </Text>
            )}
            {row.kind === "workStream" && row.stream.endDate !== null && <Badge color="gray">{t("plan.closed")}</Badge>}
          </div>
          {node.description && (
            <Text size="xs" c="dimmed" truncate="end" title={node.description} className={classes.planTreeDescription}>
              {node.description}
            </Text>
          )}
        </div>
      </Table.Th>
      <Table.Td>
        <Text size="sm">{node.ownerName}</Text>
      </Table.Td>
      <Table.Td>
        <Dates row={row} />
      </Table.Td>
      <Table.Td data-print="hide" ta="right" className={classes.planTreeActions}>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <NewChild row={row} actions={actions} />
          <PlanRowMenu row={row} actions={actions} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** The name: a disclosure button for a node with children, plain text (with its kind said to a screen reader) for a childless one, the link for a project. */
function RowName({ row, onToggle }: { row: PlanTreeRow; onToggle: (row: NodeRow) => void }) {
  const { t } = useTranslation();
  const name = rowName(row);
  if (row.kind === "project") {
    return (
      <span className={classes.planTreeLeaf}>
        <Anchor component={RouterLink} to={projectPath(row.project.id)} size="sm" fw={WEIGHT.project} aria-label={t("plan.openProjectAria", { name })}>
          {name}
        </Anchor>
      </span>
    );
  }
  // A childless work stream or program has nothing to fold: plain text, never a disclosure button.
  if (row.childCount === 0) {
    return (
      <span className={classes.planTreeLeaf}>
        <Text span size="sm" fw={WEIGHT[row.kind]}>
          <VisuallyHidden>{t(row.kind === "workStream" ? "plan.tree.streamKind" : "plan.tree.programKind")} </VisuallyHidden>
          {name}
        </Text>
      </span>
    );
  }
  return (
    <UnstyledButton
      className={classes.planTreeToggle}
      aria-expanded={row.expanded}
      aria-label={t(row.kind === "workStream" ? "plan.tree.streamAria" : "plan.tree.programAria", { name })}
      onClick={() => onToggle(row)}
    >
      {row.expanded ? <IconChevronDown size={16} aria-hidden="true" data-print="hide" /> : <IconChevronRight size={16} aria-hidden="true" data-print="hide" />}
      <Text span size="sm" fw={WEIGHT[row.kind]}>
        {name}
      </Text>
    </UnstyledButton>
  );
}

/** A work stream's start (and end once closed), a project's target window behind a hidden label; a program has no dates of its own. */
function Dates({ row }: { row: PlanTreeRow }) {
  const { t } = useTranslation();
  if (row.kind === "workStream") {
    const { startDate, endDate } = row.stream;
    return <Text size="sm">{endDate === null ? t("plan.datesOpen", { start: startDate }) : t("plan.window", { start: startDate, end: endDate })}</Text>;
  }
  if (row.kind === "program") return null;
  const { targetStart, targetEnd } = row.project;
  if (targetStart === null || targetEnd === null) {
    return (
      <Text size="sm" c="dimmed">
        <VisuallyHidden>{t("plan.tree.targetWindowLabel")} </VisuallyHidden>
        {t("plan.noWindow")}
      </Text>
    );
  }
  return (
    <>
      <VisuallyHidden>{t("plan.tree.targetWindowLabel")} </VisuallyHidden>
      <Text span size="sm">
        {t("plan.window", { start: targetStart, end: targetEnd })}
      </Text>
    </>
  );
}

/** The icon-only "+" of a work stream (a program) and of a program (a project), under today's accessible names. */
function NewChild({ row, actions }: { row: PlanTreeRow; actions: PlanActions }) {
  const { t } = useTranslation();
  if (row.kind === "workStream" && row.stream.can.createProgram) {
    const { stream } = row;
    return (
      <Tooltip label={t("plan.newProgram")}>
        <ActionIcon size="sm" aria-label={t("plan.newProgramAria", { name: stream.name })} onClick={() => actions.newProgram(stream)}>
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }
  if (row.kind === "program" && row.program.can.createProject) {
    const { program } = row;
    return (
      <Tooltip label={t("plan.newProject")}>
        <ActionIcon size="sm" aria-label={t("plan.newProjectAria", { name: program.name })} onClick={() => actions.newProject(program)}>
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }
  return null;
}

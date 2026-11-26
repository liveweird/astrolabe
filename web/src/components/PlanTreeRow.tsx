import type { CSSProperties } from "react";
import { ActionIcon, Anchor, Badge, Group, Table, Text, Tooltip, UnstyledButton, VisuallyHidden } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconPin, IconPinnedOff, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { PlanActions, PlanViewActions } from "../utils/planActions";
import { projectPath } from "../utils/planLinks";
import { foldedMatchRange } from "../utils/text";
import { scopedLabel, type PlanScope } from "../utils/planPins";
import { rowName, type NodeRow, type PlanTreeRow } from "../utils/planTree";
import classes from "../theme.module.css";
import PlanRowMenu from "./PlanRowMenu";

/** The weight of a name by level: work stream 600, program 500, project 400. */
const WEIGHT = { workStream: 600, program: 500, project: 400 } as const;

/**
 * One row of the Plan table, whatever its level: a row header (indent, the name as a disclosure button when the node has children, the count of
 * what it holds, a "Closed" badge, one clamped dimmed description line), the owner, the dates, and the actions (a "+" for a new child, the row
 * menu; in the pinned section a root also has an Unpin button, and every accessible name is wrapped, `scopedLabel`). The row decides nothing: what is offered comes from the node's `can` flags through `PlanRowMenu` and the page's `actions`.
 */
export default function PlanTreeRow({
  row,
  scope,
  root,
  actions,
  view,
  highlight,
  onToggle,
}: {
  row: PlanTreeRow;
  scope: PlanScope;
  /** In the pinned section: the key of the pinned root whose subtree the row belongs to (the row is that root when the keys are equal). */
  root?: string;
  actions: PlanActions;
  view: PlanViewActions;
  /** The text of the name search: where it sits in the name is marked. */
  highlight: string;
  onToggle: (row: NodeRow) => void;
}) {
  const { t } = useTranslation();
  const label = (text: string) => scopedLabel(t, scope, text);
  const node = row.kind === "workStream" ? row.stream : row.kind === "program" ? row.program : row.project;
  const pinnedRoot = scope === "pinned" && root === row.key;
  return (
    <Table.Tr
      className={classes.planTreeRow}
      data-scope={scope}
      data-root={root}
      data-key={row.key}
      data-parent={row.parentKey ?? undefined}
      data-kind={row.kind}
      data-context={row.context ? "true" : undefined}
    >
      <Table.Th scope="row" className={classes.planTreeName}>
        <div className={classes.planTreeIndent} style={{ "--plan-depth": row.indent } as CSSProperties}>
          <div className={classes.planTreeHead}>
            <RowName row={row} label={label} highlight={highlight} onToggle={onToggle} />
            {row.kind !== "project" && (
              <Text span size="xs" c="dimmed">
                {t(row.kind === "workStream" ? "plan.tree.programs" : "plan.tree.projects", { count: row.childCount })}
              </Text>
            )}
            {row.kind === "workStream" && row.stream.endDate !== null && <Badge color="gray">{t("plan.closed")}</Badge>}
            {/* A context row is dimmed by colour alone: this says in words that it is only the way to a match. */}
            {row.context && <VisuallyHidden>{t("plan.tree.contextCue")}</VisuallyHidden>}
            {scope === "tree" && view.isPinned(row.key) && (
              <Text span size="xs" c="dimmed" data-print="hide" title={t("plan.pin.marker")}>
                <IconPin size={12} aria-hidden="true" />
                <VisuallyHidden>{t("plan.pin.marker")}</VisuallyHidden>
              </Text>
            )}
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
          {pinnedRoot && (
            <Tooltip label={t("plan.pin.unpin")}>
              <ActionIcon size="sm" data-unpin-for={row.key} aria-label={label(t("plan.pin.unpinAria", { name: rowName(row) }))} onClick={() => view.releasePin(row.key, rowName(row))}>
                <IconPinnedOff size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <NewChild row={row} label={label} actions={actions} />
          <PlanRowMenu row={row} scope={scope} opsId={scope === "tree" ? `tree:${row.key}` : `pin:${root}>${row.key}`} actions={actions} view={view} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** The name: a disclosure button for a node with children, plain text (with its kind said to a screen reader) for a childless one, the link for a project. */
function RowName({ row, label, highlight, onToggle }: { row: PlanTreeRow; label: (text: string) => string; highlight: string; onToggle: (row: NodeRow) => void }) {
  const { t } = useTranslation();
  const name = rowName(row);
  const shown = <Highlighted text={name} query={highlight} />;
  if (row.kind === "project") {
    return (
      <span className={classes.planTreeLeaf}>
        <Anchor component={RouterLink} to={projectPath(row.project.id)} size="sm" fw={WEIGHT.project} aria-label={label(t("plan.openProjectAria", { name }))}>
          {shown}
        </Anchor>
      </span>
    );
  }
  // A childless work stream or program has nothing to fold, and the root of a focus is always open: plain text, never a disclosure button.
  if (row.childCount === 0 || row.locked) {
    return (
      <span className={classes.planTreeLeaf}>
        <Text span size="sm" fw={WEIGHT[row.kind]}>
          <VisuallyHidden>{t(row.kind === "workStream" ? "plan.tree.streamKind" : "plan.tree.programKind")} </VisuallyHidden>
          {shown}
        </Text>
      </span>
    );
  }
  return (
    <UnstyledButton
      className={classes.planTreeToggle}
      aria-expanded={row.expanded}
      aria-label={label(t(row.kind === "workStream" ? "plan.tree.streamAria" : "plan.tree.programAria", { name }))}
      onClick={() => onToggle(row)}
    >
      {row.expanded ? <IconChevronDown size={16} aria-hidden="true" data-print="hide" /> : <IconChevronRight size={16} aria-hidden="true" data-print="hide" />}
      <Text span size="sm" fw={WEIGHT[row.kind]}>
        {shown}
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
function NewChild({ row, label, actions }: { row: PlanTreeRow; label: (text: string) => string; actions: PlanActions }) {
  const { t } = useTranslation();
  if (row.kind === "workStream" && row.stream.can.createProgram) {
    const { stream } = row;
    return (
      <Tooltip label={t("plan.newProgram")}>
        <ActionIcon size="sm" aria-label={label(t("plan.newProgramAria", { name: stream.name }))} onClick={() => actions.newProgram(stream)}>
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }
  if (row.kind === "program" && row.program.can.createProject) {
    const { program } = row;
    return (
      <Tooltip label={t("plan.newProject")}>
        <ActionIcon size="sm" aria-label={label(t("plan.newProjectAria", { name: program.name }))} onClick={() => actions.newProject(program)}>
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }
  return null;
}

/** The name with the letters the search matched marked (case- and accent-insensitive, as the search itself); plain when nothing is searched. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const range = foldedMatchRange(text, query);
  if (range === null) return text;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className={classes.planTreeMark}>{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

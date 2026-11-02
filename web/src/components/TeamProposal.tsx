import { useEffect, useRef, type Ref } from "react";
import { Anchor, Badge, Button, Checkbox, Group, Stack, Table, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ScheduleProposal, ScheduleProposalMove, ScheduleProposalUnplaced } from "../api/teams";
import classes from "../theme.module.css";
import { projectPath } from "../utils/planLinks";
import { changeSentence, endpointText, linksAtMove, linkTotals, newlyScheduledCount, PROPOSAL_HORIZON_WEEKS, requiredEdge, type LinkAtMove } from "../utils/scheduleProposal";
import FormErrorAlert from "./FormErrorAlert";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;
const COLUMNS = 6;

/** The summary line and the link badges: the figures of the whole proposal; the red badge is what the proposal would newly break. */
function Summary({ proposal }: { proposal: ScheduleProposal }) {
  const { t } = useTranslation();
  const { newlyViolated, stillViolated } = linkTotals(proposal.dependencies);
  const figures = [
    t("teams.proposal.summary.moves", { count: proposal.moves.length }),
    t("teams.proposal.summary.newly", { count: newlyScheduledCount(proposal.moves) }),
    t("teams.proposal.summary.stay", { count: proposal.unchanged.length }),
    t("teams.proposal.summary.unplaced", { count: proposal.unplaced.length }),
  ].join(" · ");
  return (
    <Group gap="sm" align="center">
      <Text size="sm">{figures}</Text>
      {newlyViolated > 0 && (
        <Badge color="red" variant="light" tt="none" miw="max-content">
          {t("teams.proposal.badge.violated", { count: newlyViolated })}
        </Badge>
      )}
      {stillViolated > 0 && (
        <Badge color="gray" variant="light" tt="none" miw="max-content">
          {t("teams.proposal.badge.stillViolated", { count: stillViolated })}
        </Badge>
      )}
    </Group>
  );
}

/** The milestone's name with its project as the way into the project page (the team timeline's own link, same accessible name). */
function MilestoneCell({ name, projectId, projectName }: { name: string; projectId: number; projectName: string }) {
  const { t } = useTranslation();
  return (
    <Stack gap={0}>
      <Text size="sm" fw={500}>
        {name}
      </Text>
      <Anchor component={RouterLink} to={projectPath(projectId)} size="xs" aria-label={t("teams.view.openProjectAria", { name: projectName })}>
        {projectName}
      </Anchor>
    </Stack>
  );
}

const VIOLATION_KEYS = {
  successor: { start: "teams.proposal.links.violatesSuccessorStart", end: "teams.proposal.links.violatesSuccessorEnd" },
  predecessor: { start: "teams.proposal.links.violatesPredecessorStart", end: "teams.proposal.links.violatesPredecessorEnd" },
} as const;

/** "would violate: Web › Checkout page must start on 2042-02-26 or later" (start or end by the link type) in red with a red badge. */
function ViolatedLink({ entry }: { entry: LinkAtMove }) {
  const { t } = useTranslation();
  const name = endpointText(entry.other);
  const date = entry.link.check.requiredDate ?? "–";
  return (
    <Group gap={6} align="flex-start" wrap="nowrap">
      <Badge color="red" variant="light" tt="none" miw="max-content">
        {t("teams.proposal.links.badge")}
      </Badge>
      <Text size="sm" className={classes.proposalViolation}>
        {t(VIOLATION_KEYS[entry.thisIsPredecessor ? "successor" : "predecessor"][requiredEdge(entry.link.type)], { name, date })}
      </Text>
    </Group>
  );
}

/** The Links cell of a move: the links it newly breaks (red) and the violated ones it mends (gray); nothing when none changes. */
function LinksCell({ proposal, move }: { proposal: ScheduleProposal; move: ScheduleProposalMove }) {
  const { t } = useTranslation();
  const { violates, resolves } = linksAtMove(proposal.dependencies, move);
  return (
    <Stack gap={4}>
      {violates.map((entry) => (
        <ViolatedLink key={entry.link.id} entry={entry} />
      ))}
      {resolves.map((entry) => (
        <Text key={entry.link.id} size="sm" c="dimmed">
          {t("teams.proposal.links.resolves", { name: endpointText(entry.other) })}
        </Text>
      ))}
    </Stack>
  );
}

function MoveRow({
  proposal,
  move,
  checked,
  disabled,
  onToggle,
}: {
  proposal: ScheduleProposal;
  move: ScheduleProposalMove;
  checked: boolean;
  disabled: boolean;
  onToggle: (milestoneId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Checkbox checked={checked} disabled={disabled} onChange={() => onToggle(move.milestoneId)} aria-label={t("teams.proposal.acceptRowAria", { name: move.name })} />
      </Table.Td>
      <Table.Td>
        <MilestoneCell name={move.name} projectId={move.projectId} projectName={move.projectName} />
      </Table.Td>
      <Table.Td style={NO_WRAP}>{move.from === null ? t("teams.proposal.unscheduled") : t("teams.proposal.span", { start: move.from.start, end: move.from.end })}</Table.Td>
      <Table.Td style={NO_WRAP}>
        {t("teams.proposal.span", { start: move.to.start, end: move.to.end })}
        <Text size="xs" c="dimmed">
          {t("teams.proposal.days", { count: move.workingDays })}
        </Text>
      </Table.Td>
      <Table.Td>{changeSentence(move, t)}</Table.Td>
      <Table.Td>
        <LinksCell proposal={proposal} move={move} />
      </Table.Td>
    </Table.Tr>
  );
}

/** The milestones the proposal could not place, each with the reason in words; they have no checkbox (there is nothing to accept). */
function UnplacedRows({ unplaced, asOf }: { unplaced: readonly ScheduleProposalUnplaced[]; asOf: string }) {
  const { t } = useTranslation();
  return (
    <Table.Tbody>
      <Table.Tr>
        <Table.Th colSpan={COLUMNS} scope="rowgroup">
          {t("teams.proposal.unplaced.title")}
        </Table.Th>
      </Table.Tr>
      {unplaced.map((entry) => (
        <Table.Tr key={entry.milestoneId}>
          <Table.Td aria-hidden />
          <Table.Td>
            <MilestoneCell name={entry.name} projectId={entry.projectId} projectName={entry.projectName} />
          </Table.Td>
          <Table.Td colSpan={COLUMNS - 2}>{t(`teams.proposal.unplaced.${entry.reason}`, { date: asOf, weeks: PROPOSAL_HORIZON_WEEKS })}</Table.Td>
        </Table.Tr>
      ))}
    </Table.Tbody>
  );
}

/**
 * The Proposed schedule section of the team page (v0.8): the whole proposal in words and figures beside the dashed bars, and the way to
 * take some or all of it. A summary line with the link badges, the table of moves (a checkbox per move, "Accept all" in the header,
 * indeterminate while only some are ticked), the milestones that could not be placed, and the actions Accept selected / Discard.
 * Controlled: the page's `useScheduleProposal` owns the selection and the requests; the server decided every date and every link verdict.
 * `busy` disables the accept (another write of the page is running); `applying` is this accept in flight (spinner, nothing else clicks).
 */
export default function TeamProposal({
  proposal,
  selected,
  busy,
  applying,
  onToggle,
  onSelectAll,
  onSelectNone,
  onAccept,
  onDiscard,
  discardRef,
  error,
}: {
  proposal: ScheduleProposal;
  selected: ReadonlySet<number>;
  busy: boolean;
  applying: boolean;
  onToggle: (milestoneId: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  discardRef?: Ref<HTMLButtonElement>;
  /** The inline failure of the last accept (already words), or `null`; shown above the actions, and it takes the focus when it appears. */
  error?: string | null;
}) {
  const { t } = useTranslation();
  const errorRef = useRef<HTMLDivElement>(null);
  // The accept button was the focus and is disabled while the write runs, so a failure would leave the focus on the body: it goes to the alert.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const total = proposal.moves.length;
  const all = total > 0 && selected.size === total;
  const label = t("teams.proposal.tableAria");
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("teams.proposal.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("teams.proposal.intro")}
      </Text>
      <Summary proposal={proposal} />
      <ScrollRegion label={label} minWidth={920} maxHeight={TABLE_MAX_HEIGHT}>
        <Table aria-label={label} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <VisuallyHidden>{t("teams.proposal.column.accept")}</VisuallyHidden>
                <Checkbox
                  checked={all}
                  indeterminate={selected.size > 0 && !all}
                  disabled={total === 0 || applying}
                  onChange={all ? onSelectNone : onSelectAll}
                  aria-label={t("teams.proposal.acceptAll")}
                />
              </Table.Th>
              <Table.Th>{t("teams.proposal.column.milestone")}</Table.Th>
              <Table.Th>{t("teams.proposal.column.current")}</Table.Th>
              <Table.Th>{t("teams.proposal.column.proposed")}</Table.Th>
              <Table.Th>{t("teams.proposal.column.change")}</Table.Th>
              <Table.Th>{t("teams.proposal.column.links")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {proposal.moves.map((move) => (
              <MoveRow key={move.milestoneId} proposal={proposal} move={move} checked={selected.has(move.milestoneId)} disabled={applying} onToggle={onToggle} />
            ))}
          </Table.Tbody>
          {proposal.unplaced.length > 0 && <UnplacedRows unplaced={proposal.unplaced} asOf={proposal.asOf} />}
        </Table>
      </ScrollRegion>
      {error && (
        <FormErrorAlert ref={errorRef} tabIndex={-1}>
          {error}
        </FormErrorAlert>
      )}
      <Group gap="sm">
        <Button leftSection={<IconCheck size={16} />} loading={applying} disabled={selected.size === 0 || busy} onClick={onAccept}>
          {t("teams.proposal.accept", { count: selected.size })}
        </Button>
        <Button ref={discardRef} variant="default" leftSection={<IconX size={16} />} disabled={applying} onClick={onDiscard}>
          {t("teams.proposal.discard")}
        </Button>
      </Group>
    </Stack>
  );
}

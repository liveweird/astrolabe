import { Anchor, Badge, Checkbox, Group, Stack, Table, Text, VisuallyHidden } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ScheduleProposalMove, ScheduleProposalUnplaced } from "../api/teams";
import classes from "../theme.module.css";
import { projectPath } from "../utils/planLinks";
import {
  changeSentence,
  endpointText,
  linksAtMove,
  linkTotals,
  newlyScheduledCount,
  PROPOSAL_HORIZON_WEEKS,
  requiredEdge,
  type LinkAtMove,
  type ProposalContent,
  type ScheduleCheckState,
} from "../utils/scheduleProposal";
import ScrollRegion from "./ScrollRegion";

/** The part of the ticked-subset check the table words: it is on its way, or it failed. */
type ProposalCheckNote = Pick<ScheduleCheckState, "pending" | "failed">;

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;
const COLUMNS = 6;

/** The summary line and the link badges: the figures of the whole proposal; the red badge is what the proposal would newly break. */
function Summary({ proposal, check }: { proposal: ProposalContent; check?: ProposalCheckNote }) {
  const { t } = useTranslation();
  const { newlyViolated, stillViolated } = linkTotals(proposal.dependencies);
  const figures = [
    t("teams.proposal.summary.moves", { count: proposal.moves.length }),
    t("teams.proposal.summary.newly", { count: newlyScheduledCount(proposal.moves) }),
    t("teams.proposal.summary.stay", { count: proposal.unchanged.length }),
    t("teams.proposal.summary.unplaced", { count: proposal.unplaced.length }),
    // 1.7: the pinned milestones the proposal keeps on their dates (they are in neither the moves nor the stays).
    ...(proposal.pinned.length > 0 ? [t("teams.proposal.summary.pinnedCount", { count: proposal.pinned.length })] : []),
  ].join(" · ");
  return (
    <Stack gap={4}>
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
      {proposal.pinned.length > 0 && (
        <Text size="sm" c="dimmed">
          {t("teams.proposal.summary.pinned", { count: proposal.pinned.length })}
        </Text>
      )}
      {/* Visible only: the verdicts are the proposal's own (all moves accepted) while the ticked subset's check is on its way or has failed. */}
      {check?.failed ? (
        <Text size="sm" c="dimmed">
          {t("teams.proposal.checkFailed")}
        </Text>
      ) : (
        check?.pending && (
          <Text size="sm" c="dimmed">
            {t("teams.proposal.checking")}
          </Text>
        )
      )}
    </Stack>
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
function LinksCell({ proposal, move }: { proposal: ProposalContent; move: ScheduleProposalMove }) {
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
  proposal: ProposalContent;
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
 * The table of a proposal (v0.8; extracted in 1.8 so the cross-team page composes one per team): the summary line with the link badges,
 * the moves (a checkbox per move, "Accept all" in the header, indeterminate while only some of THESE moves are ticked) and the milestones
 * that could not be placed. Controlled, with no actions of its own: the owner holds the selection and the buttons. `check` words the
 * state of the ticked-subset check under the summary; the server decided every date and every link verdict.
 */
export default function ProposalTable({
  proposal,
  selected,
  applying,
  onToggle,
  onSelectAll,
  onSelectNone,
  check,
}: {
  proposal: ProposalContent;
  selected: ReadonlySet<number>;
  applying: boolean;
  onToggle: (milestoneId: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  check?: ProposalCheckNote;
}) {
  const { t } = useTranslation();
  const total = proposal.moves.length;
  // Counted over THIS table's moves: a selection held for several tables (the cross-team page) is wider than one table.
  const ticked = proposal.moves.filter((move) => selected.has(move.milestoneId)).length;
  const all = total > 0 && ticked === total;
  const label = t("teams.proposal.tableAria");
  return (
    <>
      <Summary proposal={proposal} check={check} />
      <ScrollRegion label={label} minWidth={920} maxHeight={TABLE_MAX_HEIGHT}>
        <Table aria-label={label} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <VisuallyHidden>{t("teams.proposal.column.accept")}</VisuallyHidden>
                <Checkbox
                  checked={all}
                  indeterminate={ticked > 0 && !all}
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
    </>
  );
}

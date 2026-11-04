import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Alert, Badge, Button, Group, Loader, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconCalendarStats, IconPencil, IconRestore, IconWand } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import type { TeamMilestone, TeamView } from "../api/teams";
import { useAdmin } from "../auth";
import BaselineMovement from "../components/BaselineMovement";
import { PickedLoadState } from "../components/BaselineParts";
import BaselinePicker from "../components/BaselinePicker";
import ConfirmActionModal from "../components/ConfirmActionModal";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import MilestoneScheduleModal from "../components/MilestoneScheduleModal";
import PageHeader from "../components/PageHeader";
import TeamCapacity from "../components/TeamCapacity";
import TeamEditorModal from "../components/TeamEditorModal";
import TeamProposal from "../components/TeamProposal";
import TeamTimeline, { TeamTray, type TeamActions } from "../components/TeamTimeline";
import IdleGaps from "../components/IdleGaps";
import TeamWeeklyLoad from "../components/TeamWeeklyLoad";
import TimelineDndContext from "../components/TimelineDndContext";
import { useBaselinePick, useDropUnknownPick } from "../hooks/useBaselinePick";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { isOneOf, useStoredState } from "../hooks/useStoredState";
import { useProposalLock } from "../hooks/useProposalLock";
import { useScheduleProposal } from "../hooks/useScheduleProposal";
import { useTeamOrder } from "../hooks/useTeamOrder";
import { useTeamSchedule } from "../hooks/useTeamSchedule";
import { baselineDays } from "../utils/baselineOverlay";
import { localIsoDate } from "../utils/isoDate";
import { conflictCountOf } from "../utils/dependencyArrows";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage } from "../utils/saveError";
import { outcomeSentence, proposalDays } from "../utils/scheduleProposal";
import { teamsPath } from "../utils/teamLinks";
import { dropOutcome } from "../utils/timelineDrag";
import { defaultRange, makeScale, MILESTONE_ZOOMS, toEpochDay, type Zoom } from "../utils/timelineScale";

/** The schedule dialog remembers the plan revision of the view it was opened on: its save must stale-409 if THIS milestone moved since. */
type Scheduling = { milestone: TeamMilestone; revision: number };

/**
 * The facts line under the title: how many milestones the team has and how many are scheduled, then the warnings — ORANGE badges for
 * the overloaded weeks and the weeks over the WIP limit (warnings, nothing moves), the RED badge for the violated dependencies (as on
 * the project page) and a gray one while the team's own order is in force.
 */
function TeamFacts({ view }: { view: TeamView }) {
  const { t } = useTranslation();
  const overloaded = view.weeks.filter((week) => week.overloaded).length;
  const wip = view.weeks.filter((week) => week.wipExceeded).length;
  const conflicts = conflictCountOf(view.dependencies);
  return (
    <Group gap="md" role="group" aria-label={t("teams.view.factsAria")}>
      <Text size="sm">{t("teams.view.milestones", { count: view.scheduled.length + view.unscheduled.length })}</Text>
      <Text size="sm">{t("teams.view.scheduledCount", { count: view.scheduled.length })}</Text>
      {overloaded > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("teams.view.overloadedWeeks", { count: overloaded })}
        </Badge>
      )}
      {wip > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("teams.view.wipWeeks", { count: wip })}
        </Badge>
      )}
      {conflicts > 0 && (
        <Badge color="red" variant="light" tt="none">
          {t("project.conflicts", { count: conflicts })}
        </Badge>
      )}
      {view.idleGaps.length > 0 && (
        <Badge color="gray" variant="light" tt="none">
          {t("timeline.idle.badge", { count: view.idleGaps.length })}
        </Badge>
      )}
      {view.order.custom && (
        <Badge color="gray" variant="light" tt="none">
          {t("teams.view.customOrder")}
        </Badge>
      )}
    </Group>
  );
}

type Proposal = ReturnType<typeof useScheduleProposal>;

/**
 * What the proposal flow says outside the section, as dismissible notes that last until the next action: a proposal that opened nothing
 * ("nothing to propose" gray, "no capacity: add a capacity period first" orange), what an accept came to (green; orange when something
 * was skipped, with the server's reasons), the whole-batch stale notice and the re-proposed-after-a-scope-change notice (orange), and the inline failure of a propose or an accept.
 * Visible only (`role="note"`): the page's status region says each, so an Alert's implicit `role="alert"` would read it twice.
 */
function ProposalNotes({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { note, outcome, stale, rescoped } = proposal;
  const open = proposal.proposal;
  const dismissible = { variant: "light", role: "note", withCloseButton: true, closeButtonLabel: t("common.action.close"), onClose: proposal.dismiss } as const;
  return (
    <>
      {note !== null && (
        <Alert color={note === "noCapacity" ? "orange" : "gray"} {...dismissible}>
          {note === "noCapacity" ? t("teams.proposal.noCapacity", { date: proposal.noteDate }) : t("teams.proposal.nothing")}
        </Alert>
      )}
      {outcome !== null && (
        <Alert color={outcome.skipped.length > 0 ? "orange" : "green"} {...dismissible}>
          {outcomeSentence(outcome, t)}
        </Alert>
      )}
      {stale && (
        <Alert color="orange" {...dismissible}>
          {t("teams.proposal.stale")}
        </Alert>
      )}
      {rescoped && (
        <Alert color="orange" {...dismissible}>
          {t("teams.proposal.rescoped")}
        </Alert>
      )}
      {/* An accept's failure sits inside the open section; this is a propose's, shown while no preview is open. */}
      {open === null && proposal.error && <FormErrorAlert>{proposal.error}</FormErrorAlert>}
    </>
  );
}

/**
 * The timeline header's buttons: Propose schedule (only with `team.can.schedule`; disabled while a proposal is open or a write runs,
 * `loading` while it is requested) and Reset order (`team.can.editOrder`, hidden while a proposal is open). Discard lives in the
 * Proposed schedule section.
 */
function TimelineButtons({
  view,
  proposal,
  busy,
  proposeRef,
  onReset,
}: {
  view: TeamView;
  proposal: Proposal;
  busy: boolean;
  proposeRef: RefObject<HTMLButtonElement | null>;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { can } = view.team;
  const open = proposal.proposal;
  return (
    <Group gap="sm" align="center">
      {can.schedule && (
        <Button
          ref={proposeRef}
          variant="default"
          size="compact-md"
          leftSection={<IconWand size={16} />}
          loading={proposal.requesting}
          disabled={open !== null || busy}
          onClick={proposal.propose}
        >
          {t("teams.proposal.propose")}
        </Button>
      )}
      {can.editOrder && open === null && (
        <Button variant="default" size="compact-md" leftSection={<IconRestore size={16} />} disabled={!view.order.custom || busy} onClick={onReset}>
          {t("teams.view.action.resetOrder")}
        </Button>
      )}
    </Group>
  );
}

/**
 * The team view (`/teams/:id`): the team's facts, its scheduled milestones on the shared timeline under the weekly load strip, the
 * Unscheduled tray, the Capacity section and the Weekly load table (the strip's accessible surface). What each control offers comes
 * from the view's `team.can:{…}` flags, never the session's roles: the team's manager or an ADMIN schedules, orders and edits the
 * capacity. Two write paths: the dates (`useTeamSchedule`, the project view's, generalised) and the team's order (`useTeamOrder`, its
 * OWN revision). The project rank is only the DEFAULT order; a manager's override is never reshuffled by a rank change. Everyone reads it.
 */
export default function TeamDetails() {
  const { id } = useParams();
  // Keyed by the id: another team's page starts from its own range and editors.
  return <TeamPage key={id} id={Number(id)} />;
}

function TeamPage({ id }: { id: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const admin = useAdmin();
  // v0.9: the baseline pick (one for every timeline page) keys the view's query - and so every write path's optimistic step; the typed 400
  // "unknown baseline" clears it.
  const { pick, setPick } = useBaselinePick();
  const schedule = useTeamSchedule(id, pick);
  const { view, query } = schedule;
  const dropping = useDropUnknownPick(query.error, pick, setPick);
  const order = useTeamOrder(id, view, schedule.announce, pick, schedule.placeholder);
  const proposal = useScheduleProposal(id, schedule.announce, schedule.placeholder);
  const lock = useProposalLock(proposal, schedule.announce);
  const { open, locked } = lock;
  const writing = schedule.pending || order.pending;
  const busy = writing || proposal.requesting;
  // Focus follows the preview: Discard (in the section) takes it when a proposal opens, Propose gets it back once the preview is closed
  // (discarded, accepted or voided by a stale refusal) and no write is running any more, since a button that is still disabled cannot take it.
  const proposeRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const isOpen = open !== null;
  // Discard takes the focus when a preview opens, but only once the accept is no longer running (a disabled button cannot take it): a
  // preview that opens while `applying` (a fresh proposal after a stale-scope refusal) waits for it. A failed accept never re-arms this,
  // so its inline alert keeps the focus it was given.
  const focusDiscard = useRef(false);
  const applying = proposal.applying;
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      focusDiscard.current = true;
    }
  }, [isOpen]);
  // The fresh preview of a stale-scope refusal may replace the voided one within one render batch (`isOpen` stays true): its note
  // appearing arms the hand-over as well.
  const rescoped = proposal.rescoped;
  useEffect(() => {
    if (rescoped) focusDiscard.current = true;
  }, [rescoped]);
  useEffect(() => {
    if (isOpen && !applying && focusDiscard.current) {
      focusDiscard.current = false;
      discardRef.current?.focus();
    }
  }, [isOpen, applying, rescoped]);
  useEffect(() => {
    if (!isOpen && wasOpen.current && !busy) {
      wasOpen.current = false;
      proposeRef.current?.focus();
    }
  }, [isOpen, busy]);
  const [zoom, setZoom] = useStoredState<Zoom>("timeline.zoom", "week", isOneOf(MILESTONE_ZOOMS));
  const [editing, setEditing] = useState(false);
  useDialogFocus(editing);
  const [scheduling, setScheduling] = useState<Scheduling | null>(null);
  useDialogFocus(scheduling !== null);
  const [confirmReset, setConfirmReset] = useState(false);
  // The earliest and latest day this page has shown: the range only ever grows, so a drag never shifts the bars under the pointer.
  const [seen, setSeen] = useState<{ min: string; max: string } | null>(null);
  // "Today" is the viewer's own calendar day (their local date), not UTC: the today line and the Schedule button agree with their wall calendar.
  const today = localIsoDate();

  if (!view) {
    const notFound = !Number.isInteger(id) || (query.error instanceof ApiError && query.error.status === 404);
    return (
      <PickedLoadState
        isLoading={query.isLoading}
        message={notFound ? t("teams.notFound") : loadErrorMessage(query.error, t)}
        backTo={teamsPath}
        backLabel={t("teams.backToTeams")}
        title={t("teams.title")}
        pick={pick}
        isError={query.isError}
        dropping={dropping}
        notFound={notFound}
        onClearPick={() => setPick(null)}
      />
    );
  }

  const { team } = view;
  // Every day the page shows: the scheduled milestones (the weekly strip lies inside their span by construction) and, while a proposal
  // previews, every proposed span (so the range only grows and no proposed bar sits outside it).
  const dates = [...view.scheduled.flatMap((m) => [m.startDate, m.endDate]), ...(open === null ? [] : proposalDays(open.moves)), ...baselineDays(view.baseline)].filter(
    (d): d is string => d !== null,
  );
  if (dates.length > 0) {
    const min = dates.reduce((a, b) => (b < a ? b : a));
    const max = dates.reduce((a, b) => (b > a ? b : a));
    if (seen === null || min < seen.min || max > seen.max) setSeen({ min: seen !== null && seen.min < min ? seen.min : min, max: seen !== null && seen.max > max ? seen.max : max });
  }
  const scale = makeScale(zoom, defaultRange(seen === null ? [] : [seen.min, seen.max], today, zoom));

  // The schedule and the order are read-only while locked: every entry point (menu, tray, dialog, drag, Reset) refuses out loud instead.
  if (locked && scheduling !== null) setScheduling(null);
  if (locked && confirmReset) setConfirmReset(false);

  /** The Schedule button: one calendar week from today (the tray's pointer drop uses the same week; a team has no target window). */
  const scheduleByButton = (milestone: TeamMilestone) => {
    const span = dropOutcome("tray", null, 0, toEpochDay(today));
    if (span !== null) schedule.commit(milestone.id, span.start, span.end, { announce: true });
  };

  /** The dialog closes once its change is taken, or when its milestone is gone (nothing left to edit); a refusal keeps it open, saying so inside. */
  const commitFromDialog = lock.guarded((target: Scheduling, start: string | null, end: string | null) => {
    const taken = schedule.commit(target.milestone.id, start, end, { announce: true, revision: target.revision, ownRefusalAlert: true });
    if (taken || !schedule.has(target.milestone.id)) setScheduling(null);
  });

  const actions: TeamActions = {
    editSchedule: lock.guarded((milestone: TeamMilestone) => setScheduling({ milestone, revision: view.revision })),
    unschedule: lock.guarded((milestone: TeamMilestone) => schedule.commit(milestone.id, null, null, { announce: true })),
    schedule: lock.guarded(scheduleByButton),
    move: lock.guarded((milestone: TeamMilestone, delta: -1 | 1) => order.move(milestone.id, delta)),
    moveTo: lock.guarded((milestone: TeamMilestone, edge: "top" | "bottom") => order.moveTo(milestone.id, edge)),
  };
  const milestoneCount = view.scheduled.length + view.unscheduled.length;
  // The dialog closes only once the reset was TAKEN: while a write is running it stays open and says so (a modal's content is all a screen reader reads).
  const resetOrder = lock.guarded(() => {
    if (order.reset()) setConfirmReset(false);
  });

  return (
    <Stack gap="md">
      <PageHeader
        title={team.name}
        description={
          <>
            {team.description && (
              <Text span display="block">
                {team.description}
              </Text>
            )}
            <Text span display="block">
              {team.managerName ? t("teams.managerLine", { name: team.managerName }) : t("teams.noManager")}
            </Text>
          </>
        }
        backTo={{ to: teamsPath, label: t("teams.backToTeams") }}
        actions={
          admin && (
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
              {t("common.action.edit")}
            </Button>
          )
        }
      />
      <TeamFacts view={view} />

      {query.isError && <ErrorAlert error={query.error} title={t("teams.view.loadFailed")} />}
      {/* The notices below are visible only: the status region below says them (an Alert's implicit role="alert" would read each twice). */}
      {(schedule.refused || order.refused || proposal.refused) && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {lock.refused && (
        <Alert color="orange" variant="light" role="note">
          {open !== null ? t("teams.proposal.readOnly") : t("project.busy")}
        </Alert>
      )}
      {schedule.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("project.milestoneGone")}
        </Alert>
      )}
      {order.stale && (
        <Alert color="orange" variant="light" role="note">
          {t("teams.view.orderStale")}
        </Alert>
      )}
      {schedule.stale && <FormErrorAlert>{t("project.stale")}</FormErrorAlert>}
      {schedule.error && <FormErrorAlert>{schedule.error}</FormErrorAlert>}
      {order.error && <FormErrorAlert>{order.error}</FormErrorAlert>}
      {/* Button- and dialog-driven changes (schedule, order) are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {schedule.announcement}
      </VisuallyHidden>

      {milestoneCount === 0 ? (
        <EmptyState icon={IconCalendarStats} label={t("teams.view.noMilestones")} hint={t("teams.view.noMilestonesHint")} />
      ) : (
        <TimelineDndContext
          scale={scale}
          onSchedule={(barId, start, end) => (locked ? lock.refuse() : schedule.commit(Number(barId), start, end))}
          onReorder={(barId, slot) => (locked ? lock.refuse() : order.dropAt(Number(barId), slot))}
        >
          <Stack gap="xs">
            <Group gap="sm" align="center" justify="space-between">
              <Group gap="sm" align="center">
                <Title order={3} size="h4">
                  {t("teams.view.timelineTitle")}
                </Title>
                {writing && (
                  <Group gap={6} role="status">
                    <Loader size="xs" />
                    <Text size="sm" c="dimmed">
                      {t("project.saving")}
                    </Text>
                  </Group>
                )}
              </Group>
              <TimelineButtons view={view} proposal={proposal} busy={busy} proposeRef={proposeRef} onReset={() => setConfirmReset(true)} />
            </Group>
            <ProposalNotes proposal={proposal} />
            <TeamTimeline
              view={view}
              scale={scale}
              onZoomChange={setZoom}
              today={today}
              busy={busy}
              actions={actions}
              label={t("teams.view.timelineAria")}
              proposal={open ?? undefined}
              toolbar={<BaselinePicker pick={pick} onPick={setPick} current={view.baseline} disabled={busy || locked} />}
            />
          </Stack>
          {open !== null && (
            <TeamProposal
              proposal={open}
              selected={proposal.selected}
              busy={busy}
              applying={proposal.applying}
              onToggle={proposal.toggle}
              onSelectAll={proposal.selectAll}
              onSelectNone={proposal.selectNone}
              onAccept={proposal.accept}
              onDiscard={proposal.discard}
              discardRef={discardRef}
              error={proposal.error}
            />
          )}
          <Stack gap="xs">
            <Title order={3} size="h4">
              {t("project.unscheduledTitle")}
            </Title>
            {view.unscheduled.length > 0 && (
              <Text size="sm" c="dimmed">
                {team.can.schedule ? t("project.trayIntro") : t("project.trayIntroReadOnly")}
              </Text>
            )}
            <TeamTray view={view} actions={actions} label={t("teams.view.trayAria")} previewing={open !== null} />
          </Stack>
        </TimelineDndContext>
      )}

      <TeamCapacity view={view} readOnly={locked} />
      <TeamWeeklyLoad weeks={view.weeks} truncated={view.weeksTruncated} />
      {view.scheduled.length > 0 && <IdleGaps gaps={view.idleGaps} scope="team" />}
      {/* v0.9: the accessible surface of the shadow bars, present while a baseline is picked. */}
      {view.baseline !== undefined && <BaselineMovement baseline={view.baseline} live={[...view.scheduled, ...view.unscheduled]} scope="team" />}

      {editing && (
        <TeamEditorModal
          target={team}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refreshQueriesAfterMutation(queryClient, ["teams"], ["plan"]);
          }}
        />
      )}
      {scheduling !== null && !locked && (
        <MilestoneScheduleModal
          milestone={scheduling.milestone}
          refused={schedule.refused}
          onSchedule={(start, end) => commitFromDialog(scheduling, start, end)}
          onUnschedule={() => commitFromDialog(scheduling, null, null)}
          onClose={() => setScheduling(null)}
        />
      )}
      <ConfirmActionModal
        opened={confirmReset && !locked}
        onClose={() => setConfirmReset(false)}
        title={t("teams.view.resetTitle")}
        message={
          <>
            {t("teams.view.resetBody")}
            {order.refused && (
              <Text span display="block" mt="xs" role="alert">
                {t("project.busy")}
              </Text>
            )}
          </>
        }
        cancelLabel={t("common.action.cancel")}
        confirmLabel={t("teams.view.action.resetConfirm")}
        onConfirm={resetOrder}
        confirmColor="astrolabe"
      />
    </Stack>
  );
}

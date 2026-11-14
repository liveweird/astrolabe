import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Group, Stack, Text } from "@mantine/core";
import { IconCalendarStats } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import type { TeamMilestone } from "../api/teams";
import { useAdmin } from "../auth";
import BaselineMovement from "../components/BaselineMovement";
import { PickedLoadState } from "../components/BaselineParts";
import BaselinePicker from "../components/BaselinePicker";
import CriticalPathToggle from "../components/CriticalPathToggle";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import MilestoneScheduleModal from "../components/MilestoneScheduleModal";
import TeamCapacity from "../components/TeamCapacity";
import TeamEditorModal from "../components/TeamEditorModal";
import TeamFacts from "../components/TeamFacts";
import TeamPageHeader from "../components/TeamPageHeader";
import TeamProposalNotes from "../components/TeamProposalNotes";
import TeamResetConfirm from "../components/TeamResetConfirm";
import TeamTimelineButtons from "../components/TeamTimelineButtons";
import TeamViewNotices from "../components/TeamViewNotices";
import TimelineTitle from "../components/TimelineTitle";
import UnscheduledTraySection from "../components/UnscheduledTraySection";
import TeamFlowSection from "../components/TeamFlowSection";
import TeamProposal from "../components/TeamProposal";
import JiraBarsToggle from "../components/JiraBarsToggle";
import { TeamJiraChip } from "../components/JiraChips";
import TeamTimeline, { TeamTray, type TeamActions } from "../components/TeamTimeline";
import IdleGaps from "../components/IdleGaps";
import TeamWeeklyLoad from "../components/TeamWeeklyLoad";
import type { TimelineHandle } from "../components/Timeline";
import TimelineDndContext from "../components/TimelineDndContext";
import { useBaselinePick, useDropUnknownPick } from "../hooks/useBaselinePick";
import { useCriticalPathPick } from "../hooks/useCriticalPathPick";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { isOneOf, useStoredState } from "../hooks/useStoredState";
import { useProposalFocus } from "../hooks/useProposalFocus";
import { useProposalLock } from "../hooks/useProposalLock";
import { useRowMenuFocus } from "../hooks/useRowMenuFocus";
import { useScheduleCheck } from "../hooks/useScheduleCheck";
import { useScheduleProposal } from "../hooks/useScheduleProposal";
import { useTeamOrder } from "../hooks/useTeamOrder";
import { useJiraBarsPick } from "../hooks/useJiraBarsPick";
import { useTeamSchedule } from "../hooks/useTeamSchedule";
import { baselineDays } from "../utils/baselineOverlay";
import { localIsoDate } from "../utils/isoDate";
import { jiraPageRange, jiraScheduleDates } from "../utils/jiraBars";
import { teamMarks } from "../utils/jiraMarks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage } from "../utils/saveError";
import { overlayCheck, proposalDays } from "../utils/scheduleProposal";
import { growSeenRange, type SeenRange } from "../utils/seenRange";
import { teamsPath } from "../utils/teamLinks";
import { dropOutcome } from "../utils/timelineDrag";
import { defaultRange, makeScale, MILESTONE_ZOOMS, toEpochDay, type Zoom } from "../utils/timelineScale";

/** The schedule dialog remembers the plan revision of the view it was opened on: its save must stale-409 if THIS milestone moved since. */
type Scheduling = { milestone: TeamMilestone; revision: number };

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
  // The "Jira dates" toggle (1.3, remembered, on by default; offered only where the view links a Jira site).
  const jiraBars = useJiraBarsPick();
  // The critical-path toggle (1.7): the project page's remembered choice, one for both pages. Off, the page renders what it always did.
  const { shown: criticalPath, setShown: setCriticalPath } = useCriticalPathPick();
  const criticalNoteId = useId();
  const dropping = useDropUnknownPick(query.error, pick, setPick);
  const order = useTeamOrder(id, view, schedule.announce, pick, schedule.placeholder);
  const proposal = useScheduleProposal(id, schedule.announce, schedule.placeholder, pick);
  const lock = useProposalLock(proposal, schedule.announce);
  const { open, locked } = lock;
  // 1.8: while only some moves are ticked, the server judges THOSE moves (the link warnings and the proposed load); all or none need no request.
  const check = useScheduleCheck({ teamIds: [id], revision: open?.revision ?? 0, scopeHash: open?.scopeHash ?? "", moves: open?.moves ?? [], selected: proposal.selected, enabled: open !== null });
  const writing = schedule.pending || order.pending;
  const busy = writing || proposal.requesting;
  // Focus follows the preview (Discard takes it when a proposal opens, Propose gets it back once the preview is closed): `useProposalFocus`.
  const { proposeRef, discardRef } = useProposalFocus(proposal, open, busy);
  const [zoom, setZoom] = useStoredState<Zoom>("timeline.zoom", "week", isOneOf(MILESTONE_ZOOMS));
  const [editing, setEditing] = useState(false);
  useDialogFocus(editing);
  const [scheduling, setScheduling] = useState<Scheduling | null>(null);
  useDialogFocus(scheduling !== null);
  const [confirmReset, setConfirmReset] = useState(false);
  // "Schedule on Jira's dates" takes the dashed row (and its kebab) away: the focus goes to the milestone's own row (`useRowMenuFocus`).
  const timelineRef = useRef<TimelineHandle>(null);
  const rowFocus = useRowMenuFocus(timelineRef);
  // The earliest and latest day this page has shown: the range only ever grows, so a drag never shifts the bars under the pointer.
  const [seen, setSeen] = useState<SeenRange | null>(null);
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
  const planDates = [...view.scheduled.flatMap((m) => [m.startDate, m.endDate]), ...(open === null ? [] : proposalDays(open.moves)), ...baselineDays(view.baseline)].filter(
    (d): d is string => d !== null,
  );
  // The Jira window (the plan's own dates padded by a year) bounds the shadow bars and what they add to the range: a mistyped Jira date cannot stretch the page.
  const { window: jiraWindowNow, dates } = jiraPageRange(jiraBars.shown, planDates, [...view.scheduled, ...view.unscheduled], today);
  const grown = growSeenRange(seen, dates);
  if (grown !== null) setSeen(grown);
  const scale = makeScale(zoom, defaultRange(seen === null ? [] : [seen.min, seen.max], today, zoom));
  // What the table and the strip show: the proposal with the verdicts and the load of the TICKED moves.
  const shown = open === null ? null : overlayCheck(open, check, id);

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

  /** The dashed row's item: Jira's REAL dates (never the bar's, which may be cut at the window) through the same write path as every other date change. */
  const scheduleOnJira = (milestone: TeamMilestone) => {
    const dates = jiraScheduleDates(milestone.jira);
    if (dates !== null) rowFocus.keep(milestone.id, schedule.commit(milestone.id, dates.start, dates.end, { announce: true }));
  };

  const actions: TeamActions = {
    editSchedule: lock.guarded((milestone: TeamMilestone) => setScheduling({ milestone, revision: view.revision })),
    unschedule: lock.guarded((milestone: TeamMilestone) => schedule.commit(milestone.id, null, null, { announce: true })),
    pin: lock.guarded((milestone: TeamMilestone, pinned: boolean) => schedule.pin(milestone.id, pinned)),
    schedule: lock.guarded(scheduleByButton),
    scheduleOnJira: lock.guarded(scheduleOnJira),
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
      <TeamPageHeader team={team} admin={admin} onEdit={() => setEditing(true)} />
      <TeamFacts view={view} />
      <TeamJiraChip teamId={id} marks={teamMarks(view)} />

      {query.isError && <ErrorAlert error={query.error} title={t("teams.view.loadFailed")} />}
      <TeamViewNotices schedule={schedule} order={order} proposal={proposal} lock={lock} />

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
              <TimelineTitle title={t("teams.view.timelineTitle")} saving={writing} />
              <TeamTimelineButtons view={view} proposal={proposal} busy={busy} proposeRef={proposeRef} onReset={() => setConfirmReset(true)} />
            </Group>
            <TeamProposalNotes proposal={proposal} />
            {criticalPath && (
              <Text size="sm" c="dimmed" id={criticalNoteId}>
                {t("teams.view.criticalNote")}
              </Text>
            )}
            <TeamTimeline
              view={view}
              scale={scale}
              onZoomChange={setZoom}
              today={today}
              busy={busy}
              actions={actions}
              label={t("teams.view.timelineAria")}
              proposal={shown ?? undefined}
              jira={jiraWindowNow}
              criticalPath={criticalPath}
              timelineRef={timelineRef}
              toolbar={
                <>
                  <BaselinePicker pick={pick} onPick={setPick} current={view.baseline} disabled={busy || locked} />
                  <CriticalPathToggle shown={criticalPath} onChange={setCriticalPath} describedBy={criticalNoteId} />
                  {view.jiraSites.length > 0 && <JiraBarsToggle shown={jiraBars.shown} onChange={jiraBars.setShown} />}
                </>
              }
            />
          </Stack>
          {shown !== null && (
            <TeamProposal
              proposal={shown}
              check={check}
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
          <UnscheduledTraySection hasItems={view.unscheduled.length > 0} canSchedule={team.can.schedule}>
            <TeamTray view={view} actions={actions} label={t("teams.view.trayAria")} previewing={open !== null} />
          </UnscheduledTraySection>
        </TimelineDndContext>
      )}

      <TeamCapacity view={view} readOnly={locked} />
      <TeamFlowSection teamId={id} importBlocked={locked} />
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
      <TeamResetConfirm opened={confirmReset && !locked} refused={order.refused} onClose={() => setConfirmReset(false)} onConfirm={resetOrder} />
    </Stack>
  );
}

import { useRef, useState } from "react";
import { Alert, Badge, Group, Loader, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconFilterOff, IconListNumbers } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { roadmapViewKey, type RoadmapProject, type RoadmapView } from "../api/roadmap";
import BaselinePicker from "../components/BaselinePicker";
import BaselineTotals from "../components/BaselineTotals";
import { ShowWithoutBaseline } from "../components/BaselineParts";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import FormErrorAlert from "../components/FormErrorAlert";
import JiraBarsToggle from "../components/JiraBarsToggle";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import RoadmapCriticalChain from "../components/RoadmapCriticalChain";
import RoadmapCriticalPicker from "../components/RoadmapCriticalPicker";
import RoadmapFilterFields from "../components/RoadmapFilters";
import RoadmapFlagPanel from "../components/RoadmapFlagPanel";
import RoadmapTimeline, { type RoadmapActions } from "../components/RoadmapTimeline";
import TargetWindowModal from "../components/TargetWindowModal";
import type { TimelineHandle } from "../components/Timeline";
import TimelineDndContext from "../components/TimelineDndContext";
import { useBaselinePick, useDropUnknownPick } from "../hooks/useBaselinePick";
import { isRejectedTarget, useCriticalAnnouncement, useCriticalTarget } from "../hooks/useCriticalTarget";
import { useJiraBarsPick } from "../hooks/useJiraBarsPick";
import { usePlanScale } from "../hooks/usePlanScale";
import { useProgramPick } from "../hooks/useProgramPick";
import { useRoadmapFilters } from "../hooks/useRoadmapFilters";
import { useRoadmapRanking } from "../hooks/useRoadmapRanking";
import { useRowMenuFocus } from "../hooks/useRowMenuFocus";
import { useTargetWindow } from "../hooks/useTargetWindow";
import { projectTotals, rankTotals } from "../utils/baselineOverlay";
import { localIsoDate } from "../utils/isoDate";
import { jiraWindow } from "../utils/jiraBars";
import { projectOfWindowBar } from "../utils/planTrack";
import { applyRoadmapWindow } from "../utils/targetWindowUpdate";
import {
  activeFilterCount,
  allProjects,
  datesOf,
  flagEntries,
  flagTotals,
  knownFilters,
  knownPick,
  visibleProjects,
  visibleRemoved,
  type FlagCounts,
} from "../utils/roadmapRows";

/** The facts line under the title: how many visible projects are ranked and unranked, then the flag totals — ORANGE warnings, gray infos (nothing moves). */
function RoadmapFacts({ ranked, unranked, flags }: { ranked: number; unranked: number; flags: FlagCounts }) {
  const { t } = useTranslation();
  return (
    <Group gap="md" role="group" aria-label={t("roadmap.facts.aria")}>
      <Text size="sm">{t("roadmap.facts.ranked", { count: ranked })}</Text>
      <Text size="sm">{t("roadmap.facts.unranked", { count: unranked })}</Text>
      {flags.warnings > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("roadmap.facts.warnings", { count: flags.warnings })}
        </Badge>
      )}
      {flags.infos > 0 && (
        <Badge color="gray" variant="light" tt="none">
          {t("roadmap.facts.infos", { count: flags.infos })}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The Roadmap page (`/roadmap`): the ONE global project ranking on the shared timeline — a row per project in rank order (the span its milestones
 * cover over the target window's band, flags as row icons), an "Unranked" divider and the unranked projects below it, the rolled-up dependency
 * arrows, a collapsible flag panel (the accessible surface of the icons) and the filters with the program pick. Everyone reads it; whether the
 * ranking can be changed is the view's `can.editRank` (the server's own arithmetic), never the session's roles: a row is dragged by its
 * pointer-only handle (across the divider = Rank at that slot / Unrank) or moved from its menu (the keyboard path), and every change is the
 * wholesale ranking PUT of `hooks/useRoadmapRanking.ts`. A project's target window is edited by the band (move, resize), a draw on a row
 * without one, or the row menu's dialog - wherever the project's own `can.editTargetWindow` is set - through `hooks/useTargetWindow.ts`; the two
 * write paths share one mutation key, so a change made while the other runs is refused out loud.
 */
export default function Roadmap() {
  const { t } = useTranslation();
  // v0.9: the baseline pick (one for every timeline page) keys the view's query - the ranking's and the window write path's optimistic steps too; the
  // typed 400 "unknown baseline" clears it.
  const { pick, setPick } = useBaselinePick();
  // 1.7: the project the critical path is shown toward (page-local, not stored): a key part of the view's query, like the pick. A 400 for it (the
  // project is gone) clears it and the page says so; the key change fetches the plain view.
  const critical = useCriticalTarget();
  const ranking = useRoadmapRanking(pick, critical.target);
  const { view, query } = ranking;
  const dropping = useDropUnknownPick(query.error, pick, setPick);
  if (critical.target !== null && isRejectedTarget(query.error)) critical.reject();
  // The target window's write path: the other write on this page's cached view (one mutation key with the ranking: never two at once).
  const windowWrite = useTargetWindow({
    view,
    queryKey: roadmapViewKey(pick, critical.target),
    apply: applyRoadmapWindow,
    nameOf: (current, id) => allProjects(current).find((project) => project.id === id)?.name,
    announce: ranking.announce,
    loading: ranking.placeholder,
  });
  const editable = view?.can.editRank ?? false;
  const empty = view !== undefined && view.ranked.length === 0 && view.unranked.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("roadmap.title")} description={editable ? t("roadmap.introEdit") : t("roadmap.intro")} />

      {query.isError && !dropping && <ErrorAlert error={query.error} title={t("roadmap.loadFailed")} />}
      {pick !== null && query.isError && !dropping && view === undefined && <ShowWithoutBaseline onClick={() => setPick(null)} />}
      {/* The visible notices; the status region below says them (an Alert's implicit role="alert" would read the refusal twice). */}
      {(ranking.refused || windowWrite.refused) && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {windowWrite.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("roadmap.window.gone")}
        </Alert>
      )}
      {critical.rejected && <FormErrorAlert>{t("roadmap.critical.unknown")}</FormErrorAlert>}
      {ranking.stale && <FormErrorAlert>{t("roadmap.stale")}</FormErrorAlert>}
      {ranking.error && <FormErrorAlert>{ranking.error}</FormErrorAlert>}
      {windowWrite.error && <FormErrorAlert>{windowWrite.error}</FormErrorAlert>}
      {/* Menu-driven changes are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {ranking.announcement}
      </VisuallyHidden>

      {(query.isLoading || dropping) && <LoadingBlock />}
      {empty && <EmptyState icon={IconListNumbers} label={t("roadmap.empty")} hint={t("roadmap.emptyHint")} />}
      {view && !empty && <RoadmapBody view={view} ranking={ranking} windowWrite={windowWrite} pick={pick} onPick={setPick} target={critical.target} onTarget={critical.set} />}
    </Stack>
  );
}

/** The page below the title once the view has projects: facts, filters, the timeline in its drag context and the flag panel. */
function RoadmapBody({
  view,
  ranking,
  windowWrite,
  pick: baselinePick,
  onPick,
  target,
  onTarget,
}: {
  view: RoadmapView;
  ranking: ReturnType<typeof useRoadmapRanking>;
  windowWrite: ReturnType<typeof useTargetWindow>;
  pick: number | null;
  onPick: (id: number | null) => void;
  /** The critical-path target (1.7) and its setter. */
  target: number | null;
  onTarget: (id: number | null) => void;
}) {
  const { t } = useTranslation();
  const { filters: storedFilters, set: setFilters } = useRoadmapFilters();
  const [storedPick, setPick] = useProgramPick();
  const timelineRef = useRef<TimelineHandle>(null);
  // The "Jira dates" toggle (1.3, remembered, on by default; offered only where the view links a Jira site): `jira` is the window the shadow bars are
  // drawn in while they are on - the plan's own dates padded by a year - and their dates join the range only inside it (a mistyped Jira date must not
  // stretch the grow-only range).
  const jiraBars = useJiraBarsPick();
  const jira = jiraBars.shown ? jiraWindow(datesOf(view), localIsoDate()) : null;
  // Every date of the whole plan, not only of the visible rows: a filter never changes the range under the user.
  const { scale, setZoom, today } = usePlanScale(datesOf(view, jira));

  // Stored values may name things that are gone; the filters and the pick are read through what the view still has.
  const filters = knownFilters(view, storedFilters);
  const pick = knownPick(view, storedPick);
  const visible = visibleProjects(view, filters, pick);
  const removed = visibleRemoved(view, filters, pick);
  const rowCount = visible.ranked.length + visible.unranked.length;
  const visibleRankedIds = visible.ranked.map((entry) => entry.project.id);

  // The menu's moves are relative to the rows the user sees; the page binds the visible ranked ids. A taken menu change keeps the keyboard user on
  // the row they were working on (`useRowMenuFocus`: the row's menu button, or its header where the virtual path has unmounted the row).
  const focus = useRowMenuFocus(timelineRef);
  // The target window's dialog: only which project it is open on; the project is read from the view on every render.
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId === null ? undefined : allProjects(view).find((project) => project.id === editingId);
  if (editingId !== null && editing === undefined) setEditingId(null); // the project left the view: its dialog closes
  const closeDialog = (id: number) => {
    setEditingId(null);
    focus.restore(id);
  };
  // The critical path toward `project` (or none). Hiding is said at once; showing is said by the effect below once the chain has ARRIVED (the change
  // is a bar outline and a panel, so the live region carries it) - never on the pick itself, which the server may still reject.
  const showCriticalTo = (project: RoadmapProject | null) => {
    onTarget(project?.id ?? null);
    if (project === null) ranking.announce(t("roadmap.announce.criticalCleared"));
  };
  const pickCriticalTarget = (id: number | null) => showCriticalTo(allProjects(view).find((project) => project.id === id) ?? null);
  // Said once per ARRIVAL of a chain (its target id changes), not per render or refetch; a target with nothing scheduled says so instead.
  useCriticalAnnouncement(
    allProjects(view).find((project) => project.id === view.criticalPath?.projectId),
    ranking.announce,
  );
  const actions: RoadmapActions = {
    menuClosed: (project) => focus.menuClosed(project.id),
    move: (project, delta) => focus.keep(project.id, ranking.move(project.id, delta, visibleRankedIds)),
    moveTo: (project, edge) => focus.keep(project.id, ranking.moveTo(project.id, edge, visibleRankedIds)),
    rank: (project) => focus.keep(project.id, ranking.rank(project.id)),
    unrank: (project) => focus.keep(project.id, ranking.unrank(project.id)),
    window: {
      edit: (project) => setEditingId(project.id),
      clear: (project) => focus.keep(project.id, windowWrite.commit(project.id, null, null, { announce: true })),
    },
    critical: { target, disabled: ranking.pending, toggle: (project) => showCriticalTo(project.id === target ? null : project) },
  };

  const projects = new Map(allProjects(view).map((project) => [project.id, project.name]));
  const teams = new Map(view.teams.map((team) => [team.id, team.name]));
  const names = { project: (id: number) => projects.get(id) ?? "", team: (id: number) => teams.get(id) ?? "" };

  return (
    <>
      <RoadmapFacts ranked={visible.ranked.length} unranked={visible.unranked.length} flags={flagTotals(visible)} />
      {view.baseline !== undefined && <BaselineTotals name={view.baseline.name} totals={projectTotals(allProjects(view), view.baseline.removedProjects.length)} ranks={rankTotals(allProjects(view))} />}
      <FilterPanel activeFilterCount={activeFilterCount(filters, pick)} storageKey="roadmap">
        <RoadmapFilterFields view={view} filters={filters} onFilters={setFilters} pick={[...(pick ?? [])]} onPick={setPick} />
      </FilterPanel>

      {rowCount + removed.length === 0 ? (
        <EmptyState icon={IconFilterOff} label={t("roadmap.noMatch")} hint={t("roadmap.noMatchHint")} />
      ) : (
        <TimelineDndContext
          scale={scale}
          // The only bar this page edits is a project's window (`window:<id>`): a move, a resize or a draw all land here.
          onSchedule={(barId, start, end) => {
            const id = projectOfWindowBar(barId);
            return id !== null && windowWrite.commit(id, start, end);
          }}
          onReorder={(barId, slot) => ranking.dropAt(Number(barId), slot, visibleRankedIds)}
        >
          <Stack gap="xs">
            <Group gap="sm" align="center">
              <Title order={3} size="h4">
                {t("roadmap.timelineTitle")}
              </Title>
              {ranking.pending && (
                <Group gap={6} role="status">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    {t("project.saving")}
                  </Text>
                </Group>
              )}
            </Group>
            <RoadmapTimeline
              view={view}
              visible={visible}
              removed={removed}
              actions={actions}
              scale={scale}
              onZoomChange={setZoom}
              today={today}
              busy={ranking.pending}
              label={t("roadmap.timelineAria")}
              timelineRef={timelineRef}
              jira={jira}
              toolbar={
                <>
                  <BaselinePicker pick={baselinePick} onPick={onPick} current={view.baseline} disabled={ranking.pending} />
                  <RoadmapCriticalPicker projects={allProjects(view)} target={target} onPick={pickCriticalTarget} disabled={ranking.pending} />
                  {view.jiraSites.length > 0 && <JiraBarsToggle shown={jiraBars.shown} onChange={jiraBars.setShown} />}
                </>
              }
            />
          </Stack>
        </TimelineDndContext>
      )}

      <RoadmapFlagPanel entries={flagEntries(visible)} names={names} jiraSites={view.jiraSites} onShow={(projectId) => timelineRef.current?.focusRow(projectId)} />

      <RoadmapCriticalChain
        projects={allProjects(view)}
        criticalPath={view.criticalPath}
        shown={new Set([...visible.ranked.map((entry) => entry.project.id), ...visible.unranked.map((project) => project.id)])}
        intro="roadmap.critical.intro"
        notShown="roadmap.critical.notShown"
      />

      {editing !== undefined && (
        <TargetWindowModal
          project={editing}
          refused={windowWrite.refused}
          onSave={(start, end) => {
            if (windowWrite.commit(editing.id, start, end, { announce: true, ownRefusalAlert: true })) closeDialog(editing.id);
          }}
          onClear={() => {
            if (windowWrite.commit(editing.id, null, null, { announce: true, ownRefusalAlert: true })) closeDialog(editing.id);
          }}
          onClose={() => closeDialog(editing.id)}
        />
      )}
    </>
  );
}

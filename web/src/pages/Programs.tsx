import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Group, Loader, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize, IconListTree } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProgramsView, programsViewKey, type ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import BaselinePicker from "../components/BaselinePicker";
import BaselineTotals from "../components/BaselineTotals";
import { ShowWithoutBaseline } from "../components/BaselineParts";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import FormErrorAlert from "../components/FormErrorAlert";
import JiraBarsToggle from "../components/JiraBarsToggle";
import { JiraStaleNote } from "../components/JiraChips";
import LoadingBlock from "../components/LoadingBlock";
import OverviewProposalSection from "../components/OverviewProposalSection";
import PageHeader from "../components/PageHeader";
import PlanDependenciesPanel from "../components/PlanDependenciesPanel";
import type { WindowActions } from "../components/PlanProjectCells";
import ProgramPickField from "../components/ProgramPickField";
import ProgramsNarrowing from "../components/ProgramsNarrowing";
import ProgramsWorkStreamField from "../components/ProgramsWorkStreamField";
import ProgramsTimeline from "../components/ProgramsTimeline";
import RoadmapCriticalChain from "../components/RoadmapCriticalChain";
import RoadmapCriticalPicker from "../components/RoadmapCriticalPicker";
import TargetWindowModal from "../components/TargetWindowModal";
import type { TimelineHandle } from "../components/Timeline";
import TimelineDndContext from "../components/TimelineDndContext";
import { useBaselinePick, useDropUnknownPick, withoutStaleOverlay } from "../hooks/useBaselinePick";
import { isRejectedTarget, useCriticalAnnouncement, useCriticalTarget } from "../hooks/useCriticalTarget";
import { useJiraBarsPick } from "../hooks/useJiraBarsPick";
import { useOverviewProposal } from "../hooks/useOverviewProposal";
import { usePlanScale } from "../hooks/usePlanScale";
import { useProgramPick } from "../hooks/useProgramPick";
import { useRowMenuFocus } from "../hooks/useRowMenuFocus";
import { useTargetWindow } from "../hooks/useTargetWindow";
import { useWorkStreamNarrowing } from "../hooks/useWorkStreamNarrowing";
import { projectTotals, removedProjectRows } from "../utils/baselineOverlay";
import { localIsoDate } from "../utils/isoDate";
import { jiraWindow } from "../utils/jiraBars";
import { projectOfWindowBar } from "../utils/planTrack";
import { allOpen, arrowAnchors, defaultOpen, inWorkStream, isNodeRow, programChoices, toggled, treeDates, treeFacts, treeProjects, treeRows } from "../utils/programsTree";
import { withoutCriticalPath } from "../utils/roadmapCritical";
import { pickAmong } from "../utils/roadmapRows";
import { isStaleSource } from "../utils/staleness";
import { applyProgramsWindow } from "../utils/targetWindowUpdate";

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "​";

/**
 * The facts line under the title: what the pick leaves of the plan, then the flag totals - ORANGE warnings, gray infos (nothing moves), then (1.17) the
 * chips' dimmed "Jira data may be out of date" while any site the plan's rows link through is behind (plan-wide: neither the pick nor a fold narrows it).
 */
function ProgramsFacts({ view, pick }: { view: ProgramsView; pick: ReadonlySet<number> | null }) {
  const { t } = useTranslation();
  const facts = treeFacts(view, pick);
  return (
    <Group gap="md" role="group" aria-label={t("programs.facts.aria")}>
      <Text size="sm">{t("programs.facts.workStreams", { count: facts.workStreams })}</Text>
      <Text size="sm">{t("programs.facts.programs", { count: facts.programs })}</Text>
      <Text size="sm">{t("programs.facts.projects", { count: facts.projects })}</Text>
      {facts.flags.warnings > 0 && (
        <Badge color="orange" tt="none">
          {t("roadmap.facts.warnings", { count: facts.flags.warnings })}
        </Badge>
      )}
      {facts.flags.infos > 0 && (
        <Badge color="gray" tt="none">
          {t("roadmap.facts.infos", { count: facts.flags.infos })}
        </Badge>
      )}
      {view.jiraSites.some(isStaleSource) && <JiraStaleNote />}
    </Group>
  );
}

/**
 * The Roadmap's overview mode (`/roadmap?mode=overview`, 1.29; the former Programs page): the plan as a collapsible tree - work stream -> program -> project - on the shared timeline. A work stream or
 * program row is a summary bar over the span its projects cover with the roll-up of their flags; a project row is the roadmap's (the target window
 * band, the span bar, the drift band, the flag icons). Work streams open expanded and programs collapsed; the chevron button of a node is its
 * keyboard path and the page SAYS what it did. Everyone reads it; the one thing written here is a project's target window - the band's move
 * and resize, a draw on a row without one, the row menu's dialog - wherever the project's own `can.editTargetWindow` is set, through the
 * roadmap's write path (`hooks/useTargetWindow.ts`). The program pick is the Prioritization mode's, in the address and remembered under the one key they share.
 * `modeSwitch` (from `RoadmapModes`) is the mode control, in the header's toolbar row.
 */
export default function Programs({ modeSwitch }: { modeSwitch?: ReactNode }) {
  const { t } = useTranslation();
  // v0.9: the baseline pick (one for every timeline page) keys the view's query - the window write path's optimistic step too; the typed 400
  // "unknown baseline" clears it. `keepPreviousData` keeps the page (and the focused picker) while another pick loads, without the old overlay.
  const { pick, setPick } = useBaselinePick();
  // 1.16: so does the critical-path target (page-local, not stored: a question the viewer asks), whose block belongs to the entry that fetched it - the
  // kept previous copy shows none of the old target's chain. A plain 400 for the target (the project is gone) clears it and the page says so inline.
  const critical = useCriticalTarget();
  const query = useQuery({ queryKey: programsViewKey(pick, critical.target), queryFn: () => getProgramsView(pick, critical.target), placeholderData: keepPreviousData });
  const overlaid = withoutStaleOverlay(query.data, query.isPlaceholderData);
  const view = overlaid !== undefined && query.isPlaceholderData ? withoutCriticalPath(overlaid) : overlaid;
  const dropping = useDropUnknownPick(query.error, pick, setPick);
  if (critical.target !== null && isRejectedTarget(query.error)) critical.reject();
  const empty = view !== undefined && view.workStreams.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("roadmap.title")} description={t("programs.intro")} toolbar={modeSwitch} />
      {critical.rejected && <FormErrorAlert>{t("roadmap.critical.unknown")}</FormErrorAlert>}
      {query.isError && !dropping && <ErrorAlert error={query.error} title={t("programs.loadFailed")} />}
      {pick !== null && query.isError && !dropping && view === undefined && <ShowWithoutBaseline onClick={() => setPick(null)} />}
      {(query.isLoading || dropping) && <LoadingBlock />}
      {empty && <EmptyState icon={IconListTree} label={t("programs.empty")} hint={t("programs.emptyHint")} />}
      {view && !empty && <ProgramsBody view={view} pick={pick} onPick={setPick} target={critical.target} onTarget={critical.set} loading={query.isPlaceholderData} settled={query.isSuccess && !query.isFetching} />}
      {/* 1.29: the explicit list of every dependency of the plan (the arrows' text), hidden until asked for. It reads its own endpoint, so it sits
          OUTSIDE the body (an error on this page's view read must not hide it) and at ONE position in every state (loading, error, data: a recovery
          never remounts it, so an open Add dialog survives); `ready` holds its arrival focus back until the page's own read has settled. */}
      {!empty && <PlanDependenciesPanel ready={!query.isLoading && !dropping} />}
    </Stack>
  );
}

/** The page below the title once the plan has work streams: the facts, the pick, the expand/collapse buttons and the timeline. */
function ProgramsBody({
  view,
  pick: baselinePick,
  onPick,
  target,
  onTarget,
  loading,
  settled,
}: {
  view: ProgramsView;
  pick: number | null;
  onPick: (id: number | null) => void;
  /** The critical-path target (1.16) and its setter. */
  target: number | null;
  onTarget: (id: number | null) => void;
  loading: boolean;
  /** The last read of the view succeeded and none is in flight (a failed refetch leaves a stale copy that says nothing): only then is a work stream the address names, and the plan lacks, called unknown (`useWorkStreamNarrowing`). */
  settled: boolean;
}) {
  const { t } = useTranslation();
  const [addressPick, setPick] = useProgramPick();
  // 1.31: the work stream the overview is narrowed to (the address's alone; a link's, or the filter panel's field). Only the tree narrows: the range, the links and the critical chain read the whole plan.
  const narrowing = useWorkStreamNarrowing(view, settled);
  const narrowed = inWorkStream(view, narrowing.workStream?.id ?? null);
  // The expanded set is page state, not persisted. Until the user first changes it the defaults apply (every work stream open), so a stream that
  // arrives with a refetch opens too; the first change freezes the set as the user sees it.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The "Jira dates" toggle (1.3, remembered, on by default; offered only where the view links a Jira site): `jira` is the window the project rows' shadow
  // bars are drawn in while they are on - the plan's own dates padded by a year - and their dates join the range only inside it (a mistyped Jira date
  // must not stretch the grow-only range).
  const jiraBars = useJiraBarsPick();
  const jira = jiraBars.shown ? jiraWindow(treeDates(view), localIsoDate()) : null;

  // The pick is the address's (1.21; a bare visit shows the remembered one): an id of a program the plan no longer has filters nothing instead of hiding every row.
  const choices = programChoices(narrowed);
  const pick = pickAmong(choices, addressPick);
  const open = expanded ?? defaultOpen(narrowed, narrowing.workStream !== null);
  // 1.33: the schedule proposal previewed on the tree (its bars, its lock over the target windows); the range covers its proposed dates too.
  const announce = (text: string) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD));
  const proposal = useOverviewProposal({ view, narrowed, pick, unsettled: narrowing.pending, announce });
  // Every date of the whole plan, not only of the shown rows: neither the pick nor a fold changes the range under the user.
  const { scale, setZoom, today } = usePlanScale([...treeDates(view, jira), ...proposal.days]);
  const removedRows = removedProjectRows(view.baseline?.removedProjects ?? [], t);
  const rows = treeRows(narrowed, pick, open, removedRows, proposal.proposed);
  const anchors = arrowAnchors(narrowed, pick, open);

  // A toggle can change what the grid is made of: when it takes the rows across the virtualisation threshold (80) the Timeline switches paths and
  // EVERY row remounts as a new DOM node, so the pressed chevron is gone and the focus falls to `body` (and, going virtual, the first render
  // mounts no row at all). So the toggled node's row takes the focus back after the render, mounted or not (`focusRow`); where the same button
  // is still focused (the usual case) nothing is touched.
  const timelineRef = useRef<TimelineHandle>(null);
  // A project row's menu actions (the target window's items) keep the keyboard user on the row (`useRowMenuFocus`), as on the roadmap.
  const rowFocus = useRowMenuFocus(timelineRef);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (refocus.current === null) return;
    const key = refocus.current;
    refocus.current = null;
    const button = document.querySelector(`[data-node-key="${key}"]`);
    if (button === null || button !== document.activeElement) timelineRef.current?.focusRow(key);
  });

  // The target window's write path (the roadmap's, over this tree): a project row's band, draw and menu items. Its sentences go to the same polite
  // region as the fold announcements; an identical sentence said twice is re-read through a toggled invisible suffix.
  const windowWrite = useTargetWindow({
    view,
    queryKey: programsViewKey(baselinePick, target),
    apply: applyProgramsWindow,
    nameOf: (current, id) => treeProjects(current).find((project) => project.id === id)?.name,
    announce,
    loading,
  });
  const writing = windowWrite.pending;
  const commit = proposal.guard(windowWrite.commit); // refused out loud while a proposal is requested or open
  // The critical path toward `project` (or none). Hiding is said at once; showing is said by the hook once the chain has ARRIVED (the change is a bar
  // outline and a panel, so the live region carries it) - never on the pick itself, which the server may still reject.
  const projects = treeProjects(view);
  const showCriticalTo = (project: RoadmapProject | null) => {
    onTarget(project?.id ?? null);
    if (project === null) announce(t("roadmap.announce.criticalCleared"));
  };
  useCriticalAnnouncement(
    target,
    projects.find((project) => project.id === view.criticalPath?.projectId),
    announce,
  );
  // The dialog is open on one project: read from the view on every render, closed when the project has left it.
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId === null ? undefined : projects.find((project) => project.id === editingId);
  if (editingId !== null && editing === undefined) setEditingId(null);
  const closeDialog = (id: number) => {
    setEditingId(null);
    rowFocus.restore(id);
  };
  const windowActions: WindowActions = {
    edit: (project) => setEditingId(project.id),
    clear: (project) => rowFocus.keep(project.id, commit(project.id, null, null, { announce: true })),
  };

  function toggle(key: string) {
    refocus.current = key;
    const row = rows.find((candidate) => isNodeRow(candidate) && candidate.key === key);
    setExpanded(toggled(open, key));
    if (row === undefined || !isNodeRow(row)) return;
    const count = row.childCount;
    setAnnouncement(
      row.expanded ? t("programs.announce.collapsed", { name: row.name }) : t(row.kind === "workStream" ? "programs.announce.expandedStream" : "programs.announce.expandedProgram", { name: row.name, count }),
    );
  }
  function setAll(next: Set<string>, message: string) {
    setExpanded(next);
    setAnnouncement(message);
  }

  return (
    <>
      {/* The visible notices of the window write path; the status region below says them (an Alert's implicit role="alert" would read each twice). */}
      {(windowWrite.refused || proposal.refusal !== null) && (
        <Alert color="orange" variant="light" role="note">
          {proposal.refusal ?? t("project.busy")}
        </Alert>
      )}
      {windowWrite.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("roadmap.window.gone")}
        </Alert>
      )}
      {windowWrite.error && <FormErrorAlert>{windowWrite.error}</FormErrorAlert>}
      <Group gap="sm" justify="space-between" align="flex-end" wrap="wrap">
        <ProgramsFacts view={narrowed} pick={pick} />
        <Group gap="xs" data-print="hide">
          <Button variant="default" size="xs" leftSection={<IconArrowsMaximize size={14} />} onClick={() => setAll(allOpen(view, removedRows), t("programs.announce.expandedAll"))}>
            {t("programs.expandAll")}
          </Button>
          <Button variant="default" size="xs" leftSection={<IconArrowsMinimize size={14} />} onClick={() => setAll(new Set(), t("programs.announce.collapsedAll"))}>
            {t("programs.collapseAll")}
          </Button>
        </Group>
      </Group>
      {view.baseline !== undefined && <BaselineTotals name={view.baseline.name} totals={projectTotals(projects, view.baseline.removedProjects.length)} />}
      <ProgramsNarrowing
        workStreamName={narrowing.workStream?.name ?? null}
        pickCount={pick?.size ?? 0}
        empty={treeFacts(narrowed, pick).projects === 0}
        unknown={narrowing.unknown}
        onClearWorkStream={() => narrowing.set(null)}
        onClearPick={() => setPick([])}
        onDismissUnknown={narrowing.dismiss}
      />
      <FilterPanel activeFilterCount={(pick === null ? 0 : 1) + (narrowing.workStream === null ? 0 : 1)} storageKey="programs">
        <ProgramPickField programs={choices} pick={[...(pick ?? [])]} onPick={setPick} />
        <ProgramsWorkStreamField workStreams={view.workStreams} value={narrowing.workStream?.id ?? null} onChange={narrowing.set} />
      </FilterPanel>
      {/* Expanding and collapsing are announced here: the buttons keep their focus, so nothing else says the tree changed. */}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      <TimelineDndContext
        scale={scale}
        // The only bar this page edits is a project's window (`window:<id>`): a move, a resize or a draw all land here.
        onSchedule={(barId, start, end) => {
          const id = projectOfWindowBar(barId);
          return id !== null && commit(id, start, end);
        }}
      >
        <Stack gap="xs">
          <Group gap="sm" align="center">
            <Title order={3} size="h4">
              {t("programs.timelineTitle")}
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
          <ProgramsTimeline
            links={view.links}
            teams={view.teams}
            rows={rows}
            anchors={anchors}
            onToggle={toggle}
            windowActions={windowActions}
            menuClosed={(project) => rowFocus.menuClosed(project.id)}
            scale={scale}
            onZoomChange={setZoom}
            today={today}
            busy={writing}
            locked={proposal.lock.locked}
            label={t("programs.timelineAria")}
            timelineRef={timelineRef}
            jira={jira}
            criticalPath={view.criticalPath}
            critical={{ target, disabled: writing, toggle: (project) => showCriticalTo(project.id === target ? null : project) }}
            // The narrowed node is this page's subject: a work stream named by the address, or the one picked program (its name is plain text on its own row).
            own={narrowing.workStream !== null ? { kind: "workStream", id: narrowing.workStream.id } : pick?.size === 1 ? { kind: "program", id: [...pick][0] } : null}
            toolbar={
              <>
                <BaselinePicker pick={baselinePick} onPick={onPick} current={view.baseline} disabled={writing} />
                <RoadmapCriticalPicker projects={projects} target={target} onPick={(id) => showCriticalTo(projects.find((project) => project.id === id) ?? null)} disabled={writing} />
                {view.jiraSites.length > 0 && <JiraBarsToggle shown={jiraBars.shown} onChange={jiraBars.setShown} />}
              </>
            }
          />
        </Stack>
      </TimelineDndContext>
      <OverviewProposalSection proposal={proposal} announce={announce} />

      <RoadmapCriticalChain
        projects={projects}
        criticalPath={view.criticalPath}
        shown={new Set(rows.flatMap((row) => (row.kind === "project" ? [row.project.id] : [])))}
        intro="programs.critical.intro"
        notShown="programs.critical.notShown"
      />

      {editing !== undefined && (
        <TargetWindowModal
          project={editing}
          refused={windowWrite.refused}
          onSave={(start, end) => {
            if (commit(editing.id, start, end, { announce: true, ownRefusalAlert: true })) closeDialog(editing.id);
          }}
          onClear={() => {
            if (commit(editing.id, null, null, { announce: true, ownRefusalAlert: true })) closeDialog(editing.id);
          }}
          onClose={() => closeDialog(editing.id)}
        />
      )}
    </>
  );
}

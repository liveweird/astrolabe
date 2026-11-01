import { useEffect, useRef } from "react";
import { Alert, Badge, Group, Loader, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconFilterOff, IconListNumbers } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { RoadmapView } from "../api/roadmap";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import RoadmapFilterFields from "../components/RoadmapFilters";
import RoadmapFlagPanel from "../components/RoadmapFlagPanel";
import RoadmapTimeline, { type RoadmapActions } from "../components/RoadmapTimeline";
import type { TimelineHandle } from "../components/Timeline";
import TimelineDndContext from "../components/TimelineDndContext";
import { usePlanScale } from "../hooks/usePlanScale";
import { useProgramPick } from "../hooks/useProgramPick";
import { useRoadmapFilters } from "../hooks/useRoadmapFilters";
import { useRoadmapRanking } from "../hooks/useRoadmapRanking";
import {
  activeFilterCount,
  allProjects,
  datesOf,
  flagEntries,
  flagTotals,
  knownFilters,
  knownPick,
  visibleProjects,
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
 * wholesale ranking PUT of `hooks/useRoadmapRanking.ts`. The target window is shown, not edited, here.
 */
export default function Roadmap() {
  const { t } = useTranslation();
  const ranking = useRoadmapRanking();
  const { view, query } = ranking;
  const editable = view?.can.editRank ?? false;
  const empty = view !== undefined && view.ranked.length === 0 && view.unranked.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("roadmap.title")} description={editable ? t("roadmap.introEdit") : t("roadmap.intro")} />

      {query.isError && <ErrorAlert error={query.error} title={t("roadmap.loadFailed")} />}
      {/* The visible notices; the status region below says them (an Alert's implicit role="alert" would read the refusal twice). */}
      {ranking.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {ranking.stale && <FormErrorAlert>{t("roadmap.stale")}</FormErrorAlert>}
      {ranking.error && <FormErrorAlert>{ranking.error}</FormErrorAlert>}
      {/* Menu-driven changes are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {ranking.announcement}
      </VisuallyHidden>

      {query.isLoading && <LoadingBlock />}
      {empty && <EmptyState icon={IconListNumbers} label={t("roadmap.empty")} hint={t("roadmap.emptyHint")} />}
      {view && !empty && <RoadmapBody view={view} ranking={ranking} />}
    </Stack>
  );
}

/** The page below the title once the view has projects: facts, filters, the timeline in its drag context and the flag panel. */
function RoadmapBody({ view, ranking }: { view: RoadmapView; ranking: ReturnType<typeof useRoadmapRanking> }) {
  const { t } = useTranslation();
  const { filters: storedFilters, set: setFilters } = useRoadmapFilters();
  const [storedPick, setPick] = useProgramPick();
  const timelineRef = useRef<TimelineHandle>(null);
  // Every date of the whole plan, not only of the visible rows: a filter never changes the range under the user.
  const { scale, setZoom, today } = usePlanScale(datesOf(view));

  // Stored values may name things that are gone; the filters and the pick are read through what the view still has.
  const filters = knownFilters(view, storedFilters);
  const pick = knownPick(view, storedPick);
  const visible = visibleProjects(view, filters, pick);
  const rowCount = visible.ranked.length + visible.unranked.length;
  const visibleRankedIds = visible.ranked.map((entry) => entry.project.id);

  // The menu's moves are relative to the rows the user sees; the page binds the visible ranked ids.
  // A taken menu change reorders the rows, and a browser blurs a focused element whose row is moved in the DOM: the row's menu button takes the
  // focus back after the render that moved it. On the virtual path the row may have left the mounted window (Move to bottom, Rank): its button is
  // gone, so the timeline scrolls to the row and focuses its header instead - the keyboard user stays on the row they were working on.
  // The menu that was used keeps its dropdown - and its focus trap - mounted through its exit transition (~150 ms), and the trap pulls a focus moved
  // meanwhile into its sentinel, which lands on `body` when the dropdown unmounts: a keyboard user ended on the page body. So the render-time focus
  // above is repeated once the menu has FINISHED closing (`menuClosed`, from the row menu's `onExitTransitionEnd`); the first covers the rows whose
  // menu is gone with the row (the virtual path), the second the ones that stay.
  const refocus = useRef<number | null>(null);
  const afterExit = useRef<number | null>(null);
  const putFocusOn = (id: number) => {
    const button = document.querySelector<HTMLElement>(`[data-operations-for="${id}"]`);
    if (button === null) timelineRef.current?.focusRow(id);
    else button.focus();
  };
  useEffect(() => {
    if (refocus.current === null) return;
    const id = refocus.current;
    refocus.current = null;
    putFocusOn(id);
  });
  const keepFocus = (project: { id: number }, taken: boolean) => {
    if (!taken) return;
    refocus.current = project.id;
    afterExit.current = project.id;
  };
  const actions: RoadmapActions = {
    menuClosed: (project) => {
      if (afterExit.current !== project.id) return;
      afterExit.current = null;
      putFocusOn(project.id);
    },
    move: (project, delta) => keepFocus(project, ranking.move(project.id, delta, visibleRankedIds)),
    moveTo: (project, edge) => keepFocus(project, ranking.moveTo(project.id, edge, visibleRankedIds)),
    rank: (project) => keepFocus(project, ranking.rank(project.id)),
    unrank: (project) => keepFocus(project, ranking.unrank(project.id)),
  };

  const projects = new Map(allProjects(view).map((project) => [project.id, project.name]));
  const teams = new Map(view.teams.map((team) => [team.id, team.name]));
  const names = { project: (id: number) => projects.get(id) ?? "", team: (id: number) => teams.get(id) ?? "" };

  return (
    <>
      <RoadmapFacts ranked={visible.ranked.length} unranked={visible.unranked.length} flags={flagTotals(visible)} />
      <FilterPanel activeFilterCount={activeFilterCount(filters, pick)} storageKey="roadmap">
        <RoadmapFilterFields view={view} filters={filters} onFilters={setFilters} pick={[...(pick ?? [])]} onPick={setPick} />
      </FilterPanel>

      {rowCount === 0 ? (
        <EmptyState icon={IconFilterOff} label={t("roadmap.noMatch")} hint={t("roadmap.noMatchHint")} />
      ) : (
        <TimelineDndContext
          scale={scale}
          // No bar of this page can be edited yet (the target windows are read-only here), so a dropped bar proposes nothing.
          onSchedule={() => false}
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
              actions={actions}
              scale={scale}
              onZoomChange={setZoom}
              today={today}
              busy={ranking.pending}
              label={t("roadmap.timelineAria")}
              timelineRef={timelineRef}
            />
          </Stack>
        </TimelineDndContext>
      )}

      <RoadmapFlagPanel entries={flagEntries(visible)} names={names} onShow={(projectId) => timelineRef.current?.focusRow(projectId)} />
    </>
  );
}

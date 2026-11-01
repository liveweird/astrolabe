import { useEffect, useRef, useState } from "react";
import { Badge, Button, Group, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize, IconListTree } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProgramsView, programsViewKey, type ProgramsView } from "../api/programs";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import ProgramPickField from "../components/ProgramPickField";
import ProgramsTimeline from "../components/ProgramsTimeline";
import type { TimelineHandle } from "../components/Timeline";
import { usePlanScale } from "../hooks/usePlanScale";
import { useProgramPick } from "../hooks/useProgramPick";
import { allOpen, defaultOpen, programChoices, toggled, treeDates, treeFacts, treeRows } from "../utils/programsTree";
import { pickAmong } from "../utils/roadmapRows";

/** The facts line under the title: what the pick leaves of the plan, then the flag totals - ORANGE warnings, gray infos (nothing moves). */
function ProgramsFacts({ view, pick }: { view: ProgramsView; pick: ReadonlySet<number> | null }) {
  const { t } = useTranslation();
  const facts = treeFacts(view, pick);
  return (
    <Group gap="md" role="group" aria-label={t("programs.facts.aria")}>
      <Text size="sm">{t("programs.facts.workStreams", { count: facts.workStreams })}</Text>
      <Text size="sm">{t("programs.facts.programs", { count: facts.programs })}</Text>
      <Text size="sm">{t("programs.facts.projects", { count: facts.projects })}</Text>
      {facts.flags.warnings > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("roadmap.facts.warnings", { count: facts.flags.warnings })}
        </Badge>
      )}
      {facts.flags.infos > 0 && (
        <Badge color="gray" variant="light" tt="none">
          {t("roadmap.facts.infos", { count: facts.flags.infos })}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The Programs page (`/programs`): the plan as a collapsible tree - work stream -> program -> project - on the shared timeline. A work stream or
 * program row is a summary bar over the span its projects cover with the roll-up of their flags; a project row is the roadmap's (the target window
 * band, the span bar, the drift band, the flag icons). Work streams open expanded and programs collapsed; the chevron button of a node is its
 * keyboard path and the page SAYS what it did. Everyone reads it; there is nothing to write here (a row's rights, once windows can be edited,
 * are the view's `can` flags). The program pick is the one the roadmap shares.
 */
export default function Programs() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: programsViewKey, queryFn: getProgramsView });
  const view = query.data;
  const empty = view !== undefined && view.workStreams.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("programs.title")} description={t("programs.intro")} />
      {query.isError && <ErrorAlert error={query.error} title={t("programs.loadFailed")} />}
      {query.isLoading && <LoadingBlock />}
      {empty && <EmptyState icon={IconListTree} label={t("programs.empty")} hint={t("programs.emptyHint")} />}
      {view && !empty && <ProgramsBody view={view} />}
    </Stack>
  );
}

/** The page below the title once the plan has work streams: the facts, the pick, the expand/collapse buttons and the timeline. */
function ProgramsBody({ view }: { view: ProgramsView }) {
  const { t } = useTranslation();
  const [storedPick, setPick] = useProgramPick();
  // The expanded set is page state, not persisted. Until the user first changes it the defaults apply (every work stream open), so a stream that
  // arrives with a refetch opens too; the first change freezes the set as the user sees it.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Every date of the whole plan, not only of the shown rows: neither the pick nor a fold changes the range under the user.
  const { scale, setZoom, today } = usePlanScale(treeDates(view));

  // A stored id of a program the plan no longer has filters nothing instead of hiding every row.
  const choices = programChoices(view);
  const pick = pickAmong(choices, storedPick);
  const open = expanded ?? defaultOpen(view);
  const rows = treeRows(view, pick, open);

  // A toggle can change what the grid is made of: when it takes the rows across the virtualisation threshold (80) the Timeline switches paths and
  // EVERY row remounts as a new DOM node, so the pressed chevron is gone and the focus falls to `body` (and, going virtual, the first render
  // mounts no row at all). So the toggled node's row takes the focus back after the render, mounted or not (`focusRow`); where the same button
  // is still focused (the usual case) nothing is touched.
  const timelineRef = useRef<TimelineHandle>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (refocus.current === null) return;
    const key = refocus.current;
    refocus.current = null;
    const button = document.querySelector(`[data-node-key="${key}"]`);
    if (button === null || button !== document.activeElement) timelineRef.current?.focusRow(key);
  });

  function toggle(key: string) {
    refocus.current = key;
    const row = rows.find((candidate) => candidate.kind !== "project" && candidate.key === key);
    setExpanded(toggled(open, key));
    if (row === undefined || row.kind === "project") return;
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
      <Group gap="sm" justify="space-between" align="flex-end" wrap="wrap">
        <ProgramsFacts view={view} pick={pick} />
        <Group gap="xs" data-print="hide">
          <Button variant="default" size="xs" leftSection={<IconArrowsMaximize size={14} />} onClick={() => setAll(allOpen(view), t("programs.announce.expandedAll"))}>
            {t("programs.expandAll")}
          </Button>
          <Button variant="default" size="xs" leftSection={<IconArrowsMinimize size={14} />} onClick={() => setAll(new Set(), t("programs.announce.collapsedAll"))}>
            {t("programs.collapseAll")}
          </Button>
        </Group>
      </Group>
      <FilterPanel activeFilterCount={pick === null ? 0 : 1} storageKey="programs">
        <ProgramPickField programs={choices} pick={[...(pick ?? [])]} onPick={setPick} />
      </FilterPanel>
      {/* Expanding and collapsing are announced here: the buttons keep their focus, so nothing else says the tree changed. */}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      <Stack gap="xs">
        <Title order={3} size="h4">
          {t("programs.timelineTitle")}
        </Title>
        <ProgramsTimeline links={view.links} rows={rows} onToggle={toggle} scale={scale} onZoomChange={setZoom} today={today} label={t("programs.timelineAria")} timelineRef={timelineRef} />
      </Stack>
    </>
  );
}

import { useState } from "react";
import { useNavigate, useParams, Link as RouterLink } from "react-router-dom";
import { Anchor, Button, Group, Select, Stack, Switch, Table, Text, Title, VisuallyHidden } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getBaselineView, type BaselineView } from "../api/baselines";
import { ApiError } from "../api/http";
import { DateRange, Figures, StatusBadge, TotalsBadges } from "../components/BaselineParts";
import ClearableTextInput from "../components/ClearableTextInput";
import EditPageLoadState from "../components/EditPageLoadState";
import PageHeader from "../components/PageHeader";
import ScrollRegion from "../components/ScrollRegion";
import { useBaselinePick } from "../hooks/useBaselinePick";
import { baselinesPath } from "../utils/baselineLinks";
import { compareGroups, compareTeams, estimateText, type CompareFilters } from "../utils/baselineCompare";
import { movementSentence, movementStatus, movementTotalsParts, signedDays } from "../utils/baselineOverlay";
import { formatDateTime } from "../utils/formatDate";
import { projectPath, roadmapPath } from "../utils/planLinks";
import { loadErrorMessage } from "../utils/saveError";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
/** The status column shrinks to its badge (a Badge ellipsises in a squeezed cell, so it also keeps its full width: `miw`); the name column keeps room for a project's lines. */
const MAX_INT32 = 2_147_483_647;
const SHRINK = { width: 1, whiteSpace: "nowrap" } as const;
const NAME_COLUMN = { minWidth: 220 } as const;
/** The table scrolls inside its region (1,000 rows at most, no virtualisation — a plain table). */
const TABLE_MAX_HEIGHT = "70vh";

function Span({ span }: { span: { start: string; end: string } | null }) {
  return span === null ? <>—</> : <DateRange start={span.start} end={span.end} />;
}

function Facts({ view }: { view: BaselineView }) {
  const { t } = useTranslation();
  const { baseline } = view;
  const when = formatDateTime(baseline.createdAt);
  return (
    <Stack gap={2} role="group" aria-label={t("baselines.compare.factsAria")}>
      <Text size="sm">
        {[
          baseline.createdBy ? t("baselines.compare.taken", { when, name: baseline.createdBy.name }) : t("baselines.compare.takenAnonymous", { when }),
          t("baselines.compare.revision", { revision: baseline.planRevision }),
          t("baselines.compare.milestones", { count: baseline.milestoneCount }),
          t("baselines.compare.projects", { count: baseline.projectCount }),
        ].join(" · ")}
      </Text>
      {view.revision === baseline.planRevision && (
        <Text size="sm" c="dimmed">
          {t("baselines.compare.samePlan")}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The comparison page (`/baselines/:id`, any signed-in user): one baseline against the plan now, from `GET /views/baseline/{id}` — read,
 * never recomputed (the server counts the working days on the current calendar). The totals first (ORANGE badge for the rows whose end is
 * later), then ONE plain table grouped by project: a project row with its own span movement and the counts of its milestones, then its
 * CHANGED milestone rows (the document lists only those; an estimate-only change is one). ≤ 1,000 rows, so no virtualisation — a
 * `ScrollRegion`. Filters (team, project name, "changed projects only") are client-side and not persisted.
 */
export default function BaselineCompare() {
  const { t } = useTranslation();
  const raw = useParams().id ?? "";
  const id = parseBaselineId(raw);
  // Malformed (or out of the server's int range): the not-found page, no request.
  if (id === null) return <NotFound message={t("baselines.compare.notFound")} />;
  // Keyed by id, so the filters of one baseline never leak into the next.
  return <Comparison key={id} id={id} />;
}

/** A baseline id as the server has it: 1..2^31-1 in plain digits, nothing else. */
function parseBaselineId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_INT32 ? id : null;
}

function NotFound({ message }: { message: string }) {
  const { t } = useTranslation();
  return <EditPageLoadState isLoading={false} message={message} backTo={baselinesPath} backLabel={t("baselines.compare.backToList")} title={t("baselines.compare.title")} />;
}

function Comparison({ id }: { id: number }) {
  const { t } = useTranslation();
  const [teamId, setTeamId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [changedOnly, setChangedOnly] = useState(true);
  // "Show on timeline": remember this baseline as the pick of every timeline page (one browser-wide pick), then open the page.
  const { setPick } = useBaselinePick();
  const navigate = useNavigate();
  const showOn = (to: string) => {
    setPick(id);
    navigate(to);
  };

  const { data, isLoading, error } = useQuery({ queryKey: ["baselines", "view", id], queryFn: () => getBaselineView(id) });

  if (!data) {
    if (isLoading) return <EditPageLoadState isLoading message="" backTo={baselinesPath} backLabel={t("baselines.compare.backToList")} title={t("baselines.compare.title")} />;
    const gone = error instanceof ApiError && error.status === 404;
    return <NotFound message={gone ? t("baselines.compare.notFound") : error ? loadErrorMessage(error, t) : t("baselines.compare.loadFailed")} />;
  }

  const filters: CompareFilters = { teamId, text, changedOnly };
  const groups = compareGroups(data, filters);
  const rowCount = groups.reduce((sum, group) => sum + group.milestones.length, 0);
  const teams = compareTeams(data);
  const filtered = teamId !== null || text.trim() !== "";

  return (
    <Stack gap="md">
      <PageHeader
        title={data.baseline.name}
        description={data.baseline.description ?? undefined}
        backTo={{ to: baselinesPath, label: t("baselines.compare.backToList") }}
        actions={
          <Button variant="default" onClick={() => showOn(roadmapPath)}>
            {t("baselines.compare.showOnRoadmap")}
          </Button>
        }
      />
      <Facts view={data} />

      <Stack gap="xs">
        <Title order={3} size="h4">
          {t("baselines.compare.totalsTitle")}
        </Title>
        <TotalsBadges label={t("baselines.compare.totalsMilestones")} totals={data.totals.milestones} />
        <TotalsBadges label={t("baselines.compare.totalsProjects")} totals={data.totals.projects} />
      </Stack>

      <Stack gap="sm">
        <Title order={3} size="h4">
          {t("baselines.compare.changesTitle")}
        </Title>
        <Text size="sm" c="dimmed">
          {t("baselines.compare.changesIntro")}
        </Text>
        <Group align="flex-end" gap="md" wrap="wrap">
          <Select
            label={t("baselines.compare.filter.team")}
            placeholder={t("common.state.any")}
            data={teams.map((team) => ({ value: String(team.id), label: team.name }))}
            value={teamId === null ? null : String(teamId)}
            onChange={(value) => setTeamId(value === null ? null : Number(value))}
            searchable
            clearable
            clearButtonProps={{ "aria-label": t("baselines.compare.filter.clearTeam") }}
          />
          <ClearableTextInput label={t("baselines.compare.filter.project")} value={text} onChange={setText} clearLabel={t("baselines.compare.filter.clearProject")} />
          <Switch label={t("baselines.compare.filter.changedOnly")} checked={changedOnly} onChange={(event) => setChangedOnly(event.currentTarget.checked)} pb={6} />
        </Group>
        <Text size="sm" c="dimmed" role="status">
          {t("baselines.compare.shown", { projects: groups.length, milestones: rowCount })}
        </Text>

        <ScrollRegion label={t("baselines.compare.tableAria")} minWidth={1100} maxHeight={TABLE_MAX_HEIGHT}>
          <Table aria-label={t("baselines.compare.tableAria")} stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={NAME_COLUMN}>{t("baselines.compare.column.name")}</Table.Th>
                <Table.Th style={NO_WRAP}>{t("baselines.compare.column.team")}</Table.Th>
                <Table.Th>{t("baselines.compare.column.baseline")}</Table.Th>
                <Table.Th>{t("baselines.compare.column.current")}</Table.Th>
                <Table.Th ta="right">
                  {t("baselines.compare.column.start")}
                  <VisuallyHidden> {t("baselines.compare.column.workingDays")}</VisuallyHidden>
                </Table.Th>
                <Table.Th ta="right">
                  {t("baselines.compare.column.end")}
                  <VisuallyHidden> {t("baselines.compare.column.workingDays")}</VisuallyHidden>
                </Table.Th>
                <Table.Th>{t("baselines.compare.column.estimate")}</Table.Th>
                <Table.Th style={SHRINK}>{t("baselines.compare.column.status")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            {groups.length === 0 ? (
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td colSpan={8}>
                    <Text c="dimmed" size="sm">
                      {t(filtered ? "baselines.compare.emptyFiltered" : "baselines.compare.empty")}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            ) : (
              // One rowgroup per project: the project row is the row header of the milestone rows under it.
              groups.map(({ project, milestones }) => {
                const counts = movementTotalsParts(project.counts, t);
                return (
                  <Table.Tbody key={project.projectId}>
                    <Table.Tr>
                      <Table.Th scope="row">
                        <Anchor component={RouterLink} to={projectPath(project.projectId)} fw={600} size="sm" aria-label={t("baselines.compare.openProjectAria", { name: project.name })}>
                          {project.name}
                        </Anchor>
                        <Text size="xs" c="dimmed" fw={400}>
                          {t("baselines.compare.location", { program: project.programName, workStream: project.workStreamName })}
                        </Text>
                        {project.movement.kind !== "UNCHANGED" && (
                          <Text size="xs" c="dimmed" fw={400}>
                            {movementSentence(project.movement, t)}
                          </Text>
                        )}
                        {counts.length > 0 && (
                          <Text size="xs" c="dimmed" fw={400}>
                            {t("baselines.compare.projectCounts", { counts: counts.map((part) => part.label).join(", ") })}
                          </Text>
                        )}
                        <Button variant="subtle" size="compact-xs" fw={500} aria-label={t("baselines.compare.showOnTimelineAria", { name: project.name })} onClick={() => showOn(projectPath(project.projectId))}>
                          {t("baselines.compare.showOnTimeline")}
                        </Button>
                      </Table.Th>
                      <Table.Td />
                      <Table.Td><Span span={project.baselineSpan} /></Table.Td>
                      <Table.Td><Span span={project.span} /></Table.Td>
                      <Table.Td ta="right">{signedDays(project.movement.startDays)}</Table.Td>
                      <Table.Td ta="right">{signedDays(project.movement.endDays)}</Table.Td>
                      <Table.Td />
                      <Table.Td style={SHRINK}>
                        <StatusBadge status={movementStatus(project.movement)} />
                      </Table.Td>
                    </Table.Tr>
                    {milestones.map((row) => (
                      <Table.Tr key={row.milestoneId}>
                        <Table.Td ps="xl">
                          <Text size="sm">
                            {row.name}
                            <VisuallyHidden> {t("baselines.compare.inProject", { project: project.name })}</VisuallyHidden>
                          </Text>
                        </Table.Td>
                        <Table.Td style={NO_WRAP}>{row.teamName}</Table.Td>
                        <Table.Td><Figures figures={row.frozen} /></Table.Td>
                        <Table.Td><Figures figures={row.live} /></Table.Td>
                        <Table.Td ta="right">{signedDays(row.movement.startDays)}</Table.Td>
                        <Table.Td ta="right">{signedDays(row.movement.endDays)}</Table.Td>
                        <Table.Td style={NO_WRAP}>{estimateText(row)}</Table.Td>
                        <Table.Td style={SHRINK}>
                          <StatusBadge status={movementStatus(row.movement)} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                );
              })
            )}
          </Table>
        </ScrollRegion>
      </Stack>
    </Stack>
  );
}

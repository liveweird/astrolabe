import { useTranslation } from "react-i18next";
import { Badge, CloseButton, Group, Select, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { DeviationConnection, DeviationFilter, DeviationLevel, DeviationSeverity } from "../api/deviations";
import { getPlanView, type PlanView } from "../api/plan";
import { listTeams } from "../api/teams";
import { deviationKindLabel } from "../utils/deviations";
import { deviationStatus, deviationStatusPatch, narrowingCount, type DeviationStatus } from "../utils/deviationFilters";
import FilterPanel from "./FilterPanel";

const LEVELS: readonly DeviationLevel[] = ["PROGRAM", "PROJECT", "MILESTONE"];
const SEVERITIES: readonly DeviationSeverity[] = ["WARNING", "INFO"];
const STATUSES: readonly DeviationStatus[] = ["open", "acknowledged", "all"];

const idOf = (value: string | null) => (value === null ? undefined : Number(value));

/** The names the URL's ids stand for, from the plan view (everyone reads it): the scope chips say "Project: Checkout", not a number. */
function planNames(plan: PlanView | undefined) {
  const projects = new Map<number, string>();
  const programs = new Map<number, string>();
  for (const stream of plan?.workStreams ?? []) {
    for (const program of stream.programs) {
      programs.set(program.id, program.name);
      for (const project of program.projects) projects.set(project.id, project.name);
    }
  }
  return { projects, programs };
}

/** The filters that are not a select: removable chips for a project, program or deviation kind the URL scopes the page to (visible with the panel collapsed). */
function ScopeChips({ filter, plan, onChange }: { filter: DeviationFilter; plan: PlanView | undefined; onChange: (patch: Partial<DeviationFilter>) => void }) {
  const { t } = useTranslation();
  const names = planNames(plan);
  const chips = [
    filter.projectId === undefined ? null : { key: "project", text: t("deviations.filter.project", { name: names.projects.get(filter.projectId) ?? t("deviations.filter.projectUnknown", { id: filter.projectId }) }), remove: t("deviations.filter.removeProject"), clear: { projectId: undefined } },
    filter.programId === undefined ? null : { key: "program", text: t("deviations.filter.program", { name: names.programs.get(filter.programId) ?? t("deviations.filter.programUnknown", { id: filter.programId }) }), remove: t("deviations.filter.removeProgram"), clear: { programId: undefined } },
    filter.kind === undefined ? null : { key: "kind", text: t("deviations.filter.kind", { name: deviationKindLabel(filter.kind, t) }), remove: t("deviations.filter.removeKind"), clear: { kind: undefined } },
  ].filter((chip) => chip !== null);
  if (chips.length === 0) return null;
  return (
    <Group gap="xs" role="group" aria-label={t("deviations.filter.scopeAria")}>
      {chips.map((chip) => (
        <Badge key={chip.key} color="gray" variant="light" tt="none" size="lg" rightSection={<CloseButton size="xs" aria-label={chip.remove} onClick={() => onChange(chip.clear)} />}>
          {chip.text}
        </Badge>
      ))}
    </Group>
  );
}

/**
 * The Deviations page's filters, which live in the URL (`utils/deviationFilters.ts`): a select each for connection, plan item type, severity, work
 * stream and team inside the collapsible panel, the Status select (Open / Acknowledged / All), the "Show everything" switch (`all=true`: items without a deviation and estimates that cannot be
 * compared), and removable chips for a project / program / kind scope. The work stream and team options come from the plan view and the teams list.
 */
export default function DeviationsFilters({ filter, connections, onChange }: { filter: DeviationFilter; connections: readonly DeviationConnection[]; onChange: (patch: Partial<DeviationFilter>) => void }) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: ["plan", "view"], queryFn: getPlanView });
  const teams = useQuery({ queryKey: ["teams", "options"], queryFn: () => listTeams({ page: 1, pageSize: 100, sort: "name" }) });
  // A project or team scope implies "everything" (the server's rule), so the switch reads ON then, and turning it off sends `all=false` explicitly.
  const implied = filter.projectId !== undefined || filter.teamId !== undefined;
  const value = (id: number | undefined) => (id === undefined ? null : String(id));
  return (
    <FilterPanel activeFilterCount={narrowingCount(filter)} storageKey="deviations" aside={<ScopeChips filter={filter} plan={plan.data} onChange={onChange} />}>
        {/* Open is the server's default (no parameter); the choice composes with a project or team scope as the server does (`deviationStatusPatch`). Never clearable: a status always applies. */}
        <Select
          label={t("deviations.filter.status")}
          data={STATUSES.map((status) => ({ value: status, label: t(`deviations.filter.status_${status}`) }))}
          value={deviationStatus(filter)}
          onChange={(selected) => selected !== null && onChange(deviationStatusPatch(selected as DeviationStatus, filter))}
          allowDeselect={false}
        />
        <Select
          label={t("deviations.filter.connection")}
          placeholder={t("common.state.any")}
          data={connections.map((connection) => ({ value: String(connection.id), label: connection.name }))}
          value={value(filter.connectionId)}
          onChange={(selected) => onChange({ connectionId: idOf(selected) })}
          clearable
          clearButtonProps={{ "aria-label": t("deviations.filter.clearConnection") }}
        />
        <Select
          label={t("deviations.filter.level")}
          placeholder={t("common.state.any")}
          data={LEVELS.map((level) => ({ value: level, label: t(`jira.mapping.level.${level.toLowerCase() as "program" | "project" | "milestone"}`) }))}
          value={filter.level ?? null}
          onChange={(selected) => onChange({ level: (selected ?? undefined) as DeviationLevel | undefined })}
          clearable
          clearButtonProps={{ "aria-label": t("deviations.filter.clearLevel") }}
        />
        <Select
          label={t("deviations.filter.severity")}
          placeholder={t("common.state.any")}
          data={SEVERITIES.map((severity) => ({ value: severity, label: t(`deviations.severity.${severity}`) }))}
          value={filter.severity ?? null}
          onChange={(selected) => onChange({ severity: (selected ?? undefined) as DeviationSeverity | undefined })}
          clearable
          clearButtonProps={{ "aria-label": t("deviations.filter.clearSeverity") }}
        />
        <Select
          label={t("deviations.filter.workStream")}
          placeholder={t("common.state.any")}
          data={(plan.data?.workStreams ?? []).map((stream) => ({ value: String(stream.id), label: stream.name }))}
          value={value(filter.workStreamId)}
          onChange={(selected) => onChange({ workStreamId: idOf(selected) })}
          searchable
          clearable
          clearButtonProps={{ "aria-label": t("deviations.filter.clearWorkStream") }}
        />
        <Select
          label={t("deviations.filter.team")}
          placeholder={t("common.state.any")}
          data={(teams.data?.items ?? []).map((team) => ({ value: String(team.id), label: team.name }))}
          value={value(filter.teamId)}
          onChange={(selected) => onChange({ teamId: idOf(selected) })}
          searchable
          clearable
          clearButtonProps={{ "aria-label": t("deviations.filter.clearTeam") }}
        />
        {/* The hint is plain text, not the Switch's dimmed description: that gray fails AA on this panel's tinted surface in the dark scheme. */}
        <Stack gap={4} maw={320}>
          <Switch label={t("deviations.filter.showAll")} checked={filter.all ?? implied} onChange={(event) => onChange({ all: event.currentTarget.checked ? true : implied ? false : undefined })} aria-describedby="deviations-show-all-hint" />
          <Text size="xs" id="deviations-show-all-hint">
            {t("deviations.filter.showAllHint")}
          </Text>
        </Stack>
    </FilterPanel>
  );
}

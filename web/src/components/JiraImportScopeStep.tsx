import { useTranslation } from "react-i18next";
import { Button, Group, MultiSelect, Select, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { JiraConnection } from "../api/jira";
import { getPlanView } from "../api/plan";
import type { ImportFailure } from "../utils/jiraImportText";
import { toScope, type ScopeForm } from "../utils/jiraImport";
import ErrorAlert from "./ErrorAlert";
import JiraImportFailureAlert from "./JiraImportFailureAlert";
import PersonSelect from "./PersonSelect";
import TeamSelect from "./TeamSelect";

/**
 * The first phase: what to import and where. One work stream is picked (work streams are never imported; every created item lands under
 * it), the owner of what is created, an optional default team / program / project for the orphans, the Jira projects to read (all of
 * them preselected: narrowing is how a scope over 2,000 issues is cut down) and whether Jira's dates are copied. The work streams, programs
 * and projects come from the plan view (`["plan","view"]`, shared with the Plan page): the defaults are offered only from the picked stream,
 * which is the server's own rule (a default elsewhere is a 400).
 */
export default function JiraImportScopeStep({
  connection,
  form,
  failure,
  reading,
  onChange,
  onPreview,
  onClose,
}: {
  connection: JiraConnection;
  form: ScopeForm;
  failure: ImportFailure | null;
  reading: boolean;
  onChange: (patch: Partial<ScopeForm>) => void;
  onPreview: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: ["plan", "view"], queryFn: getPlanView });
  const streams = plan.data?.workStreams ?? [];
  const stream = streams.find((candidate) => String(candidate.id) === form.workStreamId);
  const programs = (stream?.programs ?? []).map((program) => ({ value: String(program.id), label: program.name }));
  const projects = (stream?.programs ?? []).flatMap((program) =>
    program.projects.map((project) => ({ value: String(project.id), label: t("jira.import.scope.projectOption", { name: project.name, program: program.name }) })),
  );
  const ready = toScope(form, connection.projectKeys) !== null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !reading) onPreview();
      }}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {t("jira.import.scope.intro")}
        </Text>
        {plan.isError && <ErrorAlert error={plan.error} title={t("jira.import.scope.planFailed")} />}
        <Select
          label={t("jira.import.scope.workStream")}
          description={t("jira.import.scope.workStreamHint")}
          placeholder={t("jira.import.scope.pickWorkStream")}
          data={streams.map((candidate) => ({ value: String(candidate.id), label: candidate.endDate ? t("jira.import.scope.closedName", { name: candidate.name }) : candidate.name }))}
          value={form.workStreamId}
          onChange={(value) => onChange({ workStreamId: value, programId: null, projectId: null })}
          searchable
          withAsterisk
          allowDeselect={false}
          nothingFoundMessage={t("jira.import.scope.noWorkStreams")}
          disabled={reading}
        />
        <PersonSelect
          label={t("jira.import.scope.owner")}
          description={t("jira.import.scope.ownerHint")}
          placeholder={t("plan.pickOwner")}
          clearLabel={t("plan.clearOwner")}
          picked={form.owner}
          onPick={(owner) => onChange({ owner })}
          disabled={reading}
        />
        <MultiSelect
          label={t("jira.import.scope.keys")}
          description={t("jira.import.scope.keysHint")}
          data={connection.projectKeys}
          value={form.keys}
          onChange={(keys) => onChange({ keys })}
          withAsterisk
          disabled={reading}
          error={form.keys.length === 0 ? t("jira.import.scope.keysRequired") : undefined}
        />
        <Switch
          label={t("jira.import.scope.copyDates")}
          description={t("jira.import.scope.copyDatesHint")}
          checked={form.copyDates}
          onChange={(event) => onChange({ copyDates: event.currentTarget.checked })}
          disabled={reading}
        />
        <TeamSelect
          label={t("jira.import.scope.team")}
          description={t("jira.import.scope.teamHint")}
          picked={form.team}
          onPick={(team) => onChange({ team })}
          disabled={reading}
        />
        <Group grow align="flex-start">
          <Select
            label={t("jira.import.scope.program")}
            description={t("jira.import.scope.programHint")}
            placeholder={t("jira.import.scope.none")}
            data={programs}
            value={form.programId}
            onChange={(programId) => onChange({ programId })}
            searchable
            clearable
            clearButtonProps={{ "aria-label": t("jira.import.scope.clearProgram") }}
            disabled={reading || stream === undefined}
          />
          <Select
            label={t("jira.import.scope.project")}
            description={t("jira.import.scope.projectHint")}
            placeholder={t("jira.import.scope.none")}
            data={projects}
            value={form.projectId}
            onChange={(projectId) => onChange({ projectId })}
            searchable
            clearable
            clearButtonProps={{ "aria-label": t("jira.import.scope.clearProject") }}
            disabled={reading || stream === undefined}
          />
        </Group>
        {failure && <JiraImportFailureAlert failure={failure} />}
        <Group justify="flex-end" gap="sm">
          <Button type="button" variant="default" onClick={onClose} disabled={reading}>
            {t("common.action.cancel")}
          </Button>
          <Button type="submit" disabled={!ready || reading} loading={reading}>
            {t("jira.import.scope.preview")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

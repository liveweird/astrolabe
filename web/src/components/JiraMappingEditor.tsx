import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert, Button, Fieldset, Group, List, NumberInput, Select, SimpleGrid, Stack, Text, type ComboboxItem } from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconAlertTriangle } from "@tabler/icons-react";
import { ApiError } from "../api/http";
import { isJiraNotDiscovered, isJiraTokenUnreadable, putJiraMapping, type JiraDiscovery, type JiraEstimateUnit, type JiraMapping, type JiraMappingResponse } from "../api/jira";
import {
  fieldOptions,
  fromMapping,
  levelOptions,
  MAPPING_LEVELS,
  mappingFormValidation,
  MAX_MAN_DAYS_PER_UNIT,
  toMapping,
  type FieldKind,
  type MappingFormValues,
  type MappingLevel,
} from "../utils/jiraMappingForm";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";

const UNITS = ["POINTS", "HOURS", "DAYS"] as const satisfies readonly JiraEstimateUnit[];

/** A failed save in words: the 409s by their problem type, a 400 as the server's own sentence (it names the field or level) under a fixed lead. */
function saveFailure(err: unknown, t: TFunction): { message: string; detail?: string } {
  if (isJiraNotDiscovered(err)) return { message: t("jira.mapping.notDiscovered") };
  if (isJiraTokenUnreadable(err)) return { message: t("jira.mapping.tokenUnreadable") };
  if (err instanceof ApiError && err.status === 400) return { message: t("jira.mapping.rejected"), detail: err.detail };
  return {
    message: saveErrorMessage(err, t, {
      forbidden: "jira.saveForbidden",
      notFound: "jira.saveGone",
      failedStatus: "common.error.saveFailedStatus",
      failed: "common.error.saveFailedNetwork",
    }),
  };
}

type Defaults = JiraMapping | null | undefined;

/**
 * The "default" marker of a select lives OUTSIDE the closed value, which would cut it off in a narrow column: the list marks the default
 * option, and a short note under the select says the shown value is the default. The select's label stays "name — id" only.
 */
function defaultMarks(defaultValue: string | null | undefined, current: string | null, t: TFunction) {
  return {
    renderOption: ({ option }: { option: ComboboxItem }) => (
      <Group gap="xs" justify="space-between" wrap="nowrap" w="100%">
        <span>{option.label}</span>
        {defaultValue != null && option.value === defaultValue && (
          <Text size="xs" c="dimmed" component="span">
            {t("jira.mapping.defaultSuffix")}
          </Text>
        )}
      </Group>
    ),
    description: defaultValue != null && current === defaultValue ? t("jira.mapping.defaultNote") : undefined,
    inputWrapperOrder: ["label", "input", "description", "error"] as ("label" | "input" | "description" | "error")[],
  };
}

/**
 * The field mapping of a connection: which Jira hierarchy level is a program / project / milestone (the milestone level is required, the
 * other two can stay unset), per level the start / end (date fields) and estimate (number field), the estimate's unit and the factor to
 * man-days (meaningless for DAYS: hidden and not sent), and the Team field. The form opens on the SAVED mapping, else on the defaults
 * the discovery resolved ("(default)" marks them in the lists). A saved mapping that no longer fits the site opens as saved - its
 * stale level or field stays selectable, flagged - with the server's `problems[]` as amber lines above, so it can be corrected.
 */
export default function JiraMappingEditor({
  connectionId,
  discovery,
  response,
  onSaved,
}: {
  connectionId: number;
  discovery: JiraDiscovery;
  response: JiraMappingResponse;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const defaults: Defaults = response.defaults;
  const saved = response.mapping !== null;
  const form = useForm<MappingFormValues>({
    initialValues: fromMapping(response.mapping ?? response.defaults),
    validate: mappingFormValidation(t),
  });
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null);

  async function save(values: MappingFormValues) {
    setFailure(null);
    setSubmitting(true);
    try {
      await putJiraMapping(connectionId, toMapping(values));
      showSuccessToast(t("jira.toast.mappingSaved"));
      await onSaved();
    } catch (err) {
      setFailure(saveFailure(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  function changeLevel(level: MappingLevel, next: string | null) {
    const path = `levels.${level}` as const;
    const previous = form.values.levels[level];
    form.setFieldValue(`${path}.hierarchyLevel`, next);
    // Turning a level on starts from the defaults' fields for it (when it has none yet), so the choice is one click, not four.
    const fromDefaults = defaults?.levels[level]?.fields;
    if (previous.hierarchyLevel === null && next !== null && fromDefaults && !previous.start && !previous.end && !previous.estimate) {
      form.setFieldValue(`${path}.start`, fromDefaults.start ?? null);
      form.setFieldValue(`${path}.end`, fromDefaults.end ?? null);
      form.setFieldValue(`${path}.estimate`, fromDefaults.estimate ?? null);
    }
  }

  const fieldSelect = (level: MappingLevel, slot: "start" | "end" | "estimate", kind: FieldKind) => (
    <Select
      key={`${level}.${slot}`}
      label={t(`jira.mapping.slot.${slot}`)}
      placeholder={t("jira.mapping.notMapped")}
      data={fieldOptions(discovery, kind, form.values.levels[level][slot], t)}
      {...defaultMarks(defaults?.levels[level]?.fields?.[slot], form.values.levels[level][slot], t)}
      searchable
      clearable
      disabled={form.values.levels[level].hierarchyLevel === null}
      {...form.getInputProps(`levels.${level}.${slot}`)}
    />
  );

  const unitDays = form.values.unit === "DAYS";
  const teamIsDefault = defaults?.teamFieldId != null && form.values.teamFieldId === defaults.teamFieldId;
  return (
    <form onSubmit={form.onSubmit(save)} noValidate aria-label={t("jira.mapping.formAria")}>
      <Stack gap="md">
        {response.problems.length > 0 && (
          <Alert color="orange" variant="light" role="note" icon={<IconAlertTriangle size={16} />} title={t("jira.mapping.problemsTitle")}>
            <List size="sm" spacing={2}>
              {response.problems.map((problem) => (
                <List.Item key={problem}>{problem}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Text size="sm" c="dimmed">
          {saved ? t("jira.mapping.sourceSaved") : t("jira.mapping.sourceDefaults")}
        </Text>

        {MAPPING_LEVELS.map((level) => (
          <Fieldset key={level} legend={t(`jira.mapping.level.${level}`)}>
            <Stack gap="sm">
              <Select
                label={t("jira.mapping.hierarchyLevel")}
                description={
                  (level === "milestone" ? t("jira.mapping.milestoneHint") : t(`jira.mapping.optionalHint.${level}`)) +
                  (defaults?.levels[level] && String(defaults.levels[level].hierarchyLevel) === form.values.levels[level].hierarchyLevel
                    ? ` ${t("jira.mapping.defaultNote")}.`
                    : "")
                }
                placeholder={t("jira.mapping.notMapped")}
                data={levelOptions(discovery, form.values.levels[level].hierarchyLevel, t)}
                renderOption={defaultMarks(defaults?.levels[level] ? String(defaults.levels[level].hierarchyLevel) : null, null, t).renderOption}
                clearable={level !== "milestone"}
                allowDeselect={level !== "milestone"}
                value={form.values.levels[level].hierarchyLevel}
                onChange={(next) => changeLevel(level, next)}
                error={form.errors[`levels.${level}.hierarchyLevel`]}
              />
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                {fieldSelect(level, "start", "date")}
                {fieldSelect(level, "end", "date")}
                {fieldSelect(level, "estimate", "number")}
              </SimpleGrid>
            </Stack>
          </Fieldset>
        ))}

        <Fieldset legend={t("jira.mapping.estimateTitle")}>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <Select
              label={t("jira.mapping.unit")}
              description={t("jira.mapping.unitHint")}
              data={UNITS.map((unit) => ({ value: unit, label: t(`jira.mapping.unitOption.${unit}`) }))}
              allowDeselect={false}
              {...form.getInputProps("unit")}
            />
            {!unitDays && (
              <NumberInput
                label={t("jira.mapping.factor")}
                description={t("jira.mapping.factorHint")}
                min={0}
                max={MAX_MAN_DAYS_PER_UNIT}
                decimalScale={2}
                allowNegative={false}
                value={form.values.manDaysPerUnit}
                onChange={(next) => form.setFieldValue("manDaysPerUnit", String(next))}
                error={form.errors.manDaysPerUnit}
              />
            )}
            <Select
              label={t("jira.mapping.teamField")}
              description={t("jira.mapping.teamFieldHint") + (teamIsDefault ? ` ${t("jira.mapping.defaultNote")}.` : "")}
              placeholder={t("jira.mapping.notMapped")}
              data={fieldOptions(discovery, "team", form.values.teamFieldId, t)}
              renderOption={defaultMarks(defaults?.teamFieldId, null, t).renderOption}
              searchable
              clearable
              {...form.getInputProps("teamFieldId")}
            />
          </SimpleGrid>
        </Fieldset>

        {failure && (
          <FormErrorAlert>
            <Text size="sm">{failure.message}</Text>
            {failure.detail && (
              <Text size="sm" mt={4}>
                {failure.detail}
              </Text>
            )}
          </FormErrorAlert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button
            type="button"
            variant="default"
            disabled={submitting || !defaults}
            onClick={() => {
              setFailure(null);
              form.setValues(fromMapping(defaults));
              form.clearErrors();
            }}
          >
            {t("jira.mapping.useDefaults")}
          </Button>
          <Button type="submit" loading={submitting}>
            {t("jira.mapping.save")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

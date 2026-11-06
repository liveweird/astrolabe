import type { TFunction } from "i18next";
import type { JiraDiscovery, JiraEstimateUnit, JiraLevelMapping, JiraMapping } from "../api/jira";

/** The three plan levels that map to a Jira hierarchy level (work streams are categories and never do), top down. */
export const MAPPING_LEVELS = ["program", "project", "milestone"] as const;
export type MappingLevel = (typeof MAPPING_LEVELS)[number];

/** The server's bound on the man-days-per-unit factor (`MAX_MAN_DAYS_PER_UNIT`). */
export const MAX_MAN_DAYS_PER_UNIT = 1000;

/** A level's form state: the Jira hierarchy level as a string (the Select's value type), null = not mapped; the field ids, null = not mapped. */
export type LevelFormValues = {
  hierarchyLevel: string | null;
  start: string | null;
  end: string | null;
  estimate: string | null;
};

export type MappingFormValues = {
  levels: Record<MappingLevel, LevelFormValues>;
  unit: JiraEstimateUnit;
  /** The factor as typed (the NumberInput hands back text for a half-typed "1."); "" = none (the Jira figure is then shown, never compared). Ignored - and not sent - for DAYS. */
  manDaysPerUnit: string;
  teamFieldId: string | null;
};

const EMPTY_LEVEL: LevelFormValues = { hierarchyLevel: null, start: null, end: null, estimate: null };

function levelFromMapping(level: JiraLevelMapping | null | undefined): LevelFormValues {
  if (!level) return EMPTY_LEVEL;
  return {
    hierarchyLevel: String(level.hierarchyLevel),
    start: level.fields?.start ?? null,
    end: level.fields?.end ?? null,
    estimate: level.fields?.estimate ?? null,
  };
}

/** The form values of a mapping document (the saved one, or the defaults); null = an empty form. */
export function fromMapping(mapping: JiraMapping | null | undefined): MappingFormValues {
  return {
    levels: {
      program: levelFromMapping(mapping?.levels.program),
      project: levelFromMapping(mapping?.levels.project),
      milestone: levelFromMapping(mapping?.levels.milestone),
    },
    unit: mapping?.estimate?.unit ?? "POINTS",
    manDaysPerUnit: mapping?.estimate?.manDaysPerUnit == null ? "" : String(mapping.estimate.manDaysPerUnit),
    teamFieldId: mapping?.teamFieldId ?? null,
  };
}

function levelToMapping(level: LevelFormValues): JiraLevelMapping | null {
  if (level.hierarchyLevel === null) return null;
  return { hierarchyLevel: Number(level.hierarchyLevel), fields: { start: level.start, end: level.end, estimate: level.estimate } };
}

/** The wire document. The program and project levels are optional (null = unset); the factor is dropped for DAYS (the server ignores it). */
export function toMapping(values: MappingFormValues): JiraMapping {
  const milestone = levelToMapping(values.levels.milestone);
  if (milestone === null) throw new Error("the milestone level is required");
  return {
    levels: { program: levelToMapping(values.levels.program), project: levelToMapping(values.levels.project), milestone },
    estimate: { unit: values.unit, manDaysPerUnit: values.unit === "DAYS" || values.manDaysPerUnit.trim() === "" ? null : Number(values.manDaysPerUnit) },
    teamFieldId: values.teamFieldId,
  };
}

/** At most two decimals, whatever the float noise: 0.5 and 1.25 pass, 0.125 does not. */
function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

/**
 * Validation rules mirroring the server's shape rules (`validateMappingShape`): the milestone level is required, present levels strictly
 * decrease program > project > milestone (a skipped level is fine), and the factor is greater than 0 and at most 1000 with at most two
 * decimals. The rules that need the discovery (a level exists, a field has its type) are the server's: its 400 reaches the form.
 */
export function mappingFormValidation(t: TFunction) {
  const orderProblem = (upper: LevelFormValues, lower: LevelFormValues): boolean =>
    upper.hierarchyLevel !== null && lower.hierarchyLevel !== null && Number(upper.hierarchyLevel) <= Number(lower.hierarchyLevel);
  return {
    "levels.milestone.hierarchyLevel": (value: string | null) => (value === null ? t("jira.mapping.validation.milestoneRequired") : null),
    "levels.project.hierarchyLevel": (_: string | null, values: MappingFormValues) =>
      orderProblem(values.levels.project, values.levels.milestone) ? t("jira.mapping.validation.levelOrder") : null,
    "levels.program.hierarchyLevel": (_: string | null, values: MappingFormValues) =>
      orderProblem(values.levels.program, values.levels.project) || orderProblem(values.levels.program, values.levels.milestone)
        ? t("jira.mapping.validation.levelOrder")
        : null,
    manDaysPerUnit: (value: string, values: MappingFormValues) => {
      if (values.unit === "DAYS" || value.trim() === "") return null;
      const factor = Number(value);
      return Number.isFinite(factor) && factor > 0 && factor <= MAX_MAN_DAYS_PER_UNIT && hasAtMostTwoDecimals(factor)
        ? null
        : t("jira.mapping.validation.factor");
    },
  };
}

export type SelectOption = { value: string; label: string };

/** "Level 1 — Epic" (several types at one level: "Level 1 — Epic, Feature"); the site's own levels, top down, and `current` flagged when the site lacks it. */
export function levelOptions(discovery: JiraDiscovery, current: string | null, t: TFunction): SelectOption[] {
  const options = [...discovery.levels]
    .sort((a, b) => b.level - a.level)
    .map((level): SelectOption => ({
      value: String(level.level),
      label: t("jira.mapping.levelOption", { level: level.level, types: level.typeNames.join(", ") }),
    }));
  if (current !== null && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: t("jira.mapping.levelMissing", { level: current }) });
  }
  return options;
}

export type FieldKind = "date" | "number" | "team";

/** Whether a discovered field fits a slot: a date field for start/end, a number for the estimate, the site's `atlassian-team` field for the team. */
function fitsKind(field: JiraDiscovery["fields"][number], kind: FieldKind): boolean {
  if (kind === "team") return field.custom?.includes("atlassian-team") === true;
  return field.type === kind;
}

/**
 * The options of a field Select, filtered by type and sorted by name: "Target start — customfield_10015". The default is NOT part of the
 * label (a closed value must never be cut off by it): the editor marks it in the list and under the select. A stored id the discovery no longer offers for the slot (gone, or another type) is kept as a flagged option, so a mapping
 * with problems is still displayed as saved and can be corrected rather than silently replaced.
 */
export function fieldOptions(discovery: JiraDiscovery, kind: FieldKind, current: string | null, t: TFunction): SelectOption[] {
  const options = discovery.fields
    .filter((field) => fitsKind(field, kind))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((field): SelectOption => ({ value: field.id, label: t("jira.mapping.fieldOption", { name: field.name, id: field.id }) }));
  if (current !== null && !options.some((option) => option.value === current)) {
    const known = discovery.fields.find((field) => field.id === current);
    options.push({
      value: current,
      label: known
        ? t("jira.mapping.fieldWrongType", { name: known.name, id: known.id, type: known.type ?? "?" })
        : t("jira.mapping.fieldMissing", { id: current }),
    });
  }
  return options;
}

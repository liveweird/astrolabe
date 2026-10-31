import type { TFunction } from "i18next";
import type { MilestoneBody, ProjectMilestone } from "../api/milestones";
import { descriptionRule, nameRule } from "./formRules";
import { isValidIsoDate } from "./isoDate";
import { saveErrorMessage } from "./saveError";
import { isWeekend, toEpochDay } from "./timelineScale";

// Server limits (planning/Milestone.kt — requireNameAndDescription, the estimate rule) mirrored client-side.
export const MAX_MILESTONE_NAME_LENGTH = 100;
export const MAX_MILESTONE_DESCRIPTION_LENGTH = 500;
/** Exclusive upper bound of the estimate: `0 <= x < 1_000_000`, at most two decimals. */
const ESTIMATE_LIMIT = 1_000_000;
const ESTIMATE_DECIMALS = 100;

/** A milestone's plan fields. The team is the Select's string value + its label (kept beside the id so it survives later searches). */
export type MilestoneFormValues = {
  name: string;
  description: string;
  teamId: string | null;
  teamLabel: string | null;
  /** Mantine's `NumberInput` value: a number, or a string while the field is empty or half-typed. */
  estimate: number | string;
};

export const EMPTY_MILESTONE_FORM: MilestoneFormValues = { name: "", description: "", teamId: null, teamLabel: null, estimate: "" };

export function toMilestoneFormValues(milestone: ProjectMilestone): MilestoneFormValues {
  return {
    name: milestone.name,
    description: milestone.description ?? "",
    teamId: String(milestone.teamId),
    teamLabel: milestone.teamName,
    estimate: milestone.estimateMd,
  };
}

/** The man-day figure of the field, or `null` when it is not a number yet. */
function estimateOf(value: number | string): number | null {
  if (value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function milestoneFormValidation(t: TFunction) {
  return {
    name: nameRule(t, "project.validation.nameLength", MAX_MILESTONE_NAME_LENGTH),
    description: descriptionRule(t, "project.validation.descriptionLength", MAX_MILESTONE_DESCRIPTION_LENGTH),
    teamId: (value: string | null) => (value === null ? t("project.validation.teamRequired") : null),
    estimate: (value: number | string) => {
      const estimate = estimateOf(value);
      if (estimate === null) return t("project.validation.estimateRequired");
      const decimalsOk = Math.abs(Math.round(estimate * ESTIMATE_DECIMALS) - estimate * ESTIMATE_DECIMALS) < 1e-6;
      return estimate >= 0 && estimate < ESTIMATE_LIMIT && decimalsOk ? null : t("project.validation.estimateInvalid");
    },
  };
}

/** A blank description travels as null (the server stores NULL, never ""); a PUT is a full replace and never carries dates. */
export function toMilestoneBody(values: MilestoneFormValues): MilestoneBody {
  const description = values.description.trim();
  return {
    name: values.name.trim(),
    description: description === "" ? null : description,
    teamId: Number(values.teamId),
    estimateMd: estimateOf(values.estimate) ?? 0,
  };
}

/** The milestone save vocabulary — a 409 is the name clash within the project and is handled by the editor. */
export function milestoneSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "project.saveForbidden",
    notFound: "project.saveGone",
    invalid: "project.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

// ---- the schedule dialog -----------------------------------------------------------------------------------------

export type ScheduleFormValues = { startDate: string | null; endDate: string | null };

const present = (value: string | null): value is string => value !== null && value !== "";

/** Does `[start, end]` (valid ISO dates, end not before start) contain a Monday–Friday? Any span of seven days does. */
export function hasWorkingDay(start: string, end: string): boolean {
  const first = toEpochDay(start);
  const last = Math.min(toEpochDay(end), first + 6);
  for (let day = first; day <= last; day += 1) if (!isWeekend(day)) return true;
  return false;
}

/** Both dates, real calendar days, the end not before the start, at least one working day — what the server enforces on the schedule PUT. */
export function scheduleFormValidation(t: TFunction) {
  return {
    startDate: (value: string | null) => {
      if (!present(value)) return t("project.validation.startRequired");
      return isValidIsoDate(value) ? null : t("project.validation.dateShape");
    },
    endDate: (value: string | null, values: ScheduleFormValues) => {
      if (!present(value)) return t("project.validation.endRequired");
      if (!isValidIsoDate(value)) return t("project.validation.dateShape");
      if (!present(values.startDate) || !isValidIsoDate(values.startDate)) return null;
      if (value < values.startDate) return t("project.validation.endBeforeStart");
      return hasWorkingDay(values.startDate, value) ? null : t("project.validation.noWorkingDay");
    },
  };
}

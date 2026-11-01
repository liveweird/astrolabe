import type { TFunction } from "i18next";
import type { CapacityPeriod, CapacityPeriodBody } from "../api/teams";
import { isValidIsoDate } from "./isoDate";
import { saveErrorMessage } from "./saveError";

// Server limits (teams/TeamCapacity.kt, infra/validation/Dates.kt) mirrored client-side. NO weekday rule: a capacity period may start
// on ANY calendar day (a weekend date applies from the next working day) — the server accepts it, so the form must not refuse it.
/** Exclusive upper bound of man-days per week: `0 <= x < 1_000_000`, at most two decimals. */
const MAN_DAYS_LIMIT = 1_000_000;
const MAN_DAYS_DECIMALS = 100;
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;
const MIN_WIP_LIMIT = 1;
const MAX_WIP_LIMIT = 99;

/** A capacity period's fields. The numbers are Mantine's `NumberInput` values: a number, or a string while the field is empty or half-typed. */
export type CapacityFormValues = {
  effectiveFrom: string | null;
  mdPerWeek: number | string;
  /** Empty = no limit. */
  wipLimit: number | string;
};

export const EMPTY_CAPACITY_FORM: CapacityFormValues = { effectiveFrom: null, mdPerWeek: "", wipLimit: "" };

export function fromCapacityPeriod(period: CapacityPeriod): CapacityFormValues {
  return { effectiveFrom: period.effectiveFrom, mdPerWeek: period.mdPerWeek, wipLimit: period.wipLimit ?? "" };
}

/** The number in a field, or `null` when it is empty or not a number yet. */
function numberOf(value: number | string): number | null {
  if (value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

const present = (value: string | null): value is string => value !== null && value !== "";

export function capacityFormValidation(t: TFunction) {
  return {
    effectiveFrom: (value: string | null) => {
      if (!present(value) || !isValidIsoDate(value)) return t("teams.view.validation.date");
      const year = Number(value.slice(0, 4));
      return year >= MIN_YEAR && year <= MAX_YEAR ? null : t("teams.view.validation.date");
    },
    mdPerWeek: (value: number | string) => {
      const manDays = numberOf(value);
      if (manDays === null) return t("teams.view.validation.manDays");
      const decimalsOk = Math.abs(Math.round(manDays * MAN_DAYS_DECIMALS) - manDays * MAN_DAYS_DECIMALS) < 1e-6;
      return manDays >= 0 && manDays < MAN_DAYS_LIMIT && decimalsOk ? null : t("teams.view.validation.manDays");
    },
    wipLimit: (value: number | string) => {
      if (value === "") return null;
      const limit = numberOf(value);
      return limit !== null && Number.isInteger(limit) && limit >= MIN_WIP_LIMIT && limit <= MAX_WIP_LIMIT ? null : t("teams.view.validation.wipLimit");
    },
  };
}

/** The wire body: an empty WIP limit travels as an explicit null (a PUT is a full replace, so null clears the limit). */
export function toCapacityBody(values: CapacityFormValues): CapacityPeriodBody {
  return {
    effectiveFrom: values.effectiveFrom ?? "",
    mdPerWeek: numberOf(values.mdPerWeek) ?? 0,
    wipLimit: numberOf(values.wipLimit),
  };
}

/** The capacity save vocabulary — a 409 is the date clash and is handled by the dialog (it marks the date field). */
export function capacitySaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "teams.view.saveForbidden",
    notFound: "teams.view.saveGone",
    invalid: "teams.view.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

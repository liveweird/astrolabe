import type { TFunction } from "i18next";
import type { Baseline, BaselineCreateBody, BaselineUpdateBody } from "../api/baselines";
import { descriptionRule, nameRule } from "./formRules";
import { saveErrorMessage } from "./saveError";

// Server limits (planning/Baseline.kt) mirrored client-side.
export const MAX_BASELINE_NAME_LENGTH = 100;
export const MAX_BASELINE_DESCRIPTION_LENGTH = 500;

export type BaselineFormValues = { name: string; description: string };

export const EMPTY_BASELINE_FORM: BaselineFormValues = { name: "", description: "" };

export function toBaselineFormValues(baseline: Baseline): BaselineFormValues {
  return { name: baseline.name, description: baseline.description ?? "" };
}

/** Validation rules shared by the take and rename modes of the editor (mirrors the server's checks). */
export function baselineFormValidation(t: TFunction) {
  return {
    name: nameRule(t, "baselines.validation.nameLength", MAX_BASELINE_NAME_LENGTH),
    description: descriptionRule(t, "baselines.validation.descriptionLength", MAX_BASELINE_DESCRIPTION_LENGTH),
  };
}

/** The wire body: a blank description travels as null (the server stores NULL, never ""); a PUT is a full replace. */
export function toBaselineBody(values: BaselineFormValues): BaselineCreateBody & BaselineUpdateBody {
  const description = values.description.trim();
  return { name: values.name.trim(), description: description === "" ? null : description };
}

/** The baseline save vocabulary — the 409 (a name clash, or the cap on a take) is told apart by the caller. */
export function baselineSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "baselines.saveForbidden",
    notFound: "baselines.saveGone",
    invalid: "baselines.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

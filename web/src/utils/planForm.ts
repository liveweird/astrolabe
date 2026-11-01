import type { TFunction } from "i18next";
import type {
  PlanProgram,
  PlanProject,
  PlanWorkStream,
  ProgramBody,
  ProjectCreateBody,
  ProjectUpdateBody,
  TargetWindowBody,
  WorkStreamBody,
} from "../api/plan";
import { descriptionRule, nameRule } from "./formRules";
import { isValidIsoDate } from "./isoDate";
import { saveErrorMessage } from "./saveError";

// Server limits (planning/ — requireNameAndDescription) mirrored client-side, identical on the three levels.
export const MAX_PLAN_NAME_LENGTH = 100;
export const MAX_PLAN_DESCRIPTION_LENGTH = 500;

/** What every plan node shares: the text fields and its OWNER, a person of the people directory (required). */
export type PlanNodeFormValues = {
  name: string;
  description: string;
  /** The picked owner's person id (a string, the Select's value type); null = not picked yet. */
  ownerPersonId: string | null;
  /** The picked owner's display label, kept beside the id so it survives later searches. */
  ownerLabel: string | null;
};

/** Dates are `YYYY-MM-DD` strings on the form and on the wire; null = unset. */
export type WorkStreamFormValues = PlanNodeFormValues & { startDate: string | null; endDate: string | null };
export type ProjectFormValues = PlanNodeFormValues & { targetStart: string | null; targetEnd: string | null };

const EMPTY_NODE: PlanNodeFormValues = { name: "", description: "", ownerPersonId: null, ownerLabel: null };
export const EMPTY_PROGRAM_FORM: PlanNodeFormValues = EMPTY_NODE;
export const EMPTY_WORK_STREAM_FORM: WorkStreamFormValues = { ...EMPTY_NODE, startDate: null, endDate: null };
export const EMPTY_PROJECT_FORM: ProjectFormValues = { ...EMPTY_NODE, targetStart: null, targetEnd: null };

type NodeLike = Pick<PlanProgram, "name" | "description" | "ownerPersonId" | "ownerName">;

export function toNodeFormValues(node: NodeLike): PlanNodeFormValues {
  return { name: node.name, description: node.description ?? "", ownerPersonId: String(node.ownerPersonId), ownerLabel: node.ownerName };
}

export function toWorkStreamFormValues(stream: PlanWorkStream): WorkStreamFormValues {
  return { ...toNodeFormValues(stream), startDate: stream.startDate, endDate: stream.endDate };
}

/** What the project editor needs of a project: the Plan page's `PlanProject` and the project view's own project both satisfy it. */
export type ProjectEditTarget = Pick<PlanProject, "id" | "name" | "description" | "ownerPersonId" | "ownerName" | "targetStart" | "targetEnd"> & {
  can: Pick<PlanProject["can"], "edit" | "editTargetWindow">;
};

export function toProjectFormValues(project: ProjectEditTarget): ProjectFormValues {
  return { ...toNodeFormValues(project), targetStart: project.targetStart, targetEnd: project.targetEnd };
}

const present = (value: string | null): value is string => value !== null && value !== "";

function nodeRules(t: TFunction) {
  return {
    name: nameRule(t, "plan.validation.nameLength", MAX_PLAN_NAME_LENGTH),
    description: descriptionRule(t, "plan.validation.descriptionLength", MAX_PLAN_DESCRIPTION_LENGTH),
    ownerPersonId: (value: string | null) => (value === null ? t("plan.validation.ownerRequired") : null),
  };
}

/** The shared rules of the program editor (name, description, owner) — mirrors the server's checks. */
export const programFormValidation = nodeRules;

/** A work stream also needs a valid start; an end date, when set, is valid and not before it. */
export function workStreamFormValidation(t: TFunction) {
  return {
    ...nodeRules(t),
    startDate: (value: string | null) => {
      if (!present(value)) return t("plan.validation.startRequired");
      return isValidIsoDate(value) ? null : t("plan.validation.dateShape");
    },
    endDate: (value: string | null, values: WorkStreamFormValues) => {
      if (!present(value)) return null;
      if (!isValidIsoDate(value)) return t("plan.validation.dateShape");
      return present(values.startDate) && value < values.startDate ? t("plan.validation.endBeforeStart") : null;
    },
  };
}

/** A project's target window is both dates or neither; the end is not before the start. */
export function projectFormValidation(t: TFunction) {
  return {
    ...nodeRules(t),
    targetStart: (value: string | null, values: ProjectFormValues) => {
      if (!present(value)) return present(values.targetEnd) ? t("plan.validation.windowBoth") : null;
      return isValidIsoDate(value) ? null : t("plan.validation.dateShape");
    },
    targetEnd: (value: string | null, values: ProjectFormValues) => {
      if (!present(value)) return present(values.targetStart) ? t("plan.validation.windowBoth") : null;
      if (!isValidIsoDate(value)) return t("plan.validation.dateShape");
      return present(values.targetStart) && value < values.targetStart ? t("plan.validation.endBeforeStart") : null;
    },
  };
}

/** The target-window dialog's fields (the roadmap and programs pages): dates are `YYYY-MM-DD` strings, null = unset. */
export type TargetWindowFormValues = { targetStart: string | null; targetEnd: string | null };

/**
 * The dialog's Save: BOTH dates, real calendar days, the end not before the start (the rules of `projectFormValidation`'s window, which
 * accepts "neither" because the project editor's other fields can save without it; here "neither" is the dialog's separate Clear button).
 */
export function targetWindowFormValidation(t: TFunction) {
  return {
    targetStart: (value: string | null) => {
      if (!present(value)) return t("plan.validation.startRequired");
      return isValidIsoDate(value) ? null : t("plan.validation.dateShape");
    },
    targetEnd: (value: string | null, values: TargetWindowFormValues) => {
      if (!present(value)) return t("project.validation.endRequired");
      if (!isValidIsoDate(value)) return t("plan.validation.dateShape");
      return present(values.targetStart) && isValidIsoDate(values.targetStart) && value < values.targetStart ? t("plan.validation.endBeforeStart") : null;
    },
  };
}

/** A blank description travels as null (the server stores NULL, never ""); a PUT is a full replace. */
function nodeBody(values: PlanNodeFormValues) {
  const description = values.description.trim();
  return {
    name: values.name.trim(),
    description: description === "" ? null : description,
    ownerPersonId: Number(values.ownerPersonId),
  };
}

export function toProgramBody(values: PlanNodeFormValues): ProgramBody {
  return nodeBody(values);
}

/** An unset end date is explicit null: on PUT it REOPENS a closed stream. */
export function toWorkStreamBody(values: WorkStreamFormValues): WorkStreamBody {
  return { ...nodeBody(values), startDate: values.startDate ?? "", endDate: present(values.endDate) ? values.endDate : null };
}

export function toProjectUpdateBody(values: PlanNodeFormValues): ProjectUpdateBody {
  return nodeBody(values);
}

/** Both dates or neither (validation guarantees it); a null pair clears the window. */
export function toTargetWindowBody(values: ProjectFormValues): TargetWindowBody {
  const set = present(values.targetStart) && present(values.targetEnd);
  return { targetStart: set ? values.targetStart : null, targetEnd: set ? values.targetEnd : null };
}

export function toProjectCreateBody(values: ProjectFormValues): ProjectCreateBody {
  return { ...nodeBody(values), ...toTargetWindowBody(values) };
}

/** The plan save vocabulary — a 409 is the name clash of the level and is handled by the editor. */
export function planSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "plan.saveForbidden",
    notFound: "plan.saveGone",
    invalid: "plan.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

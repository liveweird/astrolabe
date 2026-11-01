import type { TFunction } from "i18next";
import type { DependencyBody, DependencyType, EndpointKind, EndpointRef } from "../api/dependencies";
import type { components } from "../api/schema";
import type { PickedOption } from "../components/SearchPicker";
import { saveErrorMessage } from "./saveError";

/** The server's lag range (V15 CHECK, working days; a negative lag is a lead). */
export const MIN_LAG_DAYS = -365;
export const MAX_LAG_DAYS = 365;

export const DEPENDENCY_TYPES: readonly DependencyType[] = ["FS", "SS", "FF", "SF"];

/** The successor Select's value for the project itself; a milestone is `milestone:<id>`. */
export const PROJECT_SUCCESSOR = "project";
const MILESTONE_SUCCESSOR = "milestone:";

/** A link's editable parts. The predecessor is the picker's string value + label (kept beside the id so the label survives later searches). */
export type DependencyFormValues = {
  successor: string;
  predecessorKind: EndpointKind;
  predecessor: PickedOption | null;
  type: DependencyType;
  /** Mantine's `NumberInput` value: a number, or a string while the field is empty or half-typed. */
  lagDays: number | string;
};

/** A new link: finish-to-start, no lag, the successor prefilled (the page's "Add dependency…" row-menu shortcut) or the project itself. */
export function emptyDependencyForm(successor: EndpointRef | null): DependencyFormValues {
  return {
    successor: successor !== null && successor.kind === "MILESTONE" ? `${MILESTONE_SUCCESSOR}${successor.id}` : PROJECT_SUCCESSOR,
    predecessorKind: "MILESTONE",
    predecessor: null,
    type: "FS",
    lagDays: 0,
  };
}

/** The successor Select's value as an endpoint of this project: the project itself, or one of its milestones. */
export function successorRef(value: string, projectId: number): EndpointRef {
  return value.startsWith(MILESTONE_SUCCESSOR) ? { kind: "MILESTONE", id: Number(value.slice(MILESTONE_SUCCESSOR.length)) } : { kind: "PROJECT", id: projectId };
}

/** The lag as a whole number in range, or `null` while the field is empty, fractional or out of range. */
function lagOf(value: number | string): number | null {
  if (value === "") return null;
  const lag = typeof value === "number" ? value : Number(value);
  return Number.isInteger(lag) && lag >= MIN_LAG_DAYS && lag <= MAX_LAG_DAYS ? lag : null;
}

/** The rules the server enforces: a predecessor is picked and is not the successor itself, and the lag is a whole number in range. */
export function dependencyFormValidation(t: TFunction, projectId: number) {
  return {
    predecessor: (picked: PickedOption | null, values: DependencyFormValues) => {
      if (picked === null) return t("project.dependency.validation.predecessorRequired");
      const successor = successorRef(values.successor, projectId);
      return successor.kind === values.predecessorKind && String(successor.id) === picked.value ? t("project.dependency.validation.selfLink") : null;
    },
    lagDays: (value: number | string) => (lagOf(value) === null ? t("project.dependency.validation.lagInvalid") : null),
  };
}

export function toDependencyBody(values: DependencyFormValues, projectId: number): DependencyBody {
  return {
    predecessor: { kind: values.predecessorKind, id: Number(values.predecessor?.value) },
    successor: successorRef(values.successor, projectId),
    type: values.type,
    lagDays: lagOf(values.lagDays) ?? 0,
  };
}

/** "A → B → A": the cycle's entities in the problem's order (names are data, the arrows are ours). */
export function cyclePathText(nodes: readonly components["schemas"]["ProblemCycleNode"][]): string {
  return nodes.map((node) => node.name).join(" → ");
}

/** The save vocabulary; a cycle 409 is told apart (and drawn with its path) by the editor, so a 409 reaching here is the duplicate pair. */
export function dependencySaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "project.dependency.saveForbidden",
    notFound: "project.saveGone",
    conflict: "project.dependency.duplicate",
    invalid: "project.dependency.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

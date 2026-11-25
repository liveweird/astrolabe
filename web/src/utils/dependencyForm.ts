import type { TFunction } from "i18next";
import type { DependencyBody, DependencyEndpoint, DependencyType, DependencyUpdateBody, EndpointKind, EndpointRef } from "../api/dependencies";
import type { PlanView } from "../api/plan";
import type { components } from "../api/schema";
import type { PickedOption } from "../components/SearchPicker";
import { projectOptions } from "./planNames";
import { saveErrorMessage } from "./saveError";

/**
 * What the editor and the delete confirmation read of a link: its id, type and lag and, per end, the kind, the name and the project. The project
 * view's `ProjectDependency` and the Dependencies page's resolved row both satisfy it, so one dialog serves both pages.
 */
export type EditableDependency = {
  id: number;
  type: DependencyType;
  lagDays: number;
  predecessor: EditableEnd;
  successor: EditableEnd;
};
type EditableEnd = Pick<DependencyEndpoint, "kind" | "name" | "projectId" | "projectName">;

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
    lagDays: lagRule(t),
  };
}

/** The lag field's rule, shared by the create and the edit form. */
const lagRule = (t: TFunction) => (value: number | string) => (lagOf(value) === null ? t("project.dependency.validation.lagInvalid") : null);

export function toDependencyBody(values: DependencyFormValues, projectId: number): DependencyBody {
  return {
    predecessor: { kind: values.predecessorKind, id: Number(values.predecessor?.value) },
    successor: successorRef(values.successor, projectId),
    type: values.type,
    lagDays: lagOf(values.lagDays) ?? 0,
  };
}

/** The Dependencies page's add dialog (1.27): the successor's project (a `Select` value, the project id), the successor, the predecessor, the type and the lag. */
export type DependencyAddValues = {
  /** The successor's project: the Select's value (an id as text), `null` until picked. */
  projectId: string | null;
  /** The successor: one of that project's milestones, or the project itself (then `successor` is not used). */
  successorKind: EndpointKind;
  successor: PickedOption | null;
  predecessorKind: EndpointKind;
  predecessor: PickedOption | null;
  type: DependencyType;
  lagDays: number | string;
};

/** A new link from the list page: the project prefilled when the page's project filter names one the caller may add to; finish-to-start, no lag. */
export function emptyDependencyAddForm(projectId: number | null): DependencyAddValues {
  return {
    projectId: projectId === null ? null : String(projectId),
    successorKind: "MILESTONE",
    successor: null,
    predecessorKind: "MILESTONE",
    predecessor: null,
    type: "FS",
    lagDays: 0,
  };
}

/** The successor end of the add form: the picked milestone, or the project itself; `null` while nothing is picked to name it. */
function addSuccessorRef(values: DependencyAddValues): EndpointRef | null {
  if (values.successorKind === "PROJECT") return values.projectId === null ? null : { kind: "PROJECT", id: Number(values.projectId) };
  return values.successor === null ? null : { kind: "MILESTONE", id: Number(values.successor.value) };
}

/**
 * The rules the server enforces, in the order the dialog reads: a project, a successor milestone (only for a milestone successor, and only once a
 * project is there to pick it from, so the project's own message comes first), a predecessor that is not the successor, a lag in range.
 */
export function dependencyAddValidation(t: TFunction) {
  return {
    projectId: (value: string | null) => (value === null ? t("dependencyList.add.validation.projectRequired") : null),
    successor: (picked: PickedOption | null, values: DependencyAddValues) =>
      values.successorKind === "MILESTONE" && values.projectId !== null && picked === null ? t("dependencyList.add.validation.successorRequired") : null,
    predecessor: (picked: PickedOption | null, values: DependencyAddValues) => {
      if (picked === null) return t("project.dependency.validation.predecessorRequired");
      const successor = addSuccessorRef(values);
      return successor !== null && successor.kind === values.predecessorKind && String(successor.id) === picked.value
        ? t("project.dependency.validation.selfLink")
        : null;
    },
    lagDays: lagRule(t),
  };
}

/** The project the link is posted to (the successor's) and the body; call it only on valid values. */
export function toDependencyAddRequest(values: DependencyAddValues): { projectId: number; body: DependencyBody } {
  const projectId = Number(values.projectId);
  return {
    projectId,
    body: {
      predecessor: { kind: values.predecessorKind, id: Number(values.predecessor?.value) },
      successor: addSuccessorRef(values) ?? { kind: "PROJECT", id: projectId },
      type: values.type,
      lagDays: lagOf(values.lagDays) ?? 0,
    },
  };
}

/**
 * The projects the caller may add a dependency to as the SUCCESSOR's project (`can.createDependency` of the plan view), as select options labelled
 * like every project select (a name two projects share carries its program, worked out over the whole plan). Empty while the plan is unread.
 */
export function addableProjects(plan: PlanView | undefined): { id: number; label: string }[] {
  const addable = new Set<number>();
  for (const stream of plan?.workStreams ?? []) {
    for (const program of stream.programs) {
      for (const project of program.projects) if (project.can.createDependency) addable.add(project.id);
    }
  }
  return projectOptions(plan).filter((option) => addable.has(option.id));
}

/** An existing link's editable parts: its stored type and lag; the ends are read-only in the editor and not part of the form. */
export function editDependencyForm(dependency: { type: DependencyType; lagDays: number }): DependencyFormValues {
  return { ...emptyDependencyForm(null), type: dependency.type, lagDays: dependency.lagDays };
}

/** The edit form's rules: only the lag (the type is a closed Select, the ends are fixed). */
export function dependencyEditValidation(t: TFunction) {
  return { lagDays: lagRule(t) };
}

/** The `PUT /dependencies/{id}` body: both fields, always (there is no partial body). */
export function toDependencyUpdateBody(values: DependencyFormValues): DependencyUpdateBody {
  return { type: values.type, lagDays: lagOf(values.lagDays) ?? 0 };
}

/**
 * An endpoint in words: a milestone (with its project when that is another one) or a whole project. `ownProjectId` is the page's own project;
 * `null` = the page has none (the Dependencies page), so every milestone names its project.
 */
export function dependencyEndpointText(endpoint: EditableEnd, ownProjectId: number | null, t: TFunction): string {
  if (endpoint.kind === "PROJECT") return t("project.dependency.wholeProject", { name: endpoint.name });
  return endpoint.projectId === ownProjectId ? endpoint.name : `${endpoint.name} · ${endpoint.projectName}`;
}

/** "A → B → A": the cycle's entities in the problem's order (names are data, the arrows are ours). */
export function cyclePathText(nodes: readonly components["schemas"]["ProblemCycleNode"][]): string {
  return nodes.map((node) => node.name).join(" → ");
}

/**
 * The edit's save vocabulary (the editor tells a cycle 409 apart and draws its path): the server's 400 for an edit is the lag range,
 * the 404 a link deleted meanwhile; no other 409 exists for a PUT, so any other status falls to the generic line.
 */
export function dependencyUpdateErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "project.dependency.saveForbidden",
    notFound: "project.saveGone",
    invalid: "project.dependency.validation.lagInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
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

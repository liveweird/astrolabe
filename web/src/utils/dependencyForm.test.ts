import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { planOf } from "../test/planView";
import {
  addableProjects,
  cyclePathText,
  dependencyAddValidation,
  dependencyEditValidation,
  dependencyEndpointText,
  dependencyFormValidation,
  dependencySaveErrorMessage,
  dependencyUpdateErrorMessage,
  editDependencyForm,
  emptyDependencyAddForm,
  emptyDependencyForm,
  PROJECT_SUCCESSOR,
  successorRef,
  toDependencyAddRequest,
  toDependencyBody,
  toDependencyUpdateBody,
  type DependencyAddValues,
  type DependencyFormValues,
} from "./dependencyForm";

const t = i18n.t.bind(i18n);
const validate = dependencyFormValidation(t, 7);

const values = (over: Partial<DependencyFormValues> = {}): DependencyFormValues => ({
  ...emptyDependencyForm(null),
  predecessor: { value: "42", label: "a1 · A" },
  ...over,
});

describe("dependency form", () => {
  test("starts as finish-to-start with no lag, the successor the project or the milestone it was opened on", () => {
    expect(emptyDependencyForm(null)).toEqual({ successor: PROJECT_SUCCESSOR, predecessorKind: "MILESTONE", predecessor: null, type: "FS", lagDays: 0 });
    expect(emptyDependencyForm({ kind: "MILESTONE", id: 5 }).successor).toBe("milestone:5");
    expect(emptyDependencyForm({ kind: "PROJECT", id: 7 }).successor).toBe(PROJECT_SUCCESSOR);
  });

  test("the successor value reads back as an endpoint of this project", () => {
    expect(successorRef(PROJECT_SUCCESSOR, 7)).toEqual({ kind: "PROJECT", id: 7 });
    expect(successorRef("milestone:5", 7)).toEqual({ kind: "MILESTONE", id: 5 });
  });

  test("a predecessor is required, and an end cannot be linked to itself", () => {
    expect(validate.predecessor(null, values())).toBe("Pick the predecessor");
    expect(validate.predecessor({ value: "42", label: "x" }, values())).toBeNull();
    // the milestone it is linked from: milestone 5 of this project
    expect(validate.predecessor({ value: "5", label: "x" }, values({ successor: "milestone:5" }))).toBe("An end cannot depend on itself");
    // the same id of the OTHER kind is a different entity
    expect(validate.predecessor({ value: "5", label: "x" }, values({ successor: "milestone:5", predecessorKind: "PROJECT" }))).toBeNull();
    // the project itself as its own predecessor
    expect(validate.predecessor({ value: "7", label: "x" }, values({ predecessorKind: "PROJECT" }))).toBe("An end cannot depend on itself");
  });

  test("the lag is a whole number of working days within -365..365", () => {
    for (const ok of [0, -365, 365, 3, "-2"]) expect(validate.lagDays(ok)).toBeNull();
    for (const bad of ["", 366, -366, 1.5, "abc"]) expect(validate.lagDays(bad)).toBe("Enter a whole number of working days from -365 to 365");
  });

  test("the body carries the kinds, ids, type and lag", () => {
    expect(toDependencyBody(values({ predecessorKind: "PROJECT", type: "SF", lagDays: "-3", successor: "milestone:5" }), 7)).toEqual({
      predecessor: { kind: "PROJECT", id: 42 },
      successor: { kind: "MILESTONE", id: 5 },
      type: "SF",
      lagDays: -3,
    });
  });

  test("the edit form starts from the stored type and lag and sends both; only the lag is validated", () => {
    expect(editDependencyForm({ type: "FF", lagDays: -3 })).toMatchObject({ type: "FF", lagDays: -3 });
    expect(toDependencyUpdateBody(values({ type: "SF", lagDays: "4" }))).toEqual({ type: "SF", lagDays: 4 });
    expect(Object.keys(dependencyEditValidation(t))).toEqual(["lagDays"]);
    expect(dependencyEditValidation(t).lagDays(366)).toBe("Enter a whole number of working days from -365 to 365");
    expect(dependencyEditValidation(t).lagDays(0)).toBeNull();
  });

  test("an endpoint reads as its name, with its project when that is another one, or as the whole project", () => {
    const end = { kind: "MILESTONE", id: 1, name: "a1", projectId: 7, projectName: "Alpha", teamId: 1, teamName: "T", startDate: null, endDate: null } as const;
    expect(dependencyEndpointText(end, 7, t)).toBe("a1");
    expect(dependencyEndpointText(end, 8, t)).toBe("a1 · Alpha");
    expect(dependencyEndpointText({ ...end, kind: "PROJECT", name: "Alpha" }, 8, t)).toBe("Project Alpha");
  });

  test("with no own project (the dependency panel) every milestone end names its project; a project end reads the same either way", () => {
    const end = { kind: "MILESTONE", id: 1, name: "a1", projectId: 7, projectName: "Alpha", teamId: 1, teamName: "T", startDate: null, endDate: null } as const;
    expect(dependencyEndpointText(end, null, t)).toBe("a1 · Alpha");
    expect(dependencyEndpointText({ ...end, kind: "PROJECT", name: "Alpha" }, null, t)).toBe("Project Alpha");
    expect(dependencyEndpointText({ ...end, kind: "PROJECT", name: "Alpha" }, 7, t)).toBe("Project Alpha");
  });

  test("edit failures map to the fixed vocabulary: the lag sentence on a 400, never the server's text", () => {
    const message = (status: number) => dependencyUpdateErrorMessage(new ApiError(status, { detail: "server words" }), t);
    expect(message(400)).toBe("Enter a whole number of working days from -365 to 365");
    expect(message(403)).toContain("Only the owners of the successor's project");
    expect(message(404)).toBe("This no longer exists — reload the page");
    expect(message(409)).toBe("Save failed (409)");
    expect(dependencyUpdateErrorMessage(new Error("offline"), t)).toBe("Save failed. Check your connection and try again.");
  });

  test("the cycle path reads as names joined by arrows", () => {
    expect(
      cyclePathText([
        { kind: "MILESTONE", id: 1, name: "a1" },
        { kind: "MILESTONE", id: 2, name: "b1" },
        { kind: "MILESTONE", id: 1, name: "a1" },
      ]),
    ).toBe("a1 → b1 → a1");
  });

  test("save failures map to the fixed vocabulary: the duplicate pair on a 409, never the server's text", () => {
    const message = (status: number) => dependencySaveErrorMessage(new ApiError(status, { detail: "server words" }), t);
    expect(message(409)).toBe("These two ends are already linked.");
    expect(message(403)).toContain("Only the owners of the successor's project");
    expect(message(404)).toBe("This no longer exists — reload the page");
    expect(message(400)).toContain("either may have been deleted meanwhile");
    expect(message(500)).toBe("Save failed (500)");
    expect(dependencySaveErrorMessage(new Error("offline"), t)).toBe("Save failed. Check your connection and try again.");
  });
});

describe("the dependency panel's add form", () => {
  const validateAdd = dependencyAddValidation(t);
  const addValues = (over: Partial<DependencyAddValues> = {}): DependencyAddValues => ({
    ...emptyDependencyAddForm(7),
    successor: { value: "5", label: "b2 · Invoices" },
    predecessor: { value: "42", label: "a1 · Alpha" },
    ...over,
  });

  test("starts on no project, or the one given, as a milestone successor and predecessor, finish-to-start, no lag", () => {
    expect(emptyDependencyAddForm(null)).toEqual({
      projectId: null,
      successorKind: "MILESTONE",
      successor: null,
      predecessorKind: "MILESTONE",
      predecessor: null,
      type: "FS",
      lagDays: 0,
    });
    expect(emptyDependencyAddForm(7).projectId).toBe("7");
  });

  test("a project is required, and a successor milestone only for a milestone successor and once a project is picked", () => {
    expect(validateAdd.projectId(null)).toBe("Pick the successor's project");
    expect(validateAdd.projectId("7")).toBeNull();
    expect(validateAdd.successor(null, addValues())).toBe("Pick the successor milestone");
    expect(validateAdd.successor({ value: "5", label: "x" }, addValues())).toBeNull();
    // Without a project there is no picker to show the message on, and the project's own message comes first.
    expect(validateAdd.successor(null, addValues({ projectId: null }))).toBeNull();
    // A whole project needs no milestone.
    expect(validateAdd.successor(null, addValues({ successorKind: "PROJECT" }))).toBeNull();
  });

  test("a predecessor is required, and no end is its own predecessor, whichever way the successor is named", () => {
    expect(validateAdd.predecessor(null, addValues())).toBe("Pick the predecessor");
    expect(validateAdd.predecessor({ value: "42", label: "x" }, addValues())).toBeNull();
    expect(validateAdd.predecessor({ value: "5", label: "x" }, addValues())).toBe("An end cannot depend on itself");
    // The same id of the OTHER kind is another entity.
    expect(validateAdd.predecessor({ value: "5", label: "x" }, addValues({ predecessorKind: "PROJECT" }))).toBeNull();
    // The project as its own predecessor, as a whole-project successor.
    const wholeProject = addValues({ successorKind: "PROJECT", successor: null, predecessorKind: "PROJECT" });
    expect(validateAdd.predecessor({ value: "7", label: "x" }, wholeProject)).toBe("An end cannot depend on itself");
    expect(validateAdd.predecessor({ value: "8", label: "x" }, wholeProject)).toBeNull();
    // No project yet, a whole project as the successor: nothing names it, so nothing can equal it (the project's own message is shown).
    expect(validateAdd.predecessor({ value: "7", label: "x" }, addValues({ projectId: null, successorKind: "PROJECT", predecessorKind: "PROJECT" }))).toBeNull();
    // A leftover milestone pick does not count once the successor is the project.
    expect(validateAdd.predecessor({ value: "5", label: "x" }, addValues({ successorKind: "PROJECT" }))).toBeNull();
  });

  test("the lag is the same whole number in range as everywhere", () => {
    expect(validateAdd.lagDays("")).toBe("Enter a whole number of working days from -365 to 365");
    expect(validateAdd.lagDays(366)).toBe("Enter a whole number of working days from -365 to 365");
    expect(validateAdd.lagDays(-365)).toBeNull();
  });

  test("the request posts to the successor's project: a milestone successor, or the project itself", () => {
    expect(toDependencyAddRequest(addValues({ type: "SS", lagDays: "-2" }))).toEqual({
      projectId: 7,
      body: { predecessor: { kind: "MILESTONE", id: 42 }, successor: { kind: "MILESTONE", id: 5 }, type: "SS", lagDays: -2 },
    });
    expect(toDependencyAddRequest(addValues({ successorKind: "PROJECT", successor: null, predecessorKind: "PROJECT" }))).toEqual({
      projectId: 7,
      body: { predecessor: { kind: "PROJECT", id: 42 }, successor: { kind: "PROJECT", id: 7 }, type: "FS", lagDays: 0 },
    });
  });

  test("the addable projects are those whose createDependency is set, labelled over the whole plan, by name", () => {
    const plan = planOf([
      {
        id: 1,
        name: "Platform",
        programs: [
          { id: 10, name: "Billing", projects: [{ id: 100, name: "Checkout" }, { id: 101, name: "Audit", can: { createDependency: false } }, { id: 102, name: "alpha" }] },
          { id: 11, name: "Search", projects: [{ id: 103, name: "Checkout", can: { createDependency: false } }] },
        ],
      },
    ]);
    // "Checkout" exists twice, so its label carries the program even though only one of the two is addable.
    expect(addableProjects(plan)).toEqual([
      { id: 102, label: "alpha" },
      { id: 100, label: "Checkout (Billing)" },
    ]);
    expect(addableProjects(undefined)).toEqual([]);
    expect(addableProjects(planOf([]))).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import {
  cyclePathText,
  dependencyEditValidation,
  dependencyEndpointText,
  dependencyFormValidation,
  dependencySaveErrorMessage,
  dependencyUpdateErrorMessage,
  editDependencyForm,
  emptyDependencyForm,
  PROJECT_SUCCESSOR,
  successorRef,
  toDependencyBody,
  toDependencyUpdateBody,
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

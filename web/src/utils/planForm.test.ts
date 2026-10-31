import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import type { PlanProject, PlanWorkStream } from "../api/plan";
import {
  planSaveErrorMessage,
  programFormValidation,
  projectFormValidation,
  toProgramBody,
  toProjectCreateBody,
  toProjectFormValues,
  toProjectUpdateBody,
  toTargetWindowBody,
  toWorkStreamBody,
  toWorkStreamFormValues,
  workStreamFormValidation,
  type PlanNodeFormValues,
  type ProjectFormValues,
  type WorkStreamFormValues,
} from "./planForm";

const t = i18n.t;
const node: PlanNodeFormValues = { name: "  Alpha ", description: "   ", ownerPersonId: "4", ownerLabel: "Ola" };

describe("planForm validation", () => {
  test("the node rules: name 1-100, description at most 500, an owner is required", () => {
    const rules = programFormValidation(t);
    expect(rules.name("")).toBe("Name must be 1–100 characters");
    expect(rules.name("x".repeat(101))).not.toBeNull();
    expect(rules.name(" ok ")).toBeNull();
    expect(rules.description("x".repeat(500))).toBeNull();
    expect(rules.description("x".repeat(501))).toBe("Description must be at most 500 characters");
    expect(rules.ownerPersonId(null)).toBe("Pick an owner");
    expect(rules.ownerPersonId("4")).toBeNull();
  });

  test("a work stream needs a real start date; an end date is optional, real and not before the start", () => {
    const rules = workStreamFormValidation(t);
    const values = (startDate: string | null, endDate: string | null): WorkStreamFormValues => ({ ...node, startDate, endDate });
    expect(rules.startDate(null)).toBe("Enter a start date");
    expect(rules.startDate("")).toBe("Enter a start date");
    expect(rules.startDate("2026-02-30")).toBe("Enter a valid date (YYYY-MM-DD)");
    expect(rules.startDate("2026-02-28")).toBeNull();
    expect(rules.endDate(null, values("2026-01-01", null))).toBeNull();
    expect(rules.endDate("2026-13-01", values("2026-01-01", "2026-13-01"))).toBe("Enter a valid date (YYYY-MM-DD)");
    expect(rules.endDate("2025-12-31", values("2026-01-01", "2025-12-31"))).toBe("The end must not be before the start");
    expect(rules.endDate("2026-01-01", values("2026-01-01", "2026-01-01"))).toBeNull();
  });

  test("a target window is both dates or neither, ordered", () => {
    const rules = projectFormValidation(t);
    const values = (targetStart: string | null, targetEnd: string | null): ProjectFormValues => ({ ...node, targetStart, targetEnd });
    expect(rules.targetStart(null, values(null, null))).toBeNull();
    expect(rules.targetEnd(null, values(null, null))).toBeNull();
    expect(rules.targetStart(null, values(null, "2026-03-01"))).toBe("Set both target dates or neither");
    expect(rules.targetEnd(null, values("2026-03-01", null))).toBe("Set both target dates or neither");
    expect(rules.targetEnd("2026-02-01", values("2026-03-01", "2026-02-01"))).toBe("The end must not be before the start");
    expect(rules.targetStart("nope", values("nope", "2026-02-01"))).toBe("Enter a valid date (YYYY-MM-DD)");
    expect(rules.targetEnd("nope", values("2026-03-01", "nope"))).toBe("Enter a valid date (YYYY-MM-DD)");
    expect(rules.targetEnd("2026-04-01", values("2026-03-01", "2026-04-01"))).toBeNull();
  });
});

describe("planForm wire bodies", () => {
  test("a program body trims, sends a blank description as null and the owner as a number", () => {
    expect(toProgramBody(node)).toEqual({ name: "Alpha", description: null, ownerPersonId: 4 });
    expect(toProgramBody({ ...node, description: " about " }).description).toBe("about");
    expect(toProjectUpdateBody(node)).toEqual({ name: "Alpha", description: null, ownerPersonId: 4 });
  });

  test("a work stream body carries ISO dates; an unset end is an explicit null (it reopens on PUT)", () => {
    expect(toWorkStreamBody({ ...node, startDate: "2026-01-05", endDate: null })).toEqual({
      name: "Alpha",
      description: null,
      ownerPersonId: 4,
      startDate: "2026-01-05",
      endDate: null,
    });
    expect(toWorkStreamBody({ ...node, startDate: "2026-01-05", endDate: "2026-06-30" }).endDate).toBe("2026-06-30");
  });

  test("the target window is a pair or a null pair; a create body carries it beside the fields", () => {
    const set: ProjectFormValues = { ...node, targetStart: "2026-02-01", targetEnd: "2026-03-31" };
    expect(toTargetWindowBody(set)).toEqual({ targetStart: "2026-02-01", targetEnd: "2026-03-31" });
    expect(toTargetWindowBody({ ...node, targetStart: null, targetEnd: null })).toEqual({ targetStart: null, targetEnd: null });
    expect(toProjectCreateBody(set)).toEqual({ name: "Alpha", description: null, ownerPersonId: 4, targetStart: "2026-02-01", targetEnd: "2026-03-31" });
  });

  test("form values come from the view rows (owner label = the owner's name)", () => {
    const stream = {
      id: 1, name: "S", description: "d", ownerPersonId: 4, ownerName: "Ola", startDate: "2026-01-05", endDate: null,
      createdAt: 0, updatedAt: 0, can: { edit: true, delete: true, createProgram: true }, programs: [],
    } satisfies PlanWorkStream;
    expect(toWorkStreamFormValues(stream)).toEqual({
      name: "S", description: "d", ownerPersonId: "4", ownerLabel: "Ola", startDate: "2026-01-05", endDate: null,
    });
    const project = {
      id: 2, programId: 1, workStreamId: 1, name: "P", description: null, ownerPersonId: 5, ownerName: "Piotr",
      targetStart: "2026-02-01", targetEnd: "2026-03-01", createdAt: 0, updatedAt: 0,
      can: { edit: true, delete: true, editTargetWindow: false, move: true },
    } satisfies PlanProject;
    expect(toProjectFormValues(project)).toEqual({
      name: "P", description: "", ownerPersonId: "5", ownerLabel: "Piotr", targetStart: "2026-02-01", targetEnd: "2026-03-01",
    });
  });
});

describe("planSaveErrorMessage", () => {
  const api = (status: number) => new ApiError(status, { title: "x", status });
  test("maps statuses onto the plan vocabulary", () => {
    expect(planSaveErrorMessage(api(403), t)).toBe("You are not allowed to change this");
    expect(planSaveErrorMessage(api(404), t)).toBe("This no longer exists — reload the page");
    expect(planSaveErrorMessage(api(400), t)).toContain("invalid");
    expect(planSaveErrorMessage(api(500), t)).toBe("Save failed (500)");
    expect(planSaveErrorMessage(new TypeError("Failed to fetch"), t)).toBe("Save failed. Check your connection and try again.");
  });
});

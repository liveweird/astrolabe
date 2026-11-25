import { describe, expect, test } from "vitest";
import type { PlanView } from "../api/plan";
import { planNames, planParents, programOptions, projectOptions, workStreamOptions } from "./planNames";

const PLAN = {
  revision: 1,
  workStreams: [
    {
      id: 700,
      name: "Platform",
      programs: [
        { id: 70, name: "Billing", projects: [{ id: 9, name: "invoices" }, { id: 3, name: "Checkout" }] },
        { id: 71, name: "Search", projects: [{ id: 4, name: "Checkout" }] },
      ],
    },
    { id: 701, name: "Growth", programs: [{ id: 72, name: "Onboarding", projects: [{ id: 5, name: "Alpha" }] }] },
  ],
} as unknown as PlanView;

describe("projectOptions", () => {
  test("lists every project of every program by label, case-insensitively", () => {
    expect(projectOptions(PLAN).map((option) => option.id)).toEqual([5, 3, 4, 9]);
  });

  test("two projects of one name carry their program; a unique name stands alone", () => {
    const labels = projectOptions(PLAN).map((option) => option.label);
    expect(labels).toEqual(["Alpha", "Checkout (Billing)", "Checkout (Search)", "invoices"]);
  });

  test("an undefined or empty plan answers none", () => {
    expect(projectOptions(undefined)).toEqual([]);
    expect(projectOptions({ revision: 1, workStreams: [] } as unknown as PlanView)).toEqual([]);
  });
});

describe("workStreamOptions and programOptions", () => {
  test("every work stream by name, case-insensitively", () => {
    expect(workStreamOptions(PLAN)).toEqual([
      { id: 701, label: "Growth" },
      { id: 700, label: "Platform" },
    ]);
    expect(workStreamOptions(undefined)).toEqual([]);
  });

  test("every program by label; two of one name carry their work stream", () => {
    const plan = {
      revision: 1,
      workStreams: [...PLAN.workStreams, { id: 702, name: "Data", programs: [{ id: 73, name: "Search", projects: [] }] }],
    } as unknown as PlanView;
    expect(programOptions(plan).map((option) => option.label)).toEqual(["Billing", "Onboarding", "Search (Data)", "Search (Platform)"]);
  });

  test("a work stream narrows the programs, and the labels do not change with it", () => {
    const plan = {
      revision: 1,
      workStreams: [...PLAN.workStreams, { id: 702, name: "Data", programs: [{ id: 73, name: "Search", projects: [] }] }],
    } as unknown as PlanView;
    expect(programOptions(plan, { workStreamId: 700 })).toEqual([
      { id: 70, label: "Billing" },
      { id: 71, label: "Search (Platform)" },
    ]);
    expect(programOptions(plan, { workStreamId: 999 })).toEqual([]);
  });
});

describe("projectOptions within a scope", () => {
  test("a work stream, a program, or both narrow the projects; both must hold", () => {
    expect(projectOptions(PLAN, { workStreamId: 700 }).map((option) => option.id)).toEqual([3, 4, 9]);
    expect(projectOptions(PLAN, { programId: 71 }).map((option) => option.id)).toEqual([4]);
    expect(projectOptions(PLAN, { workStreamId: 700, programId: 72 })).toEqual([]);
    expect(projectOptions(PLAN, { workStreamId: 700, programId: 70 }).map((option) => option.id)).toEqual([3, 9]);
  });

  test("a project's label keeps its program when the scope hides the same-named one", () => {
    expect(projectOptions(PLAN, { programId: 71 })).toEqual([{ id: 4, label: "Checkout (Search)" }]);
  });
});

describe("planParents", () => {
  test("each program's work stream and each project's program", () => {
    const parents = planParents(PLAN);
    expect(parents.programStream.get(71)).toBe(700);
    expect(parents.programStream.get(72)).toBe(701);
    expect(parents.projectProgram.get(4)).toBe(71);
    expect(parents.projectProgram.get(5)).toBe(72);
    expect(parents.projectProgram.get(999)).toBeUndefined();
    expect(planParents(undefined).programStream.size).toBe(0);
  });
});

describe("planNames", () => {
  test("maps project and program ids to names", () => {
    const names = planNames(PLAN);
    expect(names.projects.get(9)).toBe("invoices");
    expect(names.programs.get(72)).toBe("Onboarding");
  });
});

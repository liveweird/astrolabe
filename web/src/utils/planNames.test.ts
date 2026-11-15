import { describe, expect, test } from "vitest";
import type { PlanView } from "../api/plan";
import { planNames, projectOptions } from "./planNames";

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

describe("planNames", () => {
  test("maps project and program ids to names", () => {
    const names = planNames(PLAN);
    expect(names.projects.get(9)).toBe("invoices");
    expect(names.programs.get(72)).toBe("Onboarding");
  });
});

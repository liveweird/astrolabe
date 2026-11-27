import { describe, expect, test } from "vitest";
import { planOf } from "../test/planView";
import { ownedBy } from "./personResponsibilities";

describe("ownedBy", () => {
  const plan = planOf([
    {
      id: 1,
      name: "Alpha",
      ownerPersonId: 7,
      programs: [
        { id: 10, name: "Core", ownerPersonId: 8, projects: [{ id: 100, name: "Ledger", ownerPersonId: 7 }, { id: 101, name: "Billing", ownerPersonId: 9 }] },
        { id: 11, name: "Edge", ownerPersonId: 7, projects: [] },
      ],
    },
    { id: 2, name: "Beta", ownerPersonId: 9, endDate: "2026-06-30", programs: [{ id: 20, name: "Old", ownerPersonId: 9, projects: [{ id: 200, name: "Archive", ownerPersonId: 7 }] }] },
  ]);

  test("lists the nodes whose owner is the person, in the plan's order, with their parents", () => {
    expect(ownedBy(plan, 7)).toEqual({
      workStreams: [{ id: 1, name: "Alpha", closed: false }],
      programs: [{ id: 11, name: "Edge", workStream: { id: 1, name: "Alpha", closed: false } }],
      projects: [
        { id: 100, name: "Ledger", program: { id: 10, name: "Core" }, workStream: { id: 1, name: "Alpha", closed: false } },
        { id: 200, name: "Archive", program: { id: 20, name: "Old" }, workStream: { id: 2, name: "Beta", closed: true } },
      ],
    });
  });

  test("ownership is direct: the owner of a work stream does not own what is under it", () => {
    expect(ownedBy(plan, 9).programs.map((program) => program.id)).toEqual([20]);
    expect(ownedBy(plan, 8)).toEqual({ workStreams: [], programs: [{ id: 10, name: "Core", workStream: { id: 1, name: "Alpha", closed: false } }], projects: [] });
  });

  test("a person who owns nothing gets three empty lists", () => {
    expect(ownedBy(plan, 99)).toEqual({ workStreams: [], programs: [], projects: [] });
  });
});

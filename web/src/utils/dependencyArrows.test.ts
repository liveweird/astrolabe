import { describe, expect, test } from "vitest";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import { arrowSpecsFor, conflictCountOf, conflictsByBarFor } from "./dependencyArrows";

const endpoint = (id: number, over: Partial<DependencyEndpoint> = {}): DependencyEndpoint => ({
  kind: "MILESTONE",
  id,
  name: `M${id}`,
  projectId: 7,
  projectName: "Invoices",
  teamId: 3,
  teamName: "Backend",
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  ...over,
});

const link = (id: number, predecessor: DependencyEndpoint, successor: DependencyEndpoint, over: Partial<ProjectDependency> = {}): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, requiredDate: "2027-02-08", actualDate: "2027-02-08" },
  critical: false,
  can: { edit: true, delete: true },
  ...over,
});

const violated = { status: "VIOLATED", shortfallDays: 2, requiredDate: "2027-02-08", actualDate: "2027-02-04" } as const;
const unscheduled = { status: "UNSCHEDULED", shortfallDays: null, requiredDate: null, actualDate: null } as const;

/** A timeline whose rows are the milestones 1..3 only (the way a team page resolves an end). */
const rowOf = (e: DependencyEndpoint) => (e.kind === "MILESTONE" && e.id <= 3 ? e.id : null);

describe("arrowSpecsFor", () => {
  test("joins the type's edges, flags the violated ones and names the path", () => {
    const specs = arrowSpecsFor(
      [link(1, endpoint(1), endpoint(2)), link(2, endpoint(1), endpoint(3), { type: "SF", check: violated })],
      rowOf,
    );
    expect(specs).toEqual([
      { id: 1, from: { row: 1, bar: 1, kind: "END" }, to: { row: 2, bar: 2, kind: "START" }, violated: false, label: "M1 → M2, FS" },
      { id: 2, from: { row: 1, bar: 1, kind: "START" }, to: { row: 3, bar: 3, kind: "END" }, violated: true, label: "M1 → M3, SF" },
    ]);
  });

  test("leaves out an UNSCHEDULED link and a link with an end that is not a row of this timeline", () => {
    const specs = arrowSpecsFor(
      [
        link(1, endpoint(1), endpoint(2), { check: unscheduled }),
        link(2, endpoint(1), endpoint(9)),
        link(3, endpoint(1), endpoint(8, { kind: "PROJECT" })),
        link(4, endpoint(2), endpoint(3)),
      ],
      rowOf,
    );
    expect(specs.map((s) => s.id)).toEqual([4]);
  });
});

describe("conflicts", () => {
  const links = [link(1, endpoint(1), endpoint(2), { check: violated }), link(2, endpoint(2), endpoint(3), { check: violated }), link(3, endpoint(1), endpoint(3))];

  test("conflictCountOf counts the violated links", () => {
    expect(conflictCountOf(links)).toBe(2);
    expect(conflictCountOf([])).toBe(0);
  });

  test("conflictsByBarFor counts a violated link on BOTH of its bars and skips an end with no bar", () => {
    expect([...conflictsByBarFor(links, rowOf)]).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
    expect([...conflictsByBarFor([link(1, endpoint(1), endpoint(9), { check: violated })], rowOf)]).toEqual([[1, 1]]);
  });
});

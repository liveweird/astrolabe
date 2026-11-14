import { describe, expect, test } from "vitest";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { chainProjects, criticalIndex, withoutCriticalPath } from "./roadmapCritical";
import { allProjects, pairKey } from "./roadmapRows";

const project = (id: number, name: string): RoadmapProject =>
  ({ id, name, programName: "Billing", span: { start: "2026-03-02", end: "2026-04-10" } }) as unknown as RoadmapProject;

const view = (criticalPath?: RoadmapView["criticalPath"]) =>
  ({
    ranked: [{ position: 1, project: project(1, "Alpha") }],
    unranked: [project(2, "Beta"), project(3, "Gamma")],
    ...(criticalPath === undefined ? {} : { criticalPath }),
  }) as unknown as RoadmapView;

const BLOCK = {
  projectId: 1,
  projects: [
    { projectId: 3, slackDays: 0, critical: true, hops: 1 },
    { projectId: 2, slackDays: 4, critical: false, hops: 2 },
    { projectId: 99, slackDays: 0, critical: true, hops: 3 },
  ],
  pairs: [{ predecessorProjectId: 3, successorProjectId: 1 }],
};

describe("criticalIndex", () => {
  test("no block: nothing is emphasised", () => {
    expect(criticalIndex(view())).toEqual({ target: null, projects: new Set(), pairs: new Set() });
  });

  test("the target and the zero-slack projects are emphasised, a project with slack is not, the pairs are keyed in order", () => {
    const index = criticalIndex(view(BLOCK));
    expect(index.target).toBe(1);
    expect([...index.projects].sort()).toEqual([1, 3, 99]);
    expect(index.pairs).toEqual(new Set([pairKey(3, 1)]));
    expect(index.pairs.has(pairKey(1, 3))).toBe(false);
  });
});

describe("chainProjects", () => {
  test("the server's order, joined to the view's rows; a project the view does not hold is left out", () => {
    expect(chainProjects(allProjects(view(BLOCK)), BLOCK).map((row) => [row.project.name, row.slackDays, row.critical, row.hops])).toEqual([
      ["Gamma", 0, true, 1],
      ["Beta", 4, false, 2],
    ]);
  });

  test("without a block there is nothing to list", () => {
    expect(chainProjects(allProjects(view()), undefined)).toEqual([]);
  });
});

describe("withoutCriticalPath", () => {
  test("drops the block and keeps the rest; a view without one is returned as it is", () => {
    const plain = view();
    expect(withoutCriticalPath(plain)).toBe(plain);
    const stripped = withoutCriticalPath(view(BLOCK));
    expect(stripped).not.toHaveProperty("criticalPath");
    expect(stripped.ranked).toHaveLength(1);
  });
});

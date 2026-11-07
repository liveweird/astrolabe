import { describe, expect, test } from "vitest";
import type { ProgramsView } from "../api/programs";
import type { PlanFlag, RoadmapProject, RoadmapView } from "../api/roadmap";
import { applyProgramsWindow, applyRoadmapWindow } from "./targetWindowUpdate";

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"]): PlanFlag => ({ kind, severity, days: 3, teamId: null, otherProjectId: null, deviation: null, count: null });

const project = (id: number, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name: `P${id}`,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola",
  targetStart: "2026-02-02",
  targetEnd: "2026-03-31",
  rankPosition: null,
  teamIds: [],
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 28, endDays: 10 },
  flags: [flag("DRIFT_END_LATE", "WARNING"), flag("DRIFT_START_LATE", "INFO"), flag("RANK_INVERSION", "WARNING")],
  can: { editTargetWindow: true },
  ...over,
});

describe("applyRoadmapWindow", () => {
  const view: RoadmapView = {
    jiraSites: [],
    revision: 4,
    can: { editRank: true },
    teams: [],
    links: [],
    ranked: [{ position: 1, project: project(1) }],
    unranked: [project(2)],
  };

  test("replaces the window of a ranked or unranked project and drops the drift figures, keeping the rank inversion", () => {
    const moved = applyRoadmapWindow(view, 1, "2026-04-01", "2026-04-30");
    expect(moved.ranked[0].project).toMatchObject({ targetStart: "2026-04-01", targetEnd: "2026-04-30", drift: null, span: { start: "2026-03-02", end: "2026-04-10" } });
    expect(moved.ranked[0].project.flags.map((f) => f.kind)).toEqual(["RANK_INVERSION"]);
    expect(moved.unranked[0]).toBe(view.unranked[0]);
    expect(moved.revision).toBe(4);
    expect(applyRoadmapWindow(view, 2, null, null).unranked[0]).toMatchObject({ targetStart: null, targetEnd: null, drift: null });
  });

  test("a project that is not in the view leaves it as it was, and the input is never mutated", () => {
    const same = applyRoadmapWindow(view, 99, "2026-04-01", "2026-04-30");
    expect(same.ranked[0].project).toBe(view.ranked[0].project);
    applyRoadmapWindow(view, 1, null, null);
    expect(view.ranked[0].project.targetStart).toBe("2026-02-02");
  });
});

describe("applyProgramsWindow", () => {
  const view: ProgramsView = {
    jiraSites: [],
    revision: 9,
    teams: [],
    links: [],
    workStreams: [
      {
        id: 1,
        name: "Platform",
        ownerName: "Sam",
        startDate: "2026-01-05",
        endDate: null,
        span: null,
        flags: { warnings: 3, infos: 2 },
        programs: [
          { id: 10, name: "Billing", ownerName: "Pat", span: null, flags: { warnings: 2, infos: 1 }, projects: [project(1), project(2, { flags: [], drift: null })] },
          { id: 11, name: "Reports", ownerName: "Rita", span: null, flags: { warnings: 1, infos: 1 }, projects: [project(3)] },
        ],
      },
    ],
  };

  test("replaces the window and lowers the program's and the work stream's roll-up by the drift flags the project dropped", () => {
    const moved = applyProgramsWindow(view, 1, null, null);
    const [billing, reports] = moved.workStreams[0].programs;
    expect(billing.projects[0]).toMatchObject({ targetStart: null, targetEnd: null, drift: null });
    expect(billing.projects[0].flags.map((f) => f.kind)).toEqual(["RANK_INVERSION"]);
    expect(billing.flags).toEqual({ warnings: 1, infos: 0 });
    expect(moved.workStreams[0].flags).toEqual({ warnings: 2, infos: 1 });
    // The other program is the same object: nothing about it changed.
    expect(reports).toBe(view.workStreams[0].programs[1]);
  });

  test("a project without drift flags changes its window and no count; an unknown project changes nothing", () => {
    const moved = applyProgramsWindow(view, 2, "2026-05-04", "2026-05-29");
    expect(moved.workStreams[0].programs[0].projects[1]).toMatchObject({ targetStart: "2026-05-04", targetEnd: "2026-05-29" });
    expect(moved.workStreams[0].programs[0].flags).toEqual({ warnings: 2, infos: 1 });
    expect(moved.workStreams[0].flags).toEqual({ warnings: 3, infos: 2 });
    expect(applyProgramsWindow(view, 99, null, null).workStreams[0].programs[0]).toBe(view.workStreams[0].programs[0]);
  });
});

describe("the Jira flags are not drift", () => {
  const jira = [flag("JIRA_DEVIATION", "INFO"), flag("JIRA_MILESTONES", "WARNING")];
  const withJira = project(1, { flags: [flag("DRIFT_END_LATE", "WARNING"), ...jira] });

  test("a window edit keeps a project's Jira flags and the roll-up counts keep them", () => {
    const roadmap: RoadmapView = { jiraSites: [], revision: 1, can: { editRank: true }, teams: [], links: [], ranked: [], unranked: [withJira] };
    expect(applyRoadmapWindow(roadmap, 1, null, null).unranked[0].flags.map((f) => f.kind)).toEqual(["JIRA_DEVIATION", "JIRA_MILESTONES"]);

    const programs: ProgramsView = {
      jiraSites: [],
      revision: 1,
      teams: [],
      links: [],
      workStreams: [
        {
          id: 1,
          name: "Platform",
          ownerName: "Sam",
          startDate: "2026-01-05",
          endDate: null,
          span: null,
          flags: { warnings: 2, infos: 1 },
          programs: [{ id: 10, name: "Billing", ownerName: "Pat", span: null, flags: { warnings: 2, infos: 1 }, projects: [withJira] }],
        },
      ],
    };
    const moved = applyProgramsWindow(programs, 1, null, null);
    expect(moved.workStreams[0].programs[0].projects[0].flags.map((f) => f.kind)).toEqual(["JIRA_DEVIATION", "JIRA_MILESTONES"]);
    expect(moved.workStreams[0].programs[0].flags).toEqual({ warnings: 1, infos: 1 });
    expect(moved.workStreams[0].flags).toEqual({ warnings: 1, infos: 1 });
  });
});

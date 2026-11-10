import { describe, expect, test } from "vitest";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { jiraWindow } from "./jiraBars";
import type { RemovedProjectRow } from "./baselineOverlay";
import { allOpen, defaultOpen, programChoices, toggled, treeDates, treeFacts, treeRows } from "./programsTree";

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId: 0,
  programName: "",
  workStreamId: 0,
  workStreamName: "",
  ownerPersonId: 1,
  ownerName: "Ola",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

const program = (id: number, name: string, projects: RoadmapProject[], over: Partial<ProgramsProgram> = {}): ProgramsProgram => ({
  id,
  name,
  ownerName: "Pat",
  span: null,
  flags: { warnings: 0, infos: 0 },
  projects,
  ...over,
});

const stream = (id: number, name: string, programs: ProgramsProgram[], over: Partial<ProgramsWorkStream> = {}): ProgramsWorkStream => ({
  id,
  name,
  ownerName: "Sam",
  startDate: "2026-01-05",
  endDate: null,
  span: null,
  flags: { warnings: 0, infos: 0 },
  programs,
  ...over,
});

// Platform: Billing (two projects, a span, 2 warnings + 1 info) and Reports (one project, 1 info); Archive (closed): Legacy (no projects); Empty: no programs.
const BILLING = program(10, "Billing", [project(1, "Invoices", { span: { start: "2026-03-02", end: "2026-04-10" }, targetStart: "2026-02-01", targetEnd: "2026-03-31" }), project(2, "Taxes", { span: { start: "2026-05-04", end: "2026-06-05" } })], {
  span: { start: "2026-03-02", end: "2026-06-05" },
  flags: { warnings: 2, infos: 1 },
});
const REPORTS = program(11, "Reports", [project(3, "Dashboards", { span: { start: "2026-08-03", end: "2026-09-04" } })], { span: { start: "2026-08-03", end: "2026-09-04" }, flags: { warnings: 0, infos: 1 } });
const LEGACY = program(12, "Legacy", []);

const viewOf = (): ProgramsView => ({
  jiraSites: [],
  revision: 3,
  teams: [],
  links: [],
  workStreams: [
    stream(1, "Platform", [BILLING, REPORTS], { span: { start: "2026-03-02", end: "2026-09-04" }, flags: { warnings: 2, infos: 2 } }),
    stream(2, "Archive", [LEGACY], { endDate: "2026-06-30" }),
    stream(3, "Empty", []),
  ],
});

const shape = (rows: ReturnType<typeof treeRows>) =>
  rows.map((row) => {
    if (row.kind === "project") return `project:${row.project.name}`;
    return row.kind === "removedProject" ? `removed:${row.removed.name}` : `${row.kind}:${row.name}${row.expanded ? "+" : ""}`;
  });

const removedRow = (projectId: number, name: string, programId: number): RemovedProjectRow => ({
  id: `baseline-removed-project:${projectId}`,
  projectId,
  name,
  programId,
  programName: "",
  workStreamId: 1,
  workStreamName: "Platform",
  bar: { id: `baseline:${projectId}`, start: "2026-02-02", end: "2026-02-27", label: name, describe: name, editable: false, tone: "baseline" },
});

describe("treeRows", () => {
  test("the default opens every work stream and no program: stream rows with their programs, in the server's order", () => {
    const view = viewOf();
    expect(shape(treeRows(view, null, defaultOpen(view)))).toEqual(["workStream:Platform+", "program:Billing", "program:Reports", "workStream:Archive+", "program:Legacy", "workStream:Empty"]);
  });

  test("an expanded program lists its projects under it; collapsing everything leaves the stream rows", () => {
    const view = viewOf();
    expect(shape(treeRows(view, null, new Set(["ws:1", "pg:10"])))).toEqual(["workStream:Platform+", "program:Billing+", "project:Invoices", "project:Taxes", "program:Reports", "workStream:Archive", "workStream:Empty"]);
    expect(shape(treeRows(view, null, new Set()))).toEqual(["workStream:Platform", "workStream:Archive", "workStream:Empty"]);
  });

  test("a node with nothing to expand is never expanded, whatever the set holds", () => {
    const view = viewOf();
    const rows = treeRows(view, null, new Set(["ws:2", "pg:12", "ws:3"]));
    expect(rows.flatMap((row) => (row.kind === "workStream" || row.kind === "program" ? [[row.name, row.childCount, row.expanded]] : []))).toEqual([
      ["Platform", 2, false],
      ["Archive", 1, true],
      ["Legacy", 0, false],
      ["Empty", 0, false],
    ]);
  });

  test("a row carries the server's span and flag counts, the closed mark and its parent", () => {
    const view = viewOf();
    const rows = treeRows(view, null, allOpen(view));
    const platform = rows[0];
    expect(platform).toMatchObject({ kind: "workStream", key: "ws:1", span: { start: "2026-03-02", end: "2026-09-04" }, flags: { warnings: 2, infos: 2 }, closed: false });
    expect(rows[1]).toMatchObject({ kind: "program", key: "pg:10", workStreamId: 1, span: { start: "2026-03-02", end: "2026-06-05" }, flags: { warnings: 2, infos: 1 }, childCount: 2 });
    expect(rows.find((row) => row.kind === "workStream" && row.id === 2)).toMatchObject({ closed: true, span: null });
    expect(rows.find((row) => row.kind === "project")).toMatchObject({ programId: 10 });
  });

  test("the program pick keeps a picked program's stream row and hides the streams without one", () => {
    const view = viewOf();
    expect(shape(treeRows(view, new Set([11]), allOpen(view)))).toEqual(["workStream:Platform+", "program:Reports+", "project:Dashboards"]);
    expect(shape(treeRows(view, new Set([12]), allOpen(view)))).toEqual(["workStream:Archive+", "program:Legacy"]);
  });

  test("a work stream the pick shows in part is rolled up over the programs that remain; one shown whole keeps the server's figures", () => {
    const view = viewOf();
    expect(treeRows(view, new Set([11]), new Set())[0]).toMatchObject({ span: { start: "2026-08-03", end: "2026-09-04" }, flags: { warnings: 0, infos: 1 }, childCount: 1 });
    expect(treeRows(view, new Set([10, 11]), new Set())[0]).toMatchObject({ span: { start: "2026-03-02", end: "2026-09-04" }, flags: { warnings: 2, infos: 2 }, childCount: 2 });
    // Shown in part with no scheduled project among the remaining ones: no span.
    const unscheduled = viewOf();
    unscheduled.workStreams[0].programs = [LEGACY, REPORTS];
    expect(treeRows(unscheduled, new Set([12]), new Set())[0]).toMatchObject({ span: null, flags: { warnings: 0, infos: 0 } });
  });
});

describe("removed project rows (1.10)", () => {
  const removed = [removedRow(90, "Old", 10), removedRow(91, "Older", 10), removedRow(92, "Orphan", 99), removedRow(93, "Reporting", 11)];

  test("a removed row sits under its expanded program, after that program's projects, in the order given", () => {
    const view = viewOf();
    expect(shape(treeRows(view, null, new Set(["ws:1", "pg:10", "pg:11"]), removed))).toEqual([
      "workStream:Platform+",
      "program:Billing+",
      "project:Invoices",
      "project:Taxes",
      "removed:Old",
      "removed:Older",
      "program:Reports+",
      "project:Dashboards",
      "removed:Reporting",
      "workStream:Archive",
      "workStream:Empty",
    ]);
    expect(treeRows(view, null, new Set(["ws:1", "pg:10"]), removed).find((row) => row.kind === "removedProject")).toMatchObject({ programId: 10, removed: { id: "baseline-removed-project:90" } });
  });

  test("none when the program is collapsed, hidden by the pick or absent; no rows given, the same rows as before", () => {
    const view = viewOf();
    expect(shape(treeRows(view, null, new Set(["ws:1"]), removed))).toEqual(["workStream:Platform+", "program:Billing", "program:Reports", "workStream:Archive", "workStream:Empty"]);
    expect(shape(treeRows(view, new Set([11]), allOpen(view), removed))).toEqual(["workStream:Platform+", "program:Reports+", "project:Dashboards", "removed:Reporting"]);
    // Orphan's program (99) is not in the plan: no row, whatever is expanded.
    expect(shape(treeRows(view, null, allOpen(view, removed), removed))).not.toContain("removed:Orphan");
    expect(treeRows(view, null, allOpen(view))).toEqual(treeRows(view, null, allOpen(view), []));
  });

  test("a program whose live projects are all deleted still expands: the removed rows are its children (childCount, allOpen)", () => {
    const view = viewOf();
    const lost = [removedRow(94, "In legacy", 12)];
    expect(treeRows(view, null, new Set(["ws:2", "pg:12"]), []).find((row) => row.kind === "program" && row.id === 12)).toMatchObject({ childCount: 0, expanded: false });
    const rows = treeRows(view, null, new Set(["ws:2", "pg:12"]), lost);
    expect(rows.find((row) => row.kind === "program" && row.id === 12)).toMatchObject({ childCount: 1, expanded: true });
    expect(shape(rows)).toEqual(["workStream:Platform", "workStream:Archive+", "program:Legacy+", "removed:In legacy", "workStream:Empty"]);
    expect([...allOpen(view, lost)]).toEqual(["ws:1", "pg:10", "pg:11", "ws:2", "pg:12"]);
    expect([...allOpen(view)]).toEqual(["ws:1", "pg:10", "pg:11", "ws:2"]);
  });

  test("treeDates covers the removed projects' spans, whatever is folded or picked away", () => {
    const view = viewOf();
    view.baseline = {
      id: 5,
      name: "Q1",
      planRevision: 4,
      removedProjects: [
        { projectId: 90, name: "Old", programId: 10, programName: "Billing", workStreamId: 1, workStreamName: "Platform", span: { start: "2025-11-03", end: "2025-12-12" } },
        { projectId: 91, name: "Spanless", programId: 10, programName: "Billing", workStreamId: 1, workStreamName: "Platform", span: null },
      ],
    };
    expect(treeDates(view)).toEqual(expect.arrayContaining(["2025-11-03", "2025-12-12"]));
    expect(treeDates(view)).toHaveLength(treeDates(viewOf()).length + 2);
  });
});

describe("the expanded set", () => {
  test("defaultOpen is the work streams, allOpen every node with children, toggled flips one key without touching the original", () => {
    const view = viewOf();
    expect([...defaultOpen(view)]).toEqual(["ws:1", "ws:2", "ws:3"]);
    expect([...allOpen(view)]).toEqual(["ws:1", "pg:10", "pg:11", "ws:2"]);
    const open = new Set(["ws:1"]);
    expect([...toggled(open, "pg:10")]).toEqual(["ws:1", "pg:10"]);
    expect([...toggled(open, "ws:1")]).toEqual([]);
    expect([...open]).toEqual(["ws:1"]);
  });
});

describe("the pick, the facts and the range", () => {
  test("programChoices lists every program (empty ones too) by name with its work stream", () => {
    expect(programChoices(viewOf())).toEqual([
      { id: 10, name: "Billing", workStreamName: "Platform" },
      { id: 12, name: "Legacy", workStreamName: "Archive" },
      { id: 11, name: "Reports", workStreamName: "Platform" },
    ]);
  });

  test("treeFacts counts what the pick leaves and sums the flag roll-ups of the shown streams", () => {
    const view = viewOf();
    expect(treeFacts(view, null)).toEqual({ workStreams: 3, programs: 3, projects: 3, flags: { warnings: 2, infos: 2 } });
    expect(treeFacts(view, new Set([11]))).toEqual({ workStreams: 1, programs: 1, projects: 1, flags: { warnings: 0, infos: 1 } });
  });

  test("treeDates holds the spans and windows of every project, whatever is folded or picked away", () => {
    expect(treeDates(viewOf()).sort()).toEqual(["2026-02-01", "2026-03-02", "2026-03-31", "2026-04-10", "2026-05-04", "2026-06-05", "2026-08-03", "2026-09-04"]);
  });

  test("treeDates adds the dates Jira holds only with the page's window, only when both are known, cut at it", () => {
    const plain = viewOf();
    const [stream, ...others] = plain.workStreams;
    const [program, ...programs] = stream.programs;
    const [first, second, ...projects] = program.projects;
    const bound = (link: { start: string | null; end: string | null }) => ({ bindingId: 1, connectionId: 2, issueKey: "E2E-6", rollup: null, ...link });
    const view = {
      ...plain,
      workStreams: [{ ...stream, programs: [{ ...program, projects: [{ ...first, jira: bound({ start: "2026-03-09", end: "2206-03-05" }) }, { ...second, jira: bound({ start: "2026-05-04", end: null }) }, ...projects] }, ...programs] }, ...others],
    };
    const window = jiraWindow(treeDates(view), "2030-01-01");
    expect(treeDates(view)).toEqual(treeDates(view, null));
    expect(treeDates(view).some((date) => date > "2100")).toBe(false);
    expect(treeDates(view, window).filter((date) => !treeDates(view).includes(date))).toEqual(["2026-03-09", "2027-09-04"]);
  });
});

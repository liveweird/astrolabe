import { describe, expect, test } from "vitest";
import type { TFunction } from "i18next";
import type { PlanProgram, PlanView, PlanWorkStream } from "../api/plan";
import { canMoveProgram, canMoveProject, findProgram, findProject, hasTarget, programMoveTargets, projectMoveTargets } from "./planMove";

// A translator stub: only the closed-name key is used here.
const t = ((key: string, options?: { name?: string }) => (key === "plan.move.closedName" ? `${options?.name} (closed)` : key)) as unknown as TFunction;

const program = (id: number, name: string, workStreamId: number, createProject = true): PlanProgram =>
  ({ id, name, workStreamId, can: { edit: true, delete: true, createProject, move: true }, projects: [] }) as unknown as PlanProgram;
const stream = (id: number, name: string, programs: PlanProgram[], over: { endDate?: string | null; createProgram?: boolean } = {}): PlanWorkStream =>
  ({ id, name, endDate: over.endDate ?? null, can: { edit: true, delete: true, createProgram: over.createProgram ?? true }, programs }) as unknown as PlanWorkStream;

const VIEW = {
  revision: 1,
  can: { createWorkStream: true },
  workStreams: [
    stream(1, "Platform", [program(10, "Billing", 1), program(11, "Identity", 1), program(12, "Secret", 1, false)]),
    stream(2, "Legacy", [program(20, "Archive", 2)], { endDate: "2025-12-31" }),
    stream(3, "Empty", [program(30, "Locked", 3, false)]),
    stream(4, "Barren", [], { createProgram: false }),
  ],
} as unknown as PlanView;

describe("move targets", () => {
  test("a project's targets are the programs it could be created in, minus its own, grouped by stream with closed ones labelled", () => {
    expect(projectMoveTargets(VIEW, { programId: 10 }, t)).toEqual([
      { group: "Platform", items: [{ value: "11", label: "Identity" }] },
      { group: "Legacy (closed)", items: [{ value: "20", label: "Archive" }] },
    ]);
  });

  test("a project with no other open program has no targets (streams without one drop out)", () => {
    const only: PlanView = { ...VIEW, workStreams: [stream(1, "Platform", [program(10, "Billing", 1), program(12, "Secret", 1, false)])] } as PlanView;
    expect(projectMoveTargets(only, { programId: 10 }, t)).toEqual([]);
  });

  test("a program's targets are the streams it could be created in, minus its own, closed ones labelled", () => {
    expect(programMoveTargets(VIEW, { workStreamId: 1 }, t)).toEqual([
      { value: "2", label: "Legacy (closed)" },
      { value: "3", label: "Empty" },
    ]);
    expect(programMoveTargets(VIEW, { workStreamId: 2 }, t).map((o) => o.value)).toEqual(["1", "3"]);
  });

  test("hasTarget reads flat and grouped options, and a pick a reload took away is no target", () => {
    const groups = projectMoveTargets(VIEW, { programId: 10 }, t);
    expect(hasTarget(groups, "20")).toBe(true);
    expect(hasTarget(groups, "10")).toBe(false);
    expect(hasTarget(groups, null)).toBe(false);
    expect(hasTarget(programMoveTargets(VIEW, { workStreamId: 1 }, t), "3")).toBe(true);
    expect(hasTarget([], "3")).toBe(false);
  });
});

describe("live lookups and the offer tests", () => {
  const withProject = (programs: PlanProgram[]) => programs.map((p) => ({ ...p, projects: [{ id: 100, programId: p.id, name: "Invoices", can: { move: true } }] }) as unknown as PlanProgram);

  test("findProject / findProgram read the node and its CURRENT parent, null when it is gone", () => {
    const view = { ...VIEW, workStreams: [stream(1, "Platform", withProject([program(10, "Billing", 1)]).concat(program(11, "Identity", 1)))] } as PlanView;
    expect(findProject(view, 100)?.program.name).toBe("Billing");
    expect(findProject(view, 999)).toBeNull();
    expect(findProgram(view, 11)?.stream.name).toBe("Platform");
    expect(findProgram(view, 999)).toBeNull();
  });

  test("canMoveProject needs can.move and an eligible program other than its own", () => {
    const project = { programId: 10, can: { move: true } };
    expect(canMoveProject(VIEW, project as never)).toBe(true);
    expect(canMoveProject(VIEW, { ...project, can: { move: false } } as never)).toBe(false);
    const lonely = { ...VIEW, workStreams: [stream(1, "Platform", [program(10, "Billing", 1), program(12, "Secret", 1, false)])] } as PlanView;
    expect(canMoveProject(lonely, project as never)).toBe(false);
  });

  test("canMoveProgram needs can.move and another stream that takes programs", () => {
    const own = { workStreamId: 1, can: { move: true } };
    expect(canMoveProgram(VIEW, own as never)).toBe(true);
    expect(canMoveProgram(VIEW, { ...own, can: { move: false } } as never)).toBe(false);
    const closedOff = { ...VIEW, workStreams: VIEW.workStreams.map((ws) => ({ ...ws, can: { ...ws.can, createProgram: ws.id === 1 } })) } as PlanView;
    expect(canMoveProgram(closedOff, own as never)).toBe(false);
  });
});

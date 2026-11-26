import type { PlanView, PlanWorkStream } from "../api/plan";
import { byNameThenId, compareNames } from "./text";

/**
 * The names a URL's ids stand for, from the plan view (everyone reads it, and the Plan page's cache entry serves it): the scope chips on the
 * Deviations pages say "Project: Checkout", not a number.
 */
export function planNames(plan: PlanView | undefined) {
  const projects = new Map<number, string>();
  const programs = new Map<number, string>();
  for (const stream of plan?.workStreams ?? []) {
    for (const program of stream.programs) {
      programs.set(program.id, program.name);
      for (const project of program.projects) projects.set(project.id, project.name);
    }
  }
  return { projects, programs };
}

/**
 * Work streams as a picker or a list of targets shows them: open before closed, then by name (case-insensitive) and id. The plan view's own
 * order is the SHARED order (`plan-tree.md`: a hand arrangement of the Plan and Programs pages), which only those two pages draw; every other
 * list sorts explicitly, so an arrangement never leaks into it.
 */
export function openFirstByName<T extends Pick<PlanWorkStream, "id" | "name" | "endDate">>(streams: readonly T[]): T[] {
  return [...streams].sort((a, b) => Number(a.endDate !== null) - Number(b.endDate !== null) || byNameThenId(a, b));
}

/** The three levels of the plan a filter select can pick. */
export type PlanLevel = "workStream" | "program" | "project";

/** A narrowing for a select's options: only the nodes under this work stream and/or program (both given = both must hold). */
export type PlanScope = { workStreamId?: number; programId?: number };

/** Each program's work stream and each project's program, from the plan view: what the Milestones filters' cascade asks. */
export type PlanParents = { programStream: ReadonlyMap<number, number>; projectProgram: ReadonlyMap<number, number> };

type Entry = { id: number; name: string; parent: string; workStreamId: number; programId: number | undefined };

// Work stream names and program names are unique among active rows, case-insensitively (V12 `uq_work_streams_name_active`, `uq_programs_name_active`), so only
// projects (unique per program) can share a label; the program's work stream suffix is kept as the program pick's own rule, never needed in practice.
function entriesOf(plan: PlanView | undefined, level: PlanLevel): Entry[] {
  const entries: Entry[] = [];
  for (const stream of plan?.workStreams ?? []) {
    if (level === "workStream") entries.push({ id: stream.id, name: stream.name, parent: "", workStreamId: stream.id, programId: undefined });
    for (const program of stream.programs) {
      if (level === "program") entries.push({ id: program.id, name: program.name, parent: stream.name, workStreamId: stream.id, programId: program.id });
      if (level !== "project") continue;
      for (const project of program.projects) entries.push({ id: project.id, name: project.name, parent: program.name, workStreamId: stream.id, programId: program.id });
    }
  }
  return entries;
}

/**
 * Every node of one level as a select option, by label (case-insensitive) then id, narrowed to `within` when given. Two nodes of one name are told
 * apart by their parent ("Name (Program)" for a project, "Name (Work stream)" for a program, the program pick's rule for same-named programs); a name
 * that is unique stands alone, and the labels are worked out BEFORE the narrowing, so a node's label does not change with the scope.
 */
function planOptions(plan: PlanView | undefined, level: PlanLevel, within: PlanScope = {}): { id: number; label: string }[] {
  const entries = entriesOf(plan, level);
  const count = new Map<string, number>();
  for (const entry of entries) count.set(entry.name, (count.get(entry.name) ?? 0) + 1);
  return entries
    .filter((entry) => (within.workStreamId === undefined || entry.workStreamId === within.workStreamId) && (within.programId === undefined || entry.programId === within.programId))
    .map((entry) => ({ id: entry.id, label: (count.get(entry.name) ?? 0) > 1 && entry.parent !== "" ? `${entry.name} (${entry.parent})` : entry.name }))
    .sort((a, b) => compareNames(a.label, b.label) || a.id - b.id);
}

/** Every work stream of the plan as a select option. */
export const workStreamOptions = (plan: PlanView | undefined) => planOptions(plan, "workStream");

/** Every program of the plan as a select option, or only those of the work stream in `within`. */
export const programOptions = (plan: PlanView | undefined, within?: PlanScope) => planOptions(plan, "program", within);

/** Every project of the plan as a select option, or only those under the work stream and/or program in `within`. */
export const projectOptions = (plan: PlanView | undefined, within?: PlanScope) => planOptions(plan, "project", within);

/** The parents of every program and project of the plan (the cascade of the Milestones filters reads them). */
export function planParents(plan: PlanView | undefined): PlanParents {
  const programStream = new Map<number, number>();
  const projectProgram = new Map<number, number>();
  for (const stream of plan?.workStreams ?? []) {
    for (const program of stream.programs) {
      programStream.set(program.id, stream.id);
      for (const project of program.projects) projectProgram.set(project.id, program.id);
    }
  }
  return { programStream, projectProgram };
}

import type { PlanView } from "../api/plan";
import { compareNames } from "./text";

/**
 * The names a URL's ids stand for, from the plan view (everyone reads it, and the Plan page's cache entry serves it): the scope chips on the
 * Deviations and Milestones pages say "Project: Checkout", not a number.
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
 * Every project of the plan as a select option, by label (case-insensitive) then id. Two projects of one name are told apart by their program
 * ("Name (Program)", the program pick's rule for same-named programs); a name that is unique stands alone.
 */
export function projectOptions(plan: PlanView | undefined): { id: number; label: string }[] {
  const entries: { id: number; name: string; program: string }[] = [];
  for (const stream of plan?.workStreams ?? []) {
    for (const program of stream.programs) {
      for (const project of program.projects) entries.push({ id: project.id, name: project.name, program: program.name });
    }
  }
  const count = new Map<string, number>();
  for (const entry of entries) count.set(entry.name, (count.get(entry.name) ?? 0) + 1);
  return entries
    .map((entry) => ({ id: entry.id, label: (count.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.program})` : entry.name }))
    .sort((a, b) => compareNames(a.label, b.label) || a.id - b.id);
}

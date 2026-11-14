import type { PlanView } from "../api/plan";

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

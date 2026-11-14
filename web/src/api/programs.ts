// Programs API (`/api/v1/views/programs`, v0.6) — the plan as a tree for the programs timeline: work stream -> program -> project, with the derived
// spans and the flag roll-ups. A read for everyone signed in; nothing is written through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { buildQuery, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ProgramsView = Schemas["ProgramsView"];
export type ProgramsWorkStream = Schemas["ProgramsWorkStream"];
export type ProgramsProgram = Schemas["ProgramsProgram"];

/**
 * The cached view's key: under the `["roadmap"]` prefix, which the Plan page and the project view already refresh after their mutations.
 * It carries the baseline pick (v0.9) and the critical-path target (1.16), so another pick or target is another entry.
 */
export const programsViewKey = (baseline: number | null, criticalPath: number | null = null) => ["roadmap", "programs", { baseline, criticalPath }] as const;

/**
 * `baseline` (v0.9) is the id of the baseline to compare with: the document then gains its `baseline` blocks. `criticalPath` (1.16) is the id of the
 * project to show the critical chain toward: the document then gains its `criticalPath` block (the roadmap's). Absent or null = the plain view; both may be combined.
 */
export async function getProgramsView(baseline?: number | null, criticalPath?: number | null): Promise<ProgramsView> {
  const query = buildQuery({ baseline, criticalPath });
  return jsonRequest<ProgramsView>(`/api/v1/views/programs${query === "" ? "" : `?${query}`}`);
}

// Programs API (`/api/v1/views/programs`, v0.6) — the plan as a tree for the programs timeline: work stream -> program -> project, with the derived
// spans and the flag roll-ups. A read for everyone signed in; nothing is written through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { baselineSuffix } from "./baselines";
import { jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ProgramsView = Schemas["ProgramsView"];
export type ProgramsWorkStream = Schemas["ProgramsWorkStream"];
export type ProgramsProgram = Schemas["ProgramsProgram"];

/**
 * The cached view's key: under the `["roadmap"]` prefix, which the Plan page and the project view already refresh after their mutations.
 * It carries the baseline pick (v0.9), so another pick is another entry.
 */
export const programsViewKey = (baseline: number | null) => ["roadmap", "programs", { baseline }] as const;

/** `baseline` (v0.9) is the id of the baseline to compare with: the document then gains its `baseline` blocks; absent or null = the plain view. */
export async function getProgramsView(baseline?: number | null): Promise<ProgramsView> {
  return jsonRequest<ProgramsView>(`/api/v1/views/programs${baselineSuffix(baseline)}`);
}

// Programs API (`/api/v1/views/programs`, v0.6) — the plan as a tree for the programs timeline: work stream -> program -> project, with the derived
// spans and the flag roll-ups. A read for everyone signed in; nothing is written through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ProgramsView = Schemas["ProgramsView"];
export type ProgramsWorkStream = Schemas["ProgramsWorkStream"];
export type ProgramsProgram = Schemas["ProgramsProgram"];

/** The cached view's key: under the `["roadmap"]` prefix, which the Plan page and the project view already refresh after their mutations. */
export const programsViewKey = ["roadmap", "programs"] as const;

export async function getProgramsView(): Promise<ProgramsView> {
  return jsonRequest<ProgramsView>("/api/v1/views/programs");
}

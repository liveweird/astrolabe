// Team load API (`/api/v1/views/team-load`, 1.19; the Teams page's one read since 1.32) - every team's milestones and flagged weeks in one read. A read for everyone signed in; nothing is
// written through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { revalidatedRequest } from "./revalidate";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type TeamLoadView = Schemas["TeamLoadView"];
export type TeamLoadRow = Schemas["TeamLoadRow"];

/** The cached view's key, under the `["plan"]` prefix a schedule or capacity write already refreshes. */
export const TEAM_LOAD_KEY = ["plan", "teamLoad"] as const;

/** The team-load document; it takes no parameter (it is the same for every caller). */
export async function getTeamLoadView(): Promise<TeamLoadView> {
  return revalidatedRequest<TeamLoadView>("/api/v1/views/team-load");
}

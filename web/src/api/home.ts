// Home API (`/api/v1/views/home`, 1.18) - the plan's figures and the caller's own items in one read. A read for everyone signed in; nothing is written
// through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type HomeView = Schemas["HomeView"];
export type HomePlan = Schemas["HomePlan"];
export type HomeMe = Schemas["HomeMe"];

/** The cached view's key, under the `["plan"]` prefix a plan write already refreshes. */
export const HOME_VIEW_KEY = ["plan", "home"] as const;

/**
 * How long Home keeps its read (ms), like the two deviation counts beside it (`useOpenDeviationCounts`): coming back to Home or refocusing the tab inside
 * the minute makes no request. A change the user makes themselves still shows at once, because every write that moves a Home figure refreshes `["plan"]`
 * or names this key (the ranking, the Teams registry, the People pages, the login-person link, and the Jira and Flow connection, mapping, run, team-link
 * and refused-acknowledge writes); another person's change, a scheduled poll and a run that ends after the user left its page show after at most a minute.
 */
export const HOME_STALE_MS = 60_000;

/** The caller's Home document; it takes no parameter (it is always the caller's own). */
export async function getHomeView(): Promise<HomeView> {
  return jsonRequest<HomeView>("/api/v1/views/home");
}

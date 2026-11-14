// Home API (`/api/v1/views/home`, 1.18) - the plan's figures and the caller's own items in one read. A read for everyone signed in; nothing is written
// through it. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type HomeView = Schemas["HomeView"];
export type HomePlan = Schemas["HomePlan"];
export type HomeMe = Schemas["HomeMe"];

/** The cached view's key, under the `["plan"]` prefix a plan write already refreshes; no `staleTime`, so Home re-reads on every mount and focus. */
export const HOME_VIEW_KEY = ["plan", "home"] as const;

/** The caller's Home document; it takes no parameter (it is always the caller's own). */
export async function getHomeView(): Promise<HomeView> {
  return jsonRequest<HomeView>("/api/v1/views/home");
}

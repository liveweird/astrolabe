// Dependencies list API (`/api/v1/views/dependencies`, 1.20) - every dependency of the plan in one read, the ones that do not hold first. A read
// for everyone signed in, the same for every caller; nothing is written through it. The WIRE document names each end by kind and id and states the
// names once (1.21); `utils/dependencyListRows.ts` joins them back onto the rows. Thin endpoint wrapper: transport in ./http, types from ./schema.

import { jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type DependencyListView = Schemas["DependencyListView"];

/** The cached view's key, under the `["plan"]` prefix every plan write already refreshes. */
export const DEPENDENCY_LIST_KEY = ["plan", "dependencies"] as const;

/** The dependencies document; it takes no parameter (the filters narrow the rows that arrived, in the browser). */
export async function getDependencyListView(): Promise<DependencyListView> {
  return jsonRequest<DependencyListView>("/api/v1/views/dependencies");
}

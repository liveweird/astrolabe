// Fixtures for the plan view: whole documents as GET /views/plan answers them, typed over the schema.
import type { PlanView } from "../api/plan";

/** An empty plan the caller may add a work stream to. Override any member (`can` and `workStreams` are replaced whole). */
export function planView(over: Partial<PlanView> = {}): PlanView {
  return { revision: 1, can: { createWorkStream: true }, workStreams: [], ...over };
}

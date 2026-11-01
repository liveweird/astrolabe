// Calendar API — the global public-holiday dictionary (V19): every authenticated user reads it (the timelines hatch its days, the
// schedule dialog's pre-check counts them), an ADMIN adds, deletes and applies the Polish preset. Thin endpoint wrappers: transport
// (authedFetch/ApiError) in ./http, types from ./schema.

import { jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type PublicHoliday = Schemas["PublicHolidayResponse"];
export type PublicHolidayCreateBody = Schemas["PublicHolidayCreateRequest"];
export type HolidayPresetBody = Schemas["HolidayPresetRequest"];
export type HolidayPresetResult = Schemas["HolidayPresetResponse"];

/** The whole dictionary, oldest date first — unpaged (a bounded, admin-curated set: about 14 rows a year). */
export async function listPublicHolidays(): Promise<PublicHoliday[]> {
  return (await jsonRequest<Schemas["PublicHolidayList"]>("/api/v1/public-holidays")).items;
}

/** ADMIN only; a second holiday on one date is a `409`. */
export async function createPublicHoliday(body: PublicHolidayCreateBody): Promise<PublicHoliday> {
  return jsonRequest<PublicHoliday>("/api/v1/public-holidays", { method: "POST", body: JSON.stringify(body) });
}

/** ADMIN only; a hard delete (`204`, `404` once it is gone). */
export async function deletePublicHoliday(id: number): Promise<void> {
  await voidRequest(`/api/v1/public-holidays/${id}`, { method: "DELETE" });
}

/** ADMIN only; idempotent: the preset's dates that already have a holiday come back as `skipped`, untouched. */
export async function applyHolidayPreset(body: HolidayPresetBody): Promise<HolidayPresetResult> {
  return jsonRequest<HolidayPresetResult>("/api/v1/public-holidays/apply-preset", { method: "POST", body: JSON.stringify(body) });
}

/** One probe row of a connection test, as Jira's and Flow's results carry it (the two schemas are the same shape). */
export type TestRow = {
  name: string;
  path: string;
  required: boolean;
  ok: boolean;
  status?: number | null;
  code?: string | null;
  scopeHint?: string | null;
};

/** A probe the server did not run because an earlier one failed (`tenant_info`, Flow's `me`): `ok` is false, but the row is no failure of its own. */
export function isSkipped(row: TestRow): boolean {
  return !row.ok && row.code === "SKIPPED";
}

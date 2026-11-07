import type { JiraTestRow } from "../api/jira";

/** A probe the server did not run because an earlier one failed (`tenant_info`): `ok` is false, but the row is no failure of its own. */
export function isSkipped(row: JiraTestRow): boolean {
  return !row.ok && row.code === "SKIPPED";
}

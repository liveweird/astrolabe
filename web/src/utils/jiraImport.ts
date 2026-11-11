import type { JiraImportApplyItem, JiraImportApplyRequest, JiraImportItem, JiraImportScope } from "../api/jira";
import type { PickedOption } from "../components/SearchPicker";

// The import modal's pure model (1.2): the ticks and their dependencies, the scope form, and the apply body. No React, no i18n.

/** A row is tickable when the preview would write it: a CREATE or a BIND. A SKIP row is told in words and has no checkbox. */
export const isSelectable = (item: JiraImportItem): boolean => item.action !== "SKIP";

/** The batch row this row's landing depends on (a new parent, or a BIND parent): unticking it skips this one (`PARENT_SKIPPED`). */
const dependsOn = (item: JiraImportItem): string | null => item.parent?.rowJiraId ?? null;

export type ImportIndex = { byId: ReadonlyMap<string, JiraImportItem>; children: ReadonlyMap<string, readonly string[]> };

export function indexItems(items: readonly JiraImportItem[]): ImportIndex {
  const byId = new Map(items.map((item) => [item.jiraId, item] as const));
  const children = new Map<string, string[]>();
  for (const item of items) {
    const parentId = isSelectable(item) ? dependsOn(item) : null;
    if (parentId !== null && byId.has(parentId)) children.set(parentId, [...(children.get(parentId) ?? []), item.jiraId]);
  }
  return { byId, children };
}

/** Everything the preview would write, ticked (the opening state, and "Select all"). */
export const allSelectable = (items: readonly JiraImportItem[]): Set<string> => new Set(items.filter(isSelectable).map((item) => item.jiraId));

function descendants(index: ImportIndex, id: string): string[] {
  const found: string[] = [];
  const stack = [...(index.children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    found.push(next);
    stack.push(...(index.children.get(next) ?? []));
  }
  return found;
}

function ancestors(index: ImportIndex, id: string): string[] {
  const found: string[] = [];
  let current = index.byId.get(id);
  while (current !== undefined) {
    const parentId = dependsOn(current);
    const parent = parentId === null ? undefined : index.byId.get(parentId);
    if (parent !== undefined && isSelectable(parent)) found.push(parent.jiraId);
    current = parent;
  }
  return found;
}

/**
 * Ticks or unticks one row, keeping the dependencies true: unticking a row also unticks everything created under it (the server would
 * skip those as `PARENT_SKIPPED`; the modal shows it before submit instead), and ticking a row also ticks the rows it lands under.
 * `alsoChanged` is how many OTHER rows moved with it, for the polite announcement.
 */
export function tickRow(index: ImportIndex, ticks: ReadonlySet<string>, id: string, on: boolean): { ticks: Set<string>; alsoChanged: number } {
  const next = new Set(ticks);
  const related = (on ? ancestors(index, id) : descendants(index, id)).filter((other) => next.has(other) !== on);
  for (const other of [id, ...related]) {
    if (on) next.add(other);
    else next.delete(other);
  }
  return { ticks: next, alsoChanged: related.length };
}

/** The nearest unticked row an unticked row lands under: it explains "not imported because its parent is not". */
export function blockingParent(index: ImportIndex, ticks: ReadonlySet<string>, item: JiraImportItem): JiraImportItem | undefined {
  if (!isSelectable(item) || ticks.has(item.jiraId)) return undefined;
  return ancestors(index, item.jiraId)
    .map((id) => index.byId.get(id) as JiraImportItem)
    .find((parent) => !ticks.has(parent.jiraId));
}

/**
 * Ticked, dated milestone CREATEs the caller cannot schedule: the server marks them `DATES_NOT_COPIED` (the kernel decides; nothing is
 * re-derived here). With "Copy Jira's dates" off every row carries the same note for a different reason, so nothing is counted then.
 */
export function unscheduledForRights(items: readonly JiraImportItem[], ticks: ReadonlySet<string>, copyDates: boolean): { count: number; of: number } {
  if (!copyDates) return { count: 0, of: 0 };
  const dated = items.filter((item) => ticks.has(item.jiraId) && item.action === "CREATE" && item.level === "MILESTONE" && item.startDate != null && item.endDate != null);
  return { count: dated.filter((item) => item.infos.includes("DATES_NOT_COPIED")).length, of: dated.length };
}

/** The scope form's state. Work stream, defaults and keys are ids/strings; the owner and the team keep their label (the pickers hold it). */
export type ScopeForm = {
  workStreamId: string | null;
  owner: PickedOption | null;
  team: PickedOption | null;
  programId: string | null;
  projectId: string | null;
  keys: string[];
  copyDates: boolean;
  /** "Leave out done items" (the request's `filter.excludeDone`). */
  excludeDone: boolean;
  /** "Updated within (days)": a NumberInput hands back a string while it holds no number (cleared, or half typed); empty = no time limit. */
  updatedWithinDays: number | string;
};

/** The import filter's bounds on `updatedWithinDays` (`MIN/MAX_IMPORT_UPDATED_DAYS` in `JiraImport.kt`: the server refuses anything else with a 400) and the dialog's opening value. */
export const MIN_IMPORT_UPDATED_DAYS = 1;
export const MAX_IMPORT_UPDATED_DAYS = 3650;
const DEFAULT_IMPORT_UPDATED_DAYS = 365;

/** What the days field stands for: `{ days: null }` for an empty field (no time limit), `{ days }` for a whole number inside the bounds, null for anything else (0, 3651, 1.5, text). */
export function updatedWithinOf(value: number | string): { days: number | null } | null {
  if (typeof value === "string" && value.trim() === "") return { days: null };
  const days = Number(value);
  return Number.isInteger(days) && days >= MIN_IMPORT_UPDATED_DAYS && days <= MAX_IMPORT_UPDATED_DAYS ? { days } : null;
}

/** `workStreamId` presets the stream (the Plan page's work-stream menu: the stream is the intent, so the scope step shows it read-only). */
export const emptyScope = (allKeys: readonly string[], workStreamId?: number): ScopeForm => ({
  workStreamId: workStreamId === undefined ? null : String(workStreamId),
  owner: null,
  team: null,
  programId: null,
  projectId: null,
  keys: [...allKeys],
  copyDates: true,
  excludeDone: true,
  updatedWithinDays: DEFAULT_IMPORT_UPDATED_DAYS,
});

/**
 * What the import modal needs of a connection: the connection page's `JiraConnection` is structurally one, and so is a deviations view's
 * `connections[]` row (every signed-in user may read it, unlike the ADMIN-only registry).
 */
export type ImportConnection = { id: number; name: string; siteUrl: string; projectKeys: readonly string[] };

/** Where the import modal's connections come from (the bind dialog's `BindSource` contract): null = not known (yet, or the query failed). Only usable connections are listed. */
export type ImportSource = { connections: readonly ImportConnection[] | null; failed: boolean; retry: () => void };

/**
 * The request scope; null while the work stream, the owner or the keys are missing, or the days field holds a value the server would refuse. All keys
 * ticked = no `projectKeys` (the server's default: every key of the connection). `filter` is sent only when a control is on (both off = the request of
 * before the filter existed); an empty days field sends no `updatedWithinDays`.
 */
export function toScope(form: ScopeForm, allKeys: readonly string[]): JiraImportScope | null {
  if (form.workStreamId === null || form.owner === null || form.keys.length === 0) return null;
  const within = updatedWithinOf(form.updatedWithinDays);
  if (within === null) return null;
  const defaults = {
    ...(form.programId === null ? {} : { programId: Number(form.programId) }),
    ...(form.projectId === null ? {} : { projectId: Number(form.projectId) }),
    ...(form.team === null ? {} : { teamId: Number(form.team.value) }),
  };
  return {
    workStreamId: Number(form.workStreamId),
    ownerPersonId: Number(form.owner.value),
    ...(form.keys.length < allKeys.length ? { projectKeys: form.keys } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    copyDates: form.copyDates,
    ...(form.excludeDone || within.days !== null ? { filter: { excludeDone: form.excludeDone, ...(within.days === null ? {} : { updatedWithinDays: within.days }) } } : {}),
  };
}

/**
 * What the preview showed for one ticked row. The body is STRICT (no unknown keys): `expected.parent` takes ONLY `{kind, nodeId}`, so the
 * preview's `{kind, nodeId, nodeName, rowJiraId}` is projected, never echoed. Members that do not apply to the row are left out: a BIND
 * carries `nodeId` (its target), a CREATE below a program carries `parent`, a milestone CREATE carries `teamId` (the team the row SHOWED,
 * whatever an override says).
 */
function expectedOf(item: JiraImportItem): JiraImportApplyItem["expected"] {
  const create = item.action === "CREATE";
  return {
    action: create ? "CREATE" : "BIND",
    level: item.level,
    ...(item.parentJiraId == null ? {} : { parentJiraId: item.parentJiraId }),
    ...(!create && item.target ? { nodeId: item.target.nodeId } : {}),
    ...(create && item.parent ? { parent: { kind: item.parent.kind, ...(item.parent.nodeId == null ? {} : { nodeId: item.parent.nodeId }) } } : {}),
    ...(create && item.level === "MILESTONE" && item.team ? { teamId: item.team.id } : {}),
  };
}

/** The apply body: the preview's own scope plus the ticked rows, in preview order; an override team is sent only where it differs from the row's. */
export function toApplyRequest(scope: JiraImportScope, items: readonly JiraImportItem[], ticks: ReadonlySet<string>, teamOverrides: ReadonlyMap<string, number>): JiraImportApplyRequest {
  return {
    ...scope,
    items: items
      .filter((item) => ticks.has(item.jiraId) && isSelectable(item))
      .map((item) => {
        const override = teamOverrides.get(item.jiraId);
        return {
          jiraId: item.jiraId,
          expected: expectedOf(item),
          ...(override !== undefined && override !== item.team?.id ? { overrides: { teamId: override } } : {}),
        };
      }),
  };
}

/** The connections the Plan page offers the import: enabled, with a mapping that fits the site (otherwise the server answers 409 `jira-mapping-invalid`). */
export const usableImportConnections = (connections: readonly (ImportConnection & { enabled: boolean; mappingOk: boolean })[]): ImportConnection[] =>
  connections.filter((connection) => connection.enabled && connection.mappingOk);

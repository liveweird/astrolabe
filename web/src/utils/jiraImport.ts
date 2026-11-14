import type { JiraImportApplyItem, JiraImportApplyRequest, JiraImportItem, JiraImportMatch, JiraImportRoot, JiraImportScope } from "../api/jira";
import type { PickedOption } from "../components/SearchPicker";
import { foldDiacritics } from "./text";

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

/**
 * The preview search (1.13.4): the rows whose Jira key, Jira id, summary or plan name contain the query, case- and accent-insensitive
 * (`foldDiacritics`, the rule of `foldedOptionsFilter`); a blank query keeps every row. A row redacted for a non-admin (no key) NEVER matches
 * a non-empty query: its id is a synthetic `hidden-n` placeholder and its name is blank, and a search must not probe what the key withholds.
 */
export function searchItems(items: readonly JiraImportItem[], query: string): readonly JiraImportItem[] {
  const needle = foldDiacritics(query.trim());
  if (needle === "") return items;
  return items.filter((item) => item.issueKey !== null && [item.issueKey, item.jiraId, item.summary, item.name].some((field) => foldDiacritics(field).includes(needle)));
}

/**
 * Ticks or unticks every selectable row of `shown` ("Tick shown" / "Untick shown"; with no search, "Select all" / "Select none"), keeping the
 * dependencies true exactly as `tickRow` does per row: ticking also ticks the rows each one is created under, unticking also unticks what is
 * created under each, whether or not those are shown. Rows outside `shown` are otherwise untouched. `alsoChanged` is how many rows OUTSIDE
 * `shown` moved with them, for the polite announcement.
 */
export function tickShown(index: ImportIndex, ticks: ReadonlySet<string>, shown: readonly JiraImportItem[], on: boolean): { ticks: Set<string>; alsoChanged: number } {
  const next = new Set(ticks);
  const direct = new Set<string>();
  for (const item of shown) {
    if (!isSelectable(item)) continue;
    direct.add(item.jiraId);
    for (const id of [item.jiraId, ...(on ? ancestors(index, item.jiraId) : descendants(index, item.jiraId))]) {
      if (on) next.add(id);
      else next.delete(id);
    }
  }
  const moved = [...next].filter((id) => !ticks.has(id)).concat([...ticks].filter((id) => !next.has(id)));
  return { ticks: next, alsoChanged: moved.filter((id) => !direct.has(id)).length };
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

/**
 * A change to a suggested match (1.15) waiting in the preview step until "Preview again": "link" confirms a CREATE row's suggestion, "create"
 * takes a confirmed link back. Nothing is sent before the next preview, so the preview stays the exact picture of what Import does.
 */
export type MatchChange = "link" | "create";

/** A CREATE row the server found a strict name match for among the unlinked plan items beside it (never present on a redacted row). */
export const hasSuggestion = (item: JiraImportItem): boolean => item.action === "CREATE" && item.suggestion != null;

/** A BIND row that exists because the user confirmed a suggestion (the preview before this one carried `matches`). */
export const isConfirmedMatch = (item: JiraImportItem): boolean => item.action === "BIND" && item.infos.includes("MATCH_CONFIRMED");

/** A row that offers a match choice: a suggestion to link, or a confirmed link to take back. */
export const isMatchRow = (item: JiraImportItem): boolean => hasSuggestion(item) || isConfirmedMatch(item);

/**
 * The `matches` of the next preview: the scope's confirmed ones, minus every row with a pending change, plus the suggestion of each row
 * whose pending change is "link". A row is named once (the server answers 400 otherwise); a "create" change simply drops its entry.
 */
export function nextMatches(scope: JiraImportScope, items: readonly JiraImportItem[], pending: ReadonlyMap<string, MatchChange>): JiraImportMatch[] {
  const kept = (scope.matches ?? []).filter((match) => !pending.has(match.jiraId));
  const added = items.flatMap((item) => (pending.get(item.jiraId) === "link" && item.suggestion != null ? [{ jiraId: item.jiraId, nodeId: item.suggestion.nodeId }] : []));
  return [...kept, ...added];
}

/**
 * What the preview step hands over when a match-driven "Preview again" replaces it (1.15): the rows it showed and the user's work on them (ticks,
 * team overrides, owner picks), so confirming a link does not throw that work away. Only rows still present with the SAME action keep their work
 * (`carriedTicks`, `carriedPicks`): a row whose action changed (the confirmed row itself, a child re-planned under the existing node) starts afresh.
 */
export type PreviewCarry = {
  items: readonly JiraImportItem[];
  ticks: ReadonlySet<string>;
  teams: ReadonlyMap<string, number>;
  owners: ReadonlyMap<string, PickedOption>;
};

const sameAction = (before: readonly JiraImportItem[]) => {
  const actions = new Map(before.map((item) => [item.jiraId, item.action] as const));
  return (item: JiraImportItem): boolean => actions.get(item.jiraId) === item.action;
};

/**
 * The ticks of the next preview: everything ticked (the opening state), except a row the user had unticked that is still there with the same
 * action. An unticked row also unticks what is created under it in the NEW plan (`tickRow`), so the dependencies stay true.
 */
export function carriedTicks(items: readonly JiraImportItem[], carry: PreviewCarry): Set<string> {
  const same = sameAction(carry.items);
  const index = indexItems(items);
  let ticks = allSelectable(items);
  for (const item of items) {
    if (isSelectable(item) && same(item) && !carry.ticks.has(item.jiraId)) ticks = tickRow(index, ticks, item.jiraId, false).ticks;
  }
  return ticks;
}

/** The per-row picks (team overrides, owner picks) of the next preview: those of rows still present with the same action. */
export function carriedPicks<T>(items: readonly JiraImportItem[], carry: PreviewCarry, picks: ReadonlyMap<string, T>): Map<string, T> {
  const same = sameAction(carry.items);
  return new Map(items.filter((item) => same(item) && picks.has(item.jiraId)).map((item) => [item.jiraId, picks.get(item.jiraId) as T] as const));
}

/** The scope with exactly these `matches`; the member is left out when the list is empty (the request of before 1.15). */
export function withMatches(scope: JiraImportScope, matches: readonly JiraImportMatch[]): JiraImportScope {
  const next: JiraImportScope = { ...scope };
  if (matches.length > 0) next.matches = [...matches];
  else delete next.matches;
  return next;
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

/**
 * `workStreamId` presets the stream (the Plan page's work-stream menu: the stream is the intent, so the scope step shows it read-only);
 * `owner` presets the owner (a rooted import opens at the linked node's own owner).
 */
export const emptyScope = (allKeys: readonly string[], workStreamId?: number, owner: PickedOption | null = null): ScopeForm => ({
  workStreamId: workStreamId === undefined ? null : String(workStreamId),
  owner,
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
 * What a rooted import (1.14) starts from: a LINKED program (or project) of the plan, whose Jira item the server reads the children of. The
 * name and the key are for the dialog's sentences; the connection is the one the link goes through, the stream the node's own, the owner the
 * node's own owner (an ACTIVE person: the server refuses to delete one who owns a node). `gone` = the deviations read already says the linked Jira
 * item is gone: the dialog says the link cannot be used up front and Preview stays disabled (no Jira round trip). Absent = not known to be gone.
 */
export type ImportRoot = {
  level: JiraImportRoot["level"];
  nodeId: number;
  name: string;
  issueKey: string;
  connectionId: number;
  workStreamId: number;
  owner: PickedOption;
  gone?: boolean;
};

/**
 * The request scope; null while the work stream, the owner or the keys are missing, or the days field holds a value the server would refuse. All keys
 * ticked = no `projectKeys` (the server's default: every key of the connection). `filter` is sent only when a control is on (both off = the request of
 * before the filter existed); an empty days field sends no `updatedWithinDays`. With a `root` the keys and the default program are never sent (the
 * server reads every key of the connection and never creates a program; the default project only makes sense under a root program) and `root`
 * carries `{level, nodeId}` only.
 */
export function toScope(form: ScopeForm, allKeys: readonly string[], root?: ImportRoot): JiraImportScope | null {
  if (form.workStreamId === null || form.owner === null || (root === undefined && form.keys.length === 0)) return null;
  const within = updatedWithinOf(form.updatedWithinDays);
  if (within === null) return null;
  const defaults = {
    ...(root !== undefined || form.programId === null ? {} : { programId: Number(form.programId) }),
    ...(form.projectId === null || root?.level === "PROJECT" ? {} : { projectId: Number(form.projectId) }),
    ...(form.team === null ? {} : { teamId: Number(form.team.value) }),
  };
  return {
    workStreamId: Number(form.workStreamId),
    ownerPersonId: Number(form.owner.value),
    ...(root === undefined && form.keys.length < allKeys.length ? { projectKeys: form.keys } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    copyDates: form.copyDates,
    ...(form.excludeDone || within.days !== null ? { filter: { excludeDone: form.excludeDone, ...(within.days === null ? {} : { updatedWithinDays: within.days }) } } : {}),
    ...(root === undefined ? {} : { root: { level: root.level, nodeId: root.nodeId } }),
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

/** Whether the apply would CREATE this row as a program or a project: the only rows with an owner a per-row override can set (a milestone has none). */
export const hasOwnerChoice = (item: JiraImportItem): boolean => item.action === "CREATE" && item.level !== "MILESTONE";

/**
 * The apply body: the preview's own scope plus the ticked rows, in preview order. A per-row override is sent only where it differs from what the row
 * shows: a team override on a milestone, an owner override (`ownerOverrides`: person ids) on a program or project CREATE and only when it names
 * someone other than the dialog's owner.
 */
export function toApplyRequest(
  scope: JiraImportScope,
  items: readonly JiraImportItem[],
  ticks: ReadonlySet<string>,
  teamOverrides: ReadonlyMap<string, number>,
  ownerOverrides: ReadonlyMap<string, number> = new Map(),
): JiraImportApplyRequest {
  return {
    ...scope,
    items: items
      .filter((item) => ticks.has(item.jiraId) && isSelectable(item))
      .map((item) => {
        const team = teamOverrides.get(item.jiraId);
        const owner = ownerOverrides.get(item.jiraId);
        const overrides = {
          ...(team !== undefined && team !== item.team?.id ? { teamId: team } : {}),
          ...(owner !== undefined && hasOwnerChoice(item) && owner !== scope.ownerPersonId ? { ownerPersonId: owner } : {}),
        };
        return {
          jiraId: item.jiraId,
          expected: expectedOf(item),
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        };
      }),
  };
}

/** The connections the Plan page offers the import: enabled, with a mapping that fits the site (otherwise the server answers 409 `jira-mapping-invalid`). */
type OfferedConnection = ImportConnection & { enabled: boolean; mappingOk: boolean };
const usableImportConnections = (connections: readonly OfferedConnection[]): ImportConnection[] => connections.filter((connection) => connection.enabled && connection.mappingOk);

/** A deviations-view connections read (`useJiraConnections`) or the links view's (`useJiraPlanLinks`) as the import modal's source: only the usable connections are offered. */
export const importSourceOf = (read: { connections: readonly OfferedConnection[] | null; failed: boolean; retry: () => void }): ImportSource => ({
  ...read,
  connections: read.connections === null ? null : usableImportConnections(read.connections),
});

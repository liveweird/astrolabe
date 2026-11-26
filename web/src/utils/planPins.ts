import type { TFunction } from "i18next";
import type { PlanView } from "../api/plan";
import { nodeKeys, programKey, projectKey, streamKey, type PlanTreeRow } from "./planTree";

// The pinned section's pure model: the nodes the user pinned (a work stream, a program or a project, by key) with what is under each, as rows the same
// `PlanTreeRow` draws. A pin is a root: it ignores the filters, the focus and Hide closed, and its subtree is folded by ITS OWN set (a node folded in the
// tree can be open in a pinned subtree). No React and no i18n here.

/** Where a row is drawn: the tree itself, or the pinned section above it (which reuses the same row). */
export type PlanScope = "tree" | "pinned";

/**
 * An accessible name as the scope says it: a pinned copy of a row repeats the names of its tree row, so every name in the pinned section is wrapped
 * ("Edit X (pinned)") and a locator, a screen reader user and a test can tell the two apart. The tree's names are as they always were.
 */
export const scopedLabel = (t: TFunction, scope: PlanScope, text: string): string => (scope === "pinned" ? t("plan.pin.nameOf", { name: text }) : text);

/** A row of the pinned section: a tree row, with the key of the pinned root whose subtree it belongs to. */
export type PinnedRow = PlanTreeRow & { root: string };

/** The key under which a pinned subtree stores the fold of one of its nodes: the same node may be folded in the tree and open here. */
export const pinnedFoldKey = (root: string, key: string) => `${root}>${key}`;

/** The key of the pinned root a composite fold key belongs to. */
export const rootOfFold = (composite: string): string => composite.split(">")[0];

/** The pinned roots the plan still holds, in the order they were pinned (a duplicate or a deleted node's key shows nothing). */
export function livePins(view: PlanView, pins: readonly string[]): string[] {
  const known = nodeKeys(view);
  return [...new Set(pins)].filter((key) => known.has(key));
}

/**
 * The rows of the pinned section, top to bottom: for each pinned root (in pin order) the root, and under an EXPANDED one its children, down to the
 * projects. `collapsed` holds composite keys (`root>key`); a node with no children never folds. Indents are relative to the root. A key the plan
 * does not hold (a deleted node) draws nothing and is not pruned here.
 */
export function pinnedRows(view: PlanView, pins: readonly string[], collapsed: ReadonlySet<string>): PinnedRow[] {
  const rows: PinnedRow[] = [];
  const open = (root: string, key: string, childCount: number) => childCount > 0 && !collapsed.has(pinnedFoldKey(root, key));
  for (const root of new Set(pins)) {
    for (const stream of view.workStreams) {
      if (streamKey(stream.id) === root) {
        const expanded = open(root, root, stream.programs.length);
        rows.push({ kind: "workStream", key: root, root, parentKey: null, depth: 0, indent: 0, locked: false, context: false, stream, childCount: stream.programs.length, expanded });
        if (expanded) for (const program of stream.programs) pushProgram(rows, root, stream, program, 1, streamKey(stream.id), open);
      }
      for (const program of stream.programs) {
        if (programKey(program.id) === root) pushProgram(rows, root, stream, program, 0, null, open);
        for (const project of program.projects) {
          if (projectKey(project.id) === root) rows.push({ kind: "project", key: root, root, parentKey: null, depth: 2, indent: 0, locked: false, context: false, stream, program, project });
        }
      }
    }
  }
  return rows;
}

function pushProgram(
  rows: PinnedRow[],
  root: string,
  stream: PlanView["workStreams"][number],
  program: PlanView["workStreams"][number]["programs"][number],
  indent: number,
  parentKey: string | null,
  open: (root: string, key: string, childCount: number) => boolean,
): void {
  const key = programKey(program.id);
  const expanded = open(root, key, program.projects.length);
  rows.push({ kind: "program", key, root, parentKey, depth: 1, indent, locked: false, context: false, stream, program, childCount: program.projects.length, expanded });
  if (!expanded) return;
  for (const project of program.projects) {
    rows.push({ kind: "project", key: projectKey(project.id), root, parentKey: key, depth: 2, indent: indent + 1, locked: false, context: false, stream, program, project });
  }
}

/** The pins after the user's change (`add` appended unless held, `remove` taken out), the keys of nodes the plan no longer holds dropped. */
export function withPins(view: PlanView, pins: readonly string[], change: { add?: string; remove?: string }): string[] {
  const next = pins.filter((key) => key !== change.remove);
  if (change.add !== undefined && !next.includes(change.add)) next.push(change.add);
  const known = nodeKeys(view);
  return next.filter((key) => known.has(key));
}

/** The pinned folds after the user's change: composite keys of a pin or a node the plan no longer holds are dropped with it. */
export function withPinnedFolds(view: PlanView, collapsed: ReadonlySet<string>, change: { toggle: string }): string[] {
  const next = new Set(collapsed);
  if (!next.delete(change.toggle)) next.add(change.toggle);
  const known = nodeKeys(view);
  return [...next].filter((composite) => {
    const [root, key] = composite.split(">");
    return known.has(root) && known.has(key);
  });
}


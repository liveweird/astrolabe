import type { TFunction } from "i18next";
import type { CapacityApplyItem, CapacityApplyRequest, CapacityApplyResponse, CapacityPreview, CapacityPreviewItem } from "../api/flow";
import { ApiError } from "../api/http";
import { saveErrorMessage } from "./saveError";

/** A preview row the import can write: a CREATE or an UPDATE with the dates and the figure the apply sends back as `expected`. */
type Importable = CapacityPreviewItem & { action: "CREATE" | "UPDATE"; effectiveFrom: string; mdPerWeek: number };

/**
 * Whether the row has a tick at all. Only a CREATE or an UPDATE does: UNCHANGED has nothing to write, a MANUAL_PERIOD is the person's own
 * figure (never changed by any request) and a SKIP has no figure. A zero-capacity or a closed sprint is tickable but starts unticked (the server's `ticked`).
 */
export function isImportable(item: CapacityPreviewItem): item is Importable {
  return (item.action === "CREATE" || item.action === "UPDATE") && item.effectiveFrom !== null && item.mdPerWeek !== null;
}

/** The ticks the server suggests: its `ticked` rows, and only those that can be written. Removals are NEVER preselected. */
export function defaultTicks(preview: CapacityPreview): Set<number> {
  return new Set(preview.items.filter((item) => item.ticked && isImportable(item)).map((item) => item.sprintId));
}

/**
 * The apply body, built from the preview and nothing else: exactly the ticked rows with the `action`/`effectiveFrom`/`mdPerWeek` the preview
 * showed for them, the ticked removal ids, and the `from` / `includeClosed` the preview echoed (the server re-runs the same plan with them).
 */
export function applyRequest(preview: CapacityPreview, ticked: ReadonlySet<number>, removals: ReadonlySet<number>): CapacityApplyRequest {
  const items: CapacityApplyItem[] = preview.items
    .filter((item): item is Importable => ticked.has(item.sprintId) && isImportable(item))
    .map((item) => ({ sprintId: item.sprintId, expected: { action: item.action, effectiveFrom: item.effectiveFrom, mdPerWeek: item.mdPerWeek } }));
  return {
    from: preview.from,
    includeClosed: preview.includeClosed,
    items,
    removals: preview.removals.filter((removal) => removals.has(removal.periodId)).map((removal) => removal.periodId),
  };
}

/** A sprint that ended before the import's `from` date (listed only with "Include closed sprints"; never ticked by default). */
export function isClosed(item: CapacityPreviewItem, from: string): boolean {
  return item.end !== null && item.end < from;
}

/**
 * What an apply came to, in words: "3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime". Only the parts that are not zero
 * (the forms are neutral - "utworzono: 3" - so they are grammatical in Polish for every count); nothing at all reads "Nothing was imported".
 */
export function outcomeSentence(result: CapacityApplyResponse, t: TFunction): string {
  const parts = [
    result.created.length > 0 ? t("flow.import.outcome.created", { n: result.created.length }) : null,
    result.updated.length > 0 ? t("flow.import.outcome.updated", { n: result.updated.length }) : null,
    result.deleted.length > 0 ? t("flow.import.outcome.removed", { n: result.deleted.length }) : null,
    result.skipped.length > 0 ? t("flow.import.outcome.skipped", { n: result.skipped.length }) : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? t("flow.import.outcome.nothing") : parts.join(" · ");
}

/** A refused preview or apply: the fixed lead for the status and, for a 400, the server's own sentence under it. */
export function importFailure(err: unknown, t: TFunction): { message: string; detail?: string } {
  const message = saveErrorMessage(err, t, {
    forbidden: "flow.import.forbidden",
    notFound: "flow.import.gone",
    invalid: "flow.import.invalid",
    failedStatus: "common.error.actionFailedStatus",
    failed: "common.error.actionFailed",
  });
  return err instanceof ApiError && err.status === 400 && err.detail ? { message, detail: err.detail } : { message };
}

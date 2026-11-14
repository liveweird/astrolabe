import { useCallback, useMemo, useState } from "react";
import type { JiraImportItem, JiraImportMatch, JiraImportScope } from "../api/jira";
import { hasSuggestion, isMatchRow, type MatchChange, nextMatches, type PreviewCarry } from "../utils/jiraImport";

/** A row's pending match change put into (or, for null, taken out of) the map. */
function withChange(previous: ReadonlyMap<string, MatchChange>, id: string, change: MatchChange | null): ReadonlyMap<string, MatchChange> {
  const next = new Map(previous);
  if (change === null) next.delete(id);
  else next.set(id, change);
  return next;
}

/**
 * The preview step's suggested-match state (1.15). A click on "Link instead" / "Create instead" only records a pending change here; nothing is
 * sent until "Preview again", which carries the scope's confirmed matches with the changes applied (`nextMatches`) and the user's work on the rows
 * (`PreviewCarry`). While changes wait, Import stays disabled (the preview is not the picture of what Import would do). "Possible matches only"
 * narrows the shown rows to those offering a choice. The step is keyed by the preview counter of `useJiraImport`, so a new preview starts with
 * no pending change and the switch off.
 */
export function useImportMatches(
  scope: JiraImportScope,
  items: readonly JiraImportItem[],
  onPreviewAgain: (matches?: readonly JiraImportMatch[], carry?: PreviewCarry) => void,
) {
  const [pending, setPending] = useState<ReadonlyMap<string, MatchChange>>(new Map());
  const [onlyMatches, setOnlyMatches] = useState(false);
  const suggestions = useMemo(() => items.filter(hasSuggestion).length, [items]);
  const hasChoices = useMemo(() => items.some(isMatchRow), [items]);
  const waiting = pending.size > 0;
  const narrow = useCallback((rows: readonly JiraImportItem[]) => (onlyMatches ? rows.filter(isMatchRow) : rows), [onlyMatches]);
  const setChange = useCallback((id: string, change: MatchChange | null) => setPending((previous) => withChange(previous, id, change)), []);
  const previewAgain = useCallback(
    (carry: PreviewCarry) => (pending.size > 0 ? onPreviewAgain(nextMatches(scope, items, pending), carry) : onPreviewAgain()),
    [scope, items, pending, onPreviewAgain],
  );
  return { pending, waiting, onlyMatches, setOnlyMatches, suggestions, hasChoices, setChange, narrow, previewAgain };
}

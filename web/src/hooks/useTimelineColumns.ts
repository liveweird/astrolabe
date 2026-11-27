import {
  DEFAULT_COLUMN_PREFS,
  hiddenColumnIds,
  isColumnPrefs,
  pickedColumns,
  toggledAll,
  type TimelineColumnsPage,
  type TimelineColumnView,
} from "../utils/timelineColumns";
import type { TimelineColumn } from "../utils/timelineModel";
import { useStoredState } from "./useStoredState";

/**
 * Which of a Gantt's extra left columns the viewer has hidden (1.34, `timeline.md` "Hidden columns"): ONE browser-remembered choice per page type,
 * through `localStorage` and `useStoredState` (best-effort: without storage the choice lives for the page only). The page marks its extras
 * `hideable` in `columns`, passes `hidden` to the Timeline as `hiddenColumns` and hands the view to `TimelineColumnsControl`. A first visit shows every
 * column and writes nothing; a stored value that is not a choice is ignored.
 */
export function useTimelineColumns(page: TimelineColumnsPage, columns: readonly TimelineColumn[]): TimelineColumnView {
  const [prefs, setPrefs] = useStoredState(`timeline.columns.${page}`, DEFAULT_COLUMN_PREFS, isColumnPrefs);
  // Never the row header (column 0: `focusRow`'s `r,0`) nor the last column (Operations), whatever a page marks.
  const offered = columns.filter((column, index) => column.hideable === true && index > 0 && index < columns.length - 1);
  const hidden = hiddenColumnIds(prefs, offered);
  return {
    hidden,
    offered,
    allHidden: offered.length > 0 && hidden.size === offered.length,
    toggleAll: () => setPrefs(toggledAll(prefs, offered)),
    setShown: (ids) => setPrefs(pickedColumns(prefs, offered, ids)),
  };
}

import { useRef, useState } from "react";
import {
  DEFAULT_COLUMN_PREFS,
  changedPick,
  hiddenColumnIds,
  isColumnPrefs,
  samePrefs,
  toggledAll,
  type ColumnPrefs,
  type TimelineColumnsPage,
  type TimelineColumnView,
} from "../utils/timelineColumns";
import type { TimelineColumn } from "../utils/timelineModel";
import { fitColumns, NARROW_BELOW } from "../utils/timelineNarrow";
import { useElementWidth } from "./useElementWidth";
import { useStoredState } from "./useStoredState";

/**
 * Which of a Gantt's extra left columns are drawn (1.34, `timeline.md` "Hidden columns"). The viewer's choice is ONE browser-remembered value per page
 * type, through `localStorage` and `useStoredState` (best-effort: without storage it lives for the page only); a first visit shows every column and
 * writes nothing; a stored value that is not a choice is ignored. On a narrow scroller (`fitColumns`) the columns the pane has no room for are left out
 * on top of that, for this session only and without touching the choice; the columns the viewer asks for meanwhile (a tick, "Show columns") are kept and
 * the pane gives way. `hidden` and `columns` are the FITTED view, which the control describes, and `scrollRef` goes to the Timeline. The page marks its
 * extras `hideable` in `columns` and hands the view to `Timeline` and `TimelineColumnsControl`. Storage is written only by a viewer action that changes the choice.
 */
export function useTimelineColumns(page: TimelineColumnsPage, columns: readonly TimelineColumn[]): TimelineColumnView {
  const [prefs, setPrefs] = useStoredState(`timeline.columns.${page}`, DEFAULT_COLUMN_PREFS, isColumnPrefs);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef, NARROW_BELOW);
  // The columns the viewer asked for since the page opened (session only): the fit drops them last.
  const [asked, setAsked] = useState<readonly string[]>([]);
  // Never the row header (column 0: `focusRow`'s `r,0`) nor the last column (Operations), whatever a page marks.
  const offered = columns.filter((column, index) => column.hideable === true && index > 0 && index < columns.length - 1);
  const picked = hiddenColumnIds(prefs, offered);
  const fitted = fitColumns(columns, picked, width, new Set(asked));
  const drawn = offered.filter((column) => !fitted.hidden.has(column.id)).map((column) => column.id);
  const save = (next: ColumnPrefs) => {
    if (!samePrefs(next, prefs)) setPrefs(next);
  };
  return {
    columns: fitted.columns,
    hidden: fitted.hidden,
    scrollRef,
    offered,
    allHidden: offered.length > 0 && fitted.hidden.size === offered.length,
    toggleAll: () => {
      if (drawn.length > 0) {
        save({ collapsed: true, hidden: prefs.hidden });
        setAsked([]);
        return;
      }
      // Nothing is drawn: whether the viewer's pick or the fit did it, the columns come back and are asked for.
      const next = picked.size === offered.length ? toggledAll(prefs, offered) : prefs;
      save(next);
      const hiddenNow = hiddenColumnIds(next, offered);
      setAsked(offered.filter((column) => !hiddenNow.has(column.id)).map((column) => column.id));
    },
    setShown: (ids) => {
      // A column drawn only because it was asked for (the fit alone would have left it out) is not in the stored pick: unticking it just forgets the ask.
      const fitAlone = fitColumns(columns, picked, width).hidden;
      const askedOnly = drawn.filter((id) => !ids.includes(id) && fitAlone.has(id));
      save(changedPick(prefs, offered, drawn, [...ids, ...askedOnly]));
      setAsked((before) => [...before, ...ids.filter((id) => !drawn.includes(id))].filter((id) => ids.includes(id)));
    },
  };
}

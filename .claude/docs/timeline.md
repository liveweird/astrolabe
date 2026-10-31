### The shared Timeline component (v0.3.0 — binding reference)

One component serves every Gantt-like page: the project view (v0.3, milestones of one project), the team view (v0.5, milestones against capacity), the roadmap and the programs view (v0.6). Pages differ in their rows and bar sources,
not in the mechanics. **The component draws and proposes; it never writes and never decides** — the page adapts its view document to rows (`TimelineRowData[]`), reads the `can:{…}` flags for `editable`, and answers a proposed change with its own write path
(optimistic update, the server's verdict, rollback — `hooks/useRoadmapRanking.ts` is the template). The server alone decides who may schedule (`PUT /milestones/{id}/schedule`, team manager or ADMIN).

Files (all flat under `web/src/`): `utils/timelineScale.ts` (pure coordinate model, header, hatch, default range), `utils/timelineDrag.ts` (pure drag arithmetic, dnd-kit keyboard getter and modifiers), `utils/timelineModel.ts` (the data contract
types and layout constants), `hooks/useTimelinePreview.ts` (drag data + preview context), `components/Timeline.tsx` (the frame), `TimelineHeader.tsx`, `TimelineRow.tsx` (+ `TimelineBand`), `TimelineBar.tsx`, `TimelineDndContext.tsx`,
`TimelineToolbar.tsx`, `TimelineUnscheduledTray.tsx`; `theme.module.css` holds the `timeline*` classes; strings in `locales/{en,pl}/timeline.json`.

#### Coordinate model

Dates cross the component boundary as ISO `YYYY-MM-DD` strings; inside they are **epoch days** (whole days since 1970-01-01, UTC; `toEpochDay`/`toIsoDate`). A range is `[from, to]` inclusive. A day is `dayWidth` pixels; a bar spans from the LEFT edge
of its first day to the RIGHT edge of its last: `left = xOf(start)`, `width = (end − start + 1) × dayWidth`. A scale is made by `makeScale(zoom, range)` and carries `xOf(day)`, `widthOf(start, end)`, `dayAt(x)` (floor) and `totalWidth`. Monday = 0 is
`(epochDay + 3) % 7` (`weekdayOf`); the weekend is Saturday–Sunday (holidays arrive with v0.7 and will join the same predicate).

| Zoom | px / day | Header groups | Header cells | Weekend hatch | Default range padding (snapped outward) | Empty default |
|---|---|---|---|---|---|---|
| `week` | 28 | ISO weeks (`W38 2026`) | days (`16`; weekend cells tinted) | yes | ±2 weeks → whole Monday–Sunday weeks | today ±6 weeks |
| `month` | 8 | months (`2026-09`) | ISO weeks (`W38`) | yes | ±1 month → whole months | today ±3 months |
| `quarter` | 3 | quarters (`2026-Q3`) | months (`2026-09`) | no (3 px/day is noise) | ±1 quarter → whole quarters | today ±2 quarters |

Labels are language-neutral (`formatDate.ts` rule). Groups and cells each PARTITION the range and are clipped to it (a week or month crossing the range edge is a shorter cell, never dropped); a cell may straddle two groups (a week across a month boundary).
`defaultRange(dates, today, zoom)` is the range a page opens with: min/max of the dates ∪ today, padded and snapped as above. **The page owns the range and keeps it stable across edits** (compute it from the first load, only ever grow it):
a range recomputed from every drag would shift every bar under the pointer. `scrollLeftToCenter` backs the toolbar's Today.

#### Data contract (`utils/timelineModel.ts`)

- `TimelineColumn{id, header, width}` — the sticky left columns (the first is the row header: the name). `leftWidth` = their sum.
- `TimelineRowData{id, cells, bars, bands?, track?}` — `cells[i]` belongs to `columns[i]`: static content (the cell itself is the roving stop) or a **function `(stop) => node`** that spreads `stop` (`data-grid-pos`, `tabIndex`) on its own focusable (a link, the row
  menu button) so one cell never holds two tab stops. `bars` are the row's bars (usually one). `bands` are confined to this row's track. `track` REPLACES the bar rendering of the row's track (the v0.5 load strip positions its own cells with the exported
  scale); the row's hatch and bands still draw. A track-only row (no `bars`) exposes no roving columns beyond its left cells, so focusable content inside a `track` (the v0.5 strip) brings its own focus handling.
- `TimelineBarData{id, start, end, label, describe, editable}` — `describe` is the bar's accessible name (the page builds it: "{name}, {team}, {start} to {end}, {estimate} man-days"); the component appends ", read-only" (`timeline.bar.readOnly`) when
  `editable` is false. `label` is the short name used by the handles and announcements. Bar ids are unique across the timeline.
- `TimelineBandData{id, start, end, label, tone: "window" | "drift"}` — decorative (`aria-hidden`, `title` = label); the facts live in the page's text. Passed as the `bands` prop it spans every row (the project's target window); in a row it spans that row.
  `window` is a quiet gray tint with dashed edges, `drift` is orange (red is never used: nothing blocks in v0.3).
- `Timeline` props: `label`, `scale`, `onZoomChange`, `today` (ISO, injected), `columns`, `rows`, `bands?`, `overlay?`, `virtualizeFrom?` (80), `maxHeight?` (640), `busy?` (`aria-busy` on the grid while a save is in flight).

#### Overlay geometry (v0.4 dependency arrows)

`overlay?: (g: TimelineGeometry) => ReactNode` renders its result inside ONE absolutely positioned `<svg aria-hidden>` over the body (`pointer-events: none`, origin = left of the range / top of the first row). `TimelineGeometry` is computed from DATA, never measured:
`scale`, `xOf(iso)`, `rowTop(i) = i × 36`, `rowHeight = 36`, `barRect(rowIndex, barId) → {x, y, width, height} | null` (`y = rowTop + 6`, `height = 24`; the committed dates, not a drag preview) and `visibleRows{first, last}` (the mounted
window; draw arrows only for these). Arrows therefore work identically on the plain and the virtual path.

#### Drag, resize and keyboard contract

ONE `TimelineDndContext` per page wraps the `Timeline` and the `TimelineUnscheduledTray` (`scale`, `onSchedule(barId, start, end)`). Sensors: `PointerSensor` (activation distance 5 px) and `KeyboardSensor` with `keyboardCoordinates(dayWidth)` (`scrollBehavior: "auto"`).
Collision is `pointerWithin`. Every draggable carries `DragData{kind, barId, label, start?, end?}`; `kind` is `move | resize-start | resize-end | tray` and the pure `dropOutcome(kind, bar, deltaDays, dayAtPointer)` turns it into dates:

- `move`: both ends + Δ days. `resize-start`: start + Δ, clamped to ≤ end. `resize-end`: end + Δ, clamped to ≥ start (a one-day bar is the minimum). `tray`: start = the day under the pointer, end = start + 6 (one calendar week; the page's Schedule
  button uses the same `dropOutcome("tray", …)` with its own day). Δ = `round(delta.x / dayWidth)`; bar gestures are held to one row and whole days by the modifiers `horizontalOnly` and `snapToDays(dayWidth)` (a tray item is left free).
- The tray's day is `dayAt(clientX + delta.x − over.rect.left)` while the pointer is over the track drop zone (`TIMELINE_DROP_ID`, an invisible element exactly as wide as the range and as tall as every row) AND inside the part of it the scroller shows: the zone's droppable `data.visibleBounds()` is the scroller's live rectangle minus the sticky columns (left) and the sticky header (top), so a release over the tray, the footer or the left columns schedules nothing; outside it, or from the keyboard, nothing is proposed. The pointer is estimated as the activator position plus the scroll-adjusted `delta` (off by the scroll since the drag began only if the grid autoscrolls under a held item; the server still decides). One timeline per page: `TIMELINE_DROP_ID` and the DndContext id are fixed.
- Bar anatomy: a `div` wrapper positioned by the scale holding three SIBLING draggables (no button inside a button): the body (translated in place while moved) and the two edge handles, which sit OUTSIDE the bar (`left/right: −w`) with a CONSTANT width per zoom (6 px at week/month, 4 px at quarter) — a width derived from the live bar would change mid-resize and make dnd-kit re-measure the node it is dragging, and outside handles leave even a 1-day bar at quarter zoom (3 px) its whole body as the move target (a pointer hit on 3 px is still precise work: the keyboard path is the reliable one there). While an EDGE is held, the bar redraws from the context's
  preview dates (`useTimelinePreview`); a move keeps its geometry and translates. Read-only bars are a labelled `role="img"`, no handles.
- `onDragEnd` proposes through `onSchedule` only when the outcome differs from the bar's current dates; a cancel, a no-op or a tray drop outside the track proposes nothing. `onSchedule` is a proposal — the page may ignore it (a save in flight).
- **Keyboard:** Space or Enter on a focused bar or handle picks it up; ←/→ one day, Shift+←/→ seven; Space/Enter drops (`onSchedule`); Escape cancels; ↑/↓ do nothing while held. A resize cannot cross the opposite edge: the getter clamps the displacement from the held bar's dates and steps from the clamped value, so ← after an overshoot is never silent. Read-only bars are not touch drag targets (the page still scrolls under a finger). While a bar is held the grid's own arrow handling is suspended (`useDndContext().active`).
- **Announcements** are dnd-kit's own live region, localized (`timeline.announce.*`, EN/PL): pick-up (kind-specific, with the dates and the keys), every step (`name: start to end`, said once per distinct span), the drop, cancel; for a tray item: pick-up, scheduled/not scheduled, cancel. The
  `screenReaderInstructions` (`timeline.dnd.instructions`) are the `aria-describedby` text of every draggable. A page announces its own non-drag changes (the Schedule button, the schedule dialog, the save verdict) in its polite live region.
- **The deterministic path** (the Roadmap rule: a dnd-kit surface always ships explicit controls): the page provides "Edit schedule…" (a dialog with two date inputs and Unschedule) and the tray's Schedule button. The tray's drag handle is pointer-only (`aria-hidden`, no keyboard
  sensor attached); the Schedule button is its keyboard and screen-reader path. The tray is deliberately not in a scroll region: a dragged row translates out of the table over the timeline and a scroller would clip it.

#### Accessibility model

A `div role="grid"` (labelled, `aria-rowcount`, per-row `aria-rowindex`; the header's cell row is row 1, body row `i` is `i + 1`) with `role="row"` rows of `rowheader`/`gridcell`s, inside the labelled, focusable `ScrollRegion` (`scrollRef` is its one extension). Not a listbox: a listbox
option may not contain interactive children (bars, handles, menus). Not a `<table>`: virtual rows are absolutely positioned, which a table row cannot be. The header's group row and date cells are decoration (`aria-hidden`); the bars' dates live in their accessible names.

**One roving tab stop** (`hooks/useRovingGrid.ts`, now generic over the grid element): ↑/↓ rows, ←/→ cells, Home/End row ends, Ctrl+Home/End grid ends. Columns of a row: the left cells `0…L−1`, then per bar `L + 3b` = the bar, `+1` its start handle, `+2` its end handle (editable only).
Rows have different widths, so a VERTICAL move lands on the target row's nearest lower column when the exact one is absent (a read-only row has no handle cells) and Ctrl+End goes to the last cell that exists on the last row. `isValid` treats an unmounted row or an absent column as invalid, so the
tab stop falls back to the first mounted row. Cells carry `scroll-margin` (header height, sticky columns) so a focused cell scrolls clear of the sticky parts.

#### Virtualisation

Rows are virtualised with `@tanstack/react-virtual` (`useVirtualizer`; fixed 36 px rows, `overscan` 8, the `ScrollRegion` as the scroller, `scrollMargin` = the 56 px header) **only when `rows.length > virtualizeFrom`** (default 80). Both paths mount the same `TimelineRow`; the virtual one gives
each row `position: absolute; top: index × 36` inside a body of `rows × 36` px (`top`, not `transform`: a transform makes a stacking context per row and the sticky left cells could not rise above the today line and overlay). The project view (10–50 rows) never virtualises; the v0.5 team view
and v0.6 roadmap (~1,000) do. **↑/↓ and Ctrl+Home/End at an unmounted row** are taken by the Timeline: it `scrollToIndex`es, remembers the wanted cell and focuses it (or the nearest cell to its left) in a layout effect as soon as the row mounts; that wish is dropped by any other key, a focus elsewhere, or a scroll by hand (wheel, touch, pointer, a key on the scroller), so it cannot steal focus later. `scrollToIndex` lands the row below the sticky header (`scrollPaddingStart`). Horizontal (time-axis) virtualisation
is NOT built: a range is bounded by the project's span plus padding, the hatch is one periodic CSS background per row and the today line one element, so the only per-day DOM is the header's day cells (`BACKLOG.md`: multi-year ranges for the v0.6 roadmap).

#### Hatching and styling

The weekend hatch is ONE `repeating-linear-gradient(90deg, …)` per row track (`weekendBackground(scale)`): period `7 × dayWidth`, transparent Monday–Friday, the `--timeline-hatch` ink on Saturday–Sunday, phased to the Monday on or before the range start (a repeating gradient repeats both ways, so the phase may be
negative). Drawn at week and month zoom, not at quarter. Bars are data, so they are neutral gray (`--timeline-bar`); the brand cyan appears only on the focus ring and on the bar being dragged. The today line is the text colour (2 px, 55 % opacity) with a "Today" tag in the header. All styling
is `light-dark()` in `theme.module.css` (`timelineGrid` defines the tokens). Stacking, bottom to top: bands and today line (no z-index; painted first) < row tracks and bars (the line shows through the tracks' transparent parts and passes UNDER the bars) < the overlay (z 2) < the sticky left cells (z 3) < the sticky header (z 4).

#### Print and export

Deferred: nothing timeline-specific; `hooks/usePrintLifecycle.ts` and `print.css` apply as they do to any page (a `BACKLOG.md` line at release).

#### Tests

`utils/timelineScale.test.ts`, `utils/timelineDrag.test.ts` (pure, table-driven); `hooks/useRovingGrid.test.tsx` (vertical fallback, ragged rows); `components/Timeline.test.tsx` (bars at their computed `left`/`width`, read-only rows, bands, the overlay geometry, the `track` slot, roving navigation,
every drop outcome through the wrapped `DndContext` — happy-dom has no layout, so the handlers are fed events —, the announcements, the keyboard sensor end to end, the virtual window with `virtualizeFrom = 5` and a stubbed viewport (`clientHeight`), scroll-then-focus, the tray). The real pointer drag and
the resize handles under a real layout are `e2e/tests/project-view.spec.ts` (C4) — those scenarios own them.

#### Measured figures at scale

(Filled in with the project view's commit: rows mounted, DOM nodes and scroll scripting time for 1,000 rows — a manual measurement recorded here.)

#### Deliberate departures from the bootstrap sketch

A div grid instead of a `<table>` (virtual rows); `top` instead of `translateY` for virtual rows (stacking); the tray's drag is pointer-only with an explicit Schedule button; dnd-kit's live region is the single announcer for drags (the page's polite region announces only non-drag changes).

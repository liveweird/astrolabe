### The shared Timeline component (v0.3.0 — binding reference)

One component serves every Gantt-like page: the project view (v0.3, milestones of one project), the team view (v0.5, milestones against capacity), the roadmap and the programs view (v0.6). Pages differ in their rows and bar sources,
not in the mechanics. **The component draws and proposes; it never writes and never decides** — the page adapts its view document to rows (`TimelineRowData[]`), reads the `can:{…}` flags for `editable`, and answers a proposed change with its own write path
(optimistic update, the server's verdict, rollback — `hooks/useRoadmapRanking.ts` is the template). The server alone decides who may schedule (`PUT /milestones/{id}/schedule`, team manager or ADMIN).

Files (all flat under `web/src/`): `utils/timelineScale.ts` (pure coordinate model, header, hatch, default range), `utils/timelineDrag.ts` (pure drag arithmetic, dnd-kit keyboard getter and modifiers), `utils/timelineModel.ts` (the data contract
types and layout constants), `hooks/useTimelinePreview.ts` (drag data + preview context), `components/Timeline.tsx` (the frame), `TimelineHeader.tsx`, `TimelineRow.tsx` (+ `TimelineBand`), `TimelineBar.tsx`, `TimelineDndContext.tsx`,
`TimelineToolbar.tsx`, `TimelineUnscheduledTray.tsx`; v0.4 adds `utils/timelineArrows.ts` and `components/TimelineArrows.tsx` (see "Arrows"); `theme.module.css` holds the `timeline*` classes; strings in `locales/{en,pl}/timeline.json`.

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
- `TimelineBarData{id, start, end, label, describe, editable, tone?}` — `describe` is the bar's accessible name (the page builds it: "{name}, {team}, {start} to {end}, {estimate} man-days"); the component appends ", read-only" (`timeline.bar.readOnly`) when
  `editable` is false. `label` is the short name used by the handles and announcements. Bar ids are unique across the timeline. `tone?: "ghost" | "summary"` (v0.4) styles a READ-ONLY bar (an editable bar ignores it; see "Arrows").
- `TimelineBandData{id, start, end, label, tone: "window" | "drift"}` — decorative (`aria-hidden`, `title` = label); the facts live in the page's text. Passed as the `bands` prop it spans every row (the project's target window); in a row it spans that row.
  `window` is a quiet gray tint with dashed edges, `drift` is orange (red is never used: nothing blocks in v0.3).
- `Timeline` props: `label`, `scale`, `onZoomChange`, `today` (ISO, injected), `columns`, `rows`, `bands?`, `overlay?`, `virtualizeFrom?` (80), `maxHeight?` (640), `busy?` (`aria-busy` on the grid while a save is in flight).

#### Overlay geometry

`overlay?: (g: TimelineGeometry) => ReactNode` renders its result inside ONE absolutely positioned `<svg aria-hidden>` over the body (`pointer-events: none`, origin = left of the range / top of the first row). `TimelineGeometry` is computed from DATA, never measured:
`scale`, `xOf(iso)`, `rowTop(i) = i × 36`, `rowHeight = 36`, `rowIndexOf(rowId) → index | null` (the row with that `TimelineRowData.id`; the id map is built on first call), `barRect(rowIndex, barId) → {x, y, width, height} | null` (`y = rowTop + 6`, `height = 24`; the committed dates, not a drag preview) and `visibleRows{first, last}` (the mounted
window; draw arrows only for these). Arrows therefore work identically on the plain and the virtual path.

#### Arrows (built, v0.4 — the component level; the project view wires them in the same release)

Files: `utils/timelineArrows.ts` (pure routing + resolution), `components/TimelineArrows.tsx` (the renderer), `TimelineArrowData` in `utils/timelineModel.ts` (the input). A page passes `overlay={(g) => <TimelineArrows arrows={specs} geometry={g} />}`; the component draws, it decides nothing.

**The input contract** — `TimelineArrowData{id, from, to, violated, label}`, `from` the predecessor and `to` the successor, each end `{row, bar, kind}`: `row` = the `TimelineRowData.id` of the row, `bar` = the `TimelineBarData.id` inside it, `kind` = `START` (the bar's left edge) or `END` (its right edge).
Dependency types map as FS = END→START, SS = START→START, FF = END→END, SF = START→END. `violated` draws the arrow red; `label` ("A → B, FS") is the path's `<title>` only. `id` is unique among the arrows. A page maps its view onto this; the component never learns what a dependency is.

**The route** (`arrowRoute`, all legs horizontal or vertical): the arrow leaves its anchor (the middle of the bar's edge) outward, runs vertically to the successor's row and enters the successor's anchor moving INTO the bar. Stubs are 8 px.
- Edges facing the same way (SS, FF) on different rows: one vertical leg just outside the further of the two 8 px stubs; never a backtrack.
- Opposite ways (FS, SF) and the successor's anchor is AHEAD of the predecessor's in the leaving direction (FS: `to.x >= from.x`; SF: `to.x <= from.x`): one vertical leg at `min(8 px, gap / 2)` from the predecessor's edge, then straight in. A narrow gap shrinks the stub instead of reading as a backtrack: back-to-back bars (gap 0) run straight down the shared edge,
  Friday to Monday at quarter zoom (9 px) turns at 4.5 px.
- The BACKTRACK is used only when the successor's anchor is BEHIND the predecessor's in the leaving direction (FS with the successor starting before the predecessor ends — a violation or a lead; SF whenever the successor ends right of the predecessor's start, its usual case) and for SS/FF on the SAME row (their straight leg would run through the bars' centre line;
  not a planned shape, but guarded): the vertical leg runs along the ROW BOUNDARY next to the successor's row (`rowTop(toRow)` when the predecessor's row is above, `rowTop(toRow) + rowHeight` when it is below or the same), a second horizontal leg goes to the approach point (anchor ± 8 px) and a short vertical leg drops onto the row — so the arrow never crosses a bar it connects.
- The overlay svg spans exactly the track, so a stub left of the range start (x < 0) is clipped. That strip is the sticky left columns' (opaque, z-index 3 over the overlay's 2), which would cover it anyway; the page's range is padded outward from its data, so a bar does not touch the range ends in practice.

**Which arrows are drawn** (`arrowsToDraw`): an arrow whose row or bar is unknown to the geometry is skipped; so is an arrow with NEITHER end in `visibleRows` (the mounted window — on the plain path every row, on the virtual path the window with its overscan). An arrow with one mounted end is drawn whole: the other end is positioned from data. An arrow whose both ends lie outside the window but whose
line would cross it is NOT drawn (accepted: the project view never virtualises). **Committed dates only**: the geometry is built from `rows`, so a drag or resize preview does not drag an arrow; the optimistic update moves it at the drop.

**Output** — one `<path data-arrow={id} data-violated={true|false}>` per arrow with a `<title>` and a `marker-end` arrowhead; two `<marker>`s with the FIXED ids `timeline-arrowhead` / `timeline-arrowhead-violated` (one timeline per page). Tests and e2e count `data-arrow` and read `data-violated`; colour is never asserted. **Decorative**: the svg is `aria-hidden`, the accessible surface is the page's dependency table.
Colour: tokens on `timelineGrid` — `--timeline-arrow` (the SOLID dimmed text colour, gray; the path carries `opacity: 0.7` so its line and arrowhead fade as one group instead of compounding an alpha colour where they meet; the head's tip sits on the anchor, `refX = 10`) and `--timeline-violation` (`light-dark(red-8, red-5)`: red = a violated constraint), 1.5 px strokes.

**Bar tones** (`TimelineBarData.tone`, read-only bars only; rendered as a class and a `data-tone` attribute): `ghost` = an endpoint that lives on another project — the bar colour at 35 % with a dashed outline; `summary` = the project's own derived span — hollow, a 2 px outline. A tone changes no accessible name: the page's `describe` carries the words
(`timeline.bar.ghost` "{label}, from project {project}" and `timeline.bar.summary` "{name}, the project's span {start} to {end}" are the strings it uses; they exist from C4 on but are consumed from C5, when the project view builds the ghost and summary rows).

**Cost.** Resolving the arrows is O(arrows) per render. One-off, NON-BINDING measurement (not a budget; re-measure rather than quote it) with the C4 component, 50 rows and 200 arrows (all drawn), one run on an Apple-silicon laptop (arm64, Node 26, vitest + happy-dom): `arrowsToDraw` median 0.24 ms (p95 0.33 ms) over 200 repetitions; mounting the whole Timeline in happy-dom (DOM construction only: NO layout, NO paint)
15.8 ms median without arrows, 21.3 ms with the 200 arrows (+5 ms; three runs: 20.8–21.3). That is not a browser figure; the real-browser render/paint figure needs the project view and is measured with C5. The 1,000-row v0.5/v0.6 pages re-run the filter on every scroll frame (a few thousand comparisons); a per-row index is the remedy when that is not enough.

#### Drag, resize and keyboard contract

ONE `TimelineDndContext` per page wraps the `Timeline` and the `TimelineUnscheduledTray` (`scale`, `onSchedule(barId, start, end) → boolean`). Sensors: `PointerSensor` (activation distance 5 px) and `KeyboardSensor` with `keyboardCoordinates(dayWidth)` (`scrollBehavior: "auto"`).
Collision is `pointerWithin`. Every draggable carries `DragData{kind, barId, label, start?, end?}`; `kind` is `move | resize-start | resize-end | tray` and the pure `dropOutcome(kind, bar, deltaDays, dayAtPointer)` turns it into dates:

- `move`: both ends + Δ days. `resize-start`: start + Δ, clamped to ≤ end. `resize-end`: end + Δ, clamped to ≥ start (a one-day bar is the minimum). `tray`: start = the day under the pointer, end = start + 6 (one calendar week; the page's Schedule
  button uses the same `dropOutcome("tray", …)` with its own day). Δ = `round(delta.x / dayWidth)`; bar gestures are held to one row and whole days by the modifiers `horizontalOnly` and `snapToDays(dayWidth)` (a tray item is left free).
- The tray's day is `dayAt(pointer.x − zoneLeft)` while `over` is the track drop zone (`TIMELINE_DROP_ID`, an invisible element exactly as wide as the range and as tall as every row) AND the pointer is inside the part of it the scroller shows: the zone's droppable `data` carries two live readers, `visibleBounds()` (the scroller's rectangle minus the sticky columns on the left and the sticky header on top) and `zoneLeft()` (the zone element's `getBoundingClientRect().left`), both read at the moment of the event; a release over the tray, the footer or the left columns schedules nothing, and neither does the keyboard (no coordinates). **The pointer is the live one**: `TimelineDndContext` records it from the activator on and follows `pointermove` on `window` for the length of a tray drag. dnd-kit's own `delta` is NOT used for a tray item: once `over` is the zone, dnd-kit takes the scroll offsets of the OVER node's scrollers, so `delta` gains the grid's whole `scrollLeft` (a drop landed thousands of pixels away — found by the e2e), and `over.rect` is a snapshot from the drag's start that any later scroll makes stale. One timeline per page: `TIMELINE_DROP_ID` and the DndContext id are fixed.
- Bar anatomy: a `div` wrapper positioned by the scale holding three SIBLING draggables (no button inside a button): the body (translated in place while moved) and the two edge handles, which sit OUTSIDE the bar (`left/right: −w`) with a CONSTANT width per zoom (6 px at week/month, 4 px at quarter) — a width derived from the live bar would change mid-resize and make dnd-kit re-measure the node it is dragging, and outside handles leave even a 1-day bar at quarter zoom (3 px) its whole body as the move target (a pointer hit on 3 px is still precise work: the keyboard path is the reliable one there). While an EDGE is held, the bar redraws from the context's
  preview dates (`useTimelinePreview`); a move keeps its geometry and translates. Read-only bars are a labelled `role="img"`, no handles.
- **Autoscroll** is dnd-kit's, narrowed per gesture: its default zone is 20 % of the scroller on both axes, which a bar near the right edge of the grid sits inside — a one-day resize there scrolled the grid by days under a 28 px pointer move (found by the e2e). A BAR gesture gets `{ x: 0.05, y: 0.02 }` (along time only, and only when the held bar really reaches the edge; never zero, dnd-kit divides by the threshold); a TRAY drag gets `{ x: 0.05, y: 0.15 }` (it travels from the tray under the grid up to it, so the page or a tall grid may need to scroll vertically). `autoScroll` is a prop of the one `DndContext`, so the context swaps the two configs at drag start and back at the end. Trade-off: dnd-kit measures the zone on the scrollers of the node the item is OVER, so a tray item held over the grid also scrolls the grid's rows near its top/bottom edge — wanted with 1,000 rows, a little eager with 20.
- `onDragEnd` proposes through `onSchedule` only when the outcome differs from the bar's current dates; a cancel, a no-op or a tray drop outside the track proposes nothing. `onSchedule` is a proposal and answers whether the page TOOK it: a refusal (`false` — the project view refuses while a save is running) is never silent — dnd-kit's drop announcement is corrected to `timeline.announce.dropRefused` ("… was not changed: a save is still running"), the bar snaps back, and the page shows and announces its own "try again" notice (the Schedule button and the schedule dialog get the same treatment through the page's one `commit`).
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
tab stop falls back to the first mounted row. Cells carry `scroll-margin` (header height, sticky columns) so a focused cell scrolls clear of the sticky parts when the browser decides to scroll — and it does not when the item is only PARTLY covered by them (it does not count sticky elements as covering), so the grid also reveals the focused item itself (`revealFocused` on the grid's `focus` event, only for `:focus-visible` — a mouse press must not move the grid under the pointer: it measures the target against the part of the scroller that is really shown, inside its border so a classic scrollbar is excluded, and scrolls the difference, never further than the item's own START edge reaching the sticky parts, so a bar wider than the visible track shows its start; left cells only vertically). Found by the 1,000-row measurement: a bar half under the columns took focus with its ring hidden.

#### Virtualisation

The body is at least `MIN_BODY_ROWS` (3) rows tall even with fewer rows, so an empty or nearly empty timeline still has an area to drop an Unscheduled item on (the drop zone is as tall as the body). Rows are virtualised with `@tanstack/react-virtual` (`useVirtualizer`; fixed 36 px rows, `overscan` 8, the `ScrollRegion` as the scroller, `scrollMargin` = the 56 px header) **only when `rows.length > virtualizeFrom`** (default 80). Both paths mount the same `TimelineRow`; the virtual one gives
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

`utils/timelineScale.test.ts`, `utils/timelineDrag.test.ts`, `utils/timelineArrows.test.ts` (pure, table-driven: every route shape per type, the backtrack above and below, the mounted-rows filter, missing rows/bars; the Timeline suite adds the tones and the arrows through the overlay, plain and virtual, and the committed-dates rule); `hooks/useRovingGrid.test.tsx` (vertical fallback, ragged rows); `components/Timeline.test.tsx` (bars at their computed `left`/`width`, read-only rows, bands, the overlay geometry, the `track` slot, roving navigation,
every drop outcome through the wrapped `DndContext` — happy-dom has no layout, so the handlers are fed events —, the announcements, the keyboard sensor end to end, the virtual window with `virtualizeFrom = 5` and a stubbed viewport (`clientHeight`), scroll-then-focus, the tray). The real pointer drag, the resize handles, the tray
drop under a scrolled grid and the keyboard sensor under a real layout are `e2e/tests/project-view.spec.ts` — those scenarios own them (and they found the autoscroll zone above).

#### Measured figures at scale

Measured once, manually, with C4 (a throwaway script, not committed): ONE project with 1,000 milestones over 10 teams, all scheduled (1,000 `POST` + 1,000 schedule `PUT`s through the API took ~10 s), opened as the seed administrator in headless Chromium (1440 x 900, week zoom, a ~15-month range (today to 2028-01), a production build served by the compose stack, an Apple-silicon laptop). Figures are this machine's; re-measure on a change to the row or the virtual path.

| What | Figure |
|---|---|
| Page ready (navigation until the first bar is in the DOM) | ~350 ms |
| Rows mounted at the top / after scrolling / at the last row | 25 / 28 / 26 of 1,000 (18 visible + `overscan` 8) |
| DOM nodes in the whole document | 1,287 at the top, 1,344 at most — bounded by the window, plus the header's per-day cells (the time axis is not virtualised) |
| Scroll: 600 frames of 108 px (3 rows) down then up | frame interval p50 16.7 ms, p95 16.8 ms, max 16.8 ms (the 60 Hz cap); scripting 4.1 ms and whole tasks 5.2 ms per frame (CDP `Performance.getMetrics`) |
| ↓ x 150 from the first row | focus never left the grid (0 losses), ended on body row 151 (`aria-rowindex` 152) |
| Ctrl+End | focuses the last row (`aria-rowindex` 1001) |
| A pointer drag of the last row's bar by two days (after Ctrl+End) | `PUT` 200, the bar moved two days |

What the measurement found and fixed: a bar half under the sticky columns took focus with its ring hidden and a pointer press at its centre hit a left cell (the browser does not count sticky parts as covering — `revealFocused`, see "Accessibility model"); dnd-kit's default autoscroll zone scrolled the grid under a resize at the right edge (see "Drag, resize and keyboard contract").

#### Deliberate departures from the bootstrap sketch

A div grid instead of a `<table>` (virtual rows); `top` instead of `translateY` for virtual rows (stacking); the tray's drag is pointer-only with an explicit Schedule button; dnd-kit's live region is the single announcer for drags (the page's polite region announces only non-drag changes).

# The shared Timeline component

Owns: the `Timeline*` component's contract (coordinates, data, overlay, gestures, accessibility, virtualisation, overlays and markers), the pages' use of it and the latest measured figures. Not here: each page's own mechanics and write path (`web-internals.md`); page chrome, the transport rules and the nav model (`web/CLAUDE.md`); the server's view documents, their caps and validators (`planning-model.md` "The view documents", "View validators").

One component serves every Gantt-like page: the project view (milestones of one project), the team view (milestones against capacity), the roadmap and the programs view. Pages differ in their rows and bar sources, not in the mechanics.

Files: all flat under `web/src/`.
- `utils/timelineScale.ts` (pure coordinate model, header, hatch, default range), `utils/timelineDrag.ts` (pure drag arithmetic, dnd-kit keyboard getter and modifiers), `utils/timelineModel.ts` (the data contract types and layout constants, `headerHeight()`).
- `hooks/useTimelinePreview.ts` (drag data and preview context).
- `components/Timeline.tsx` (the frame; its drop zones are `hooks/useTimelineDropZones.ts`, the pending row-focus wish `hooks/useTimelinePendingFocus.ts`, `revealFocused` `utils/timelineReveal.ts`, the overlay's geometry `utils/timelineGeometry.ts`).
- `TimelineHeader.tsx`, `TimelineRow.tsx` (and `TimelineBand`), `TimelineBar.tsx`, `TimelineToolbar.tsx`, `TimelineUnscheduledTray.tsx`.
- `TimelineDndContext.tsx` (its pointer, slot and day readers are `utils/timelineDragTracking.ts`, its announcements `hooks/useTimelineAnnouncements.ts`).
- `TimelineDrawSurface.tsx` ("The draw gesture"); `utils/timelineArrows.ts` and `components/TimelineArrows.tsx` ("Arrows"); `utils/timelineLoad.ts` and `components/TimelineLoadStrip.tsx` ("The load strip").
- `theme.module.css` holds the `timeline*` classes; strings are in `locales/{en,pl}/timeline.json`.

## Rules

- The component draws and proposes; it never writes and never decides. The page adapts its view document to rows (`TimelineRowData[]`), reads the `can:{…}` flags for `editable` and answers a proposed change with its own write path (optimistic update, the server's verdict, rollback; `hooks/useRoadmapRanking.ts` is the template).
- The server alone decides who may schedule (`PUT /milestones/{id}/schedule`, team manager or ADMIN), and every date and working-day figure; the client only draws and phrases them. No holiday, dependency or load figure is computed on the client; the one client rule is the schedule dialog's "at least one working day" pre-check (`hasWorkingDay`).
- Dates cross the component boundary as ISO `YYYY-MM-DD` strings and are epoch days inside. A bar spans from the LEFT edge of its first day to the RIGHT edge of its last.
- The page owns the range and keeps it stable across edits: computed from the first load and only ever grown. A date the page does not own (Jira's) never stretches it unbounded: it joins only inside the Jira window.
- A page offers its own zoom list (`MILESTONE_ZOOMS`, `PLAN_ZOOMS`) and validates its stored zoom against it.
- The overlay's geometry is computed from data, never measured: rows are 36 px and `rowTop(i) = i × 36`, mounted or not.
- The header's height is `headerHeight(hasStrip)`, computed ONCE in `Timeline.tsx`; every consumer follows it, a literal is a bug, and any future sticky header part adds to it.
- ONE `TimelineDndContext` per page carries every drag kind (`move`, `resize-start`, `resize-end`, `tray`, `row`, `draw`): dnd-kit binds to the NEAREST context, so a second context, or `@dnd-kit/sortable` inside the Timeline, is not an option. No row ever gets a transform.
- A dnd-kit surface always ships explicit controls (the Roadmap rule): the schedule dialog, the tray's Schedule button and the row menu are the keyboard and screen-reader path. The tray, row and draw handles are pointer-only: only `listeners.onPointerDown`, never the keyboard sensor's `onKeyDown`, no `attributes`, not focusable.
- A drop is a proposal: `onSchedule` and `onReorder` answer whether the page TOOK it, and a refusal is never silent (`dropRefused` plus the page's "try again" note). A cancel, a no-op or a drop outside the track proposes nothing.
- dnd-kit's live region is the single announcer for drags (localized `timeline.announce.*`); a page announces only its non-drag changes in its own polite region.
- A mounted `DragOverlay` is not inert for other drags, so it is mounted for a row drag only.
- Bars are data, so they are neutral gray (`--timeline-bar`); the brand cyan appears only on the focus ring and on the bar being dragged. No emphasis adds a hue (red = a violated constraint, orange = a warning); a shape or a position accompanies every hue, never a colour alone. All styling is `light-dark()` in `theme.module.css`.
- Tests read data attributes and `data-part`, never colour.
- Overlays (arrows, bands, the load strip, the shadow bars) are decoration: `aria-hidden`, pointer-transparent. The accessible surface is the page's own table or text, and a tone changes no accessible name beyond the page's `describe`.
- A read-only tone (`ghost`, `summary`, `proposal`, `baseline`, `jira`) is ignored by an editable bar; `window` is honoured on both.
- An optimistic step keeps the server-derived figures untouched (`span`, `drift`, `idleGaps`, `slackDays`, `critical`, `criticalPath`, the dependency checks, `weeks`, the `baseline` block); the refetch brings the new ones.
- With no pick or toggle on, an overlay leaves the DOM exactly as it was (pinned by the pages' tests).
- Rows virtualise only above `virtualizeFrom` (80), positioned with `top`, never `transform`; the time axis is not virtualised.
- Deliberate departures from the bootstrap sketch: a div grid, not a `<table>` (virtual rows are absolutely positioned); `top`, not `translateY`; the tray's and the row's drag handles are pointer-only (the Schedule button and the row menu's Move items are the keyboard paths).
- One timeline per page: `TIMELINE_DROP_ID`, `TIMELINE_ROW_DROP_ID`, the `DndContext` id and the arrow marker ids are fixed.
- Measured figures are one-off and NON-BINDING; re-measure rather than quote.

## Coordinate model

Dates cross the component boundary as ISO `YYYY-MM-DD` strings; inside they are **epoch days** (whole days since 1970-01-01, UTC; `toEpochDay`/`toIsoDate`). A range is `[from, to]` inclusive. A day is `dayWidth` pixels; a bar spans from the LEFT edge
of its first day to the RIGHT edge of its last: `left = xOf(start)`, `width = (end − start + 1) × dayWidth`. A scale is made by `makeScale(zoom, range)` and carries `xOf(day)`, `widthOf(start, end)`, `dayAt(x)` (floor) and `totalWidth`. Monday = 0 is
`(epochDay + 3) % 7` (`weekdayOf`); the weekend is Saturday–Sunday (`isWeekend`). Public holidays do NOT join that predicate: they come from the dictionary, are a separate hatch layer and a header name (see "Public holidays"), and `isWeekend` stays the pure Monday-start arithmetic.

| Zoom | px / day | Header groups | Header cells | Weekend hatch | Default range padding (snapped outward) | Empty default |
|---|---|---|---|---|---|---|
| `week` | 28 | ISO weeks (`W38 2026`) | days (`16`; weekend cells tinted) | yes | ±2 weeks → whole Monday–Sunday weeks | today ±6 weeks |
| `month` | 8 | months (`2026-09`) | ISO weeks (`W38`) | yes | ±1 month → whole months | today ±3 months |
| `quarter` | 3 | quarters (`2026-Q3`) | months (`2026-09`) | no (3 px/day is noise) | ±1 quarter → whole quarters | today ±2 quarters |
| `year` | 1 | years (`2026`) | quarters (`2026-Q3`) | no | ±1 year → whole calendar years | today ±1 year |

**Which zooms a page offers** is its own list: `MILESTONE_ZOOMS` (`week`, `month`, `quarter` — the project and team pages, the `Timeline`'s default `zooms`) and `PLAN_ZOOMS` (`month`, `quarter`, `year` — the roadmap and programs pages). The toolbar renders exactly the `zooms` prop, and a page validates its stored zoom against its own list (`isOneOf(MILESTONE_ZOOMS)`), so a `year` stored by a plan page never reaches a milestone page. The load strip treats `year` like `quarter` (type-complete; the strip is never shown there).
Labels are language-neutral (`formatDate.ts` rule). Groups and cells each PARTITION the range and are clipped to it (a week or month crossing the range edge is a shorter cell, never dropped); a cell may straddle two groups (a week across a month boundary).
`defaultRange(dates, today, zoom)` is the range a page opens with: min/max of the dates ∪ today, padded and snapped as above. **A date the page does not own never stretches it unbounded:** the Jira dates are external input (the server accepts any date from 1900 to 2999, so a mistyped 2206 would otherwise give every user a track of hundreds of thousands of pixels, and the grow-only range could not be undone by the toggle), so they join the range only inside the Jira window (`jiraWindow`, "The Jira markers").
**The page owns the range and keeps it stable across edits** (compute it from the first load, only ever grow it):
a range recomputed from every drag would shift every bar under the pointer. `scrollLeftToCenter` backs the toolbar's Today.

## Data contract

Files: `utils/timelineModel.ts`.

- `TimelineColumn{id, header, width}` — the sticky left columns (the first is the row header: the name). `leftWidth` = their sum.
- `TimelineRowData{id, cells, bars, bands?, track?}` — `cells[i]` belongs to `columns[i]`: static content (the cell itself is the roving stop) or a **function `(stop) => node`** that spreads `stop` (`data-grid-pos`, `tabIndex`) on its own focusable (a link, the row
  menu button) so one cell never holds two tab stops. `bars` are the row's bars (usually one). `bands` are confined to this row's track. `track` REPLACES the bar rendering of the row's track (positioned with the scale); the row's hatch and bands still draw. A track-only row (no `bars`) exposes no roving columns beyond its left cells, so focusable content inside a `track` brings its own focus handling.
  **No page uses `track`**: the load strip is a header band (a sticky strip), see "The load strip"; the slot stays for a per-row decoration.
- `TimelineBarData{id, start, end, label, describe, editable, tone?}` — `describe` is the bar's accessible name (the page builds it: "{name}, {team}, {start} to {end}, {estimate} man-days"); the component appends ", read-only" (`timeline.bar.readOnly`) when
  `editable` is false. `label` is the short name used by the handles and announcements. Bar ids are unique across the timeline. `tone?: "ghost" | "summary" | "window" | "proposal" | "baseline" | "jira"`: `ghost`/`summary`, `proposal`, `baseline` and `jira` style a READ-ONLY bar (an editable bar ignores them; see "Bar tones", "The proposal preview" and "The baseline overlay"), `window` is honoured on a read-only AND on an editable bar (see "Bar tones").
- `TimelineRowData.draw?: {barId, label}` opts a row in to the draw gesture (see "The draw gesture").
- `TimelineBandData{id, start, end, label, tone: "window" | "drift" | "idle"}` — decorative (`aria-hidden`, `title` = label, `data-band-tone` = the tone); the facts live in the page's text. Passed as the `bands` prop it spans every row (the project's target window, the idle gaps); in a row it spans that row.
  `window` is a quiet gray tint with dashed edges, `drift` is orange (red is never used: nothing blocks), `idle` is a diagonal gray hatch with no edges (see "Idle bands").
- `Timeline` props: `label`, `scale`, `onZoomChange`, `today` (ISO, injected), `columns`, `rows`, `bands?`, `overlay?`, `strip?`, `holidays?` ("Public holidays"), `toolbar?` (the page's own controls after Today), `virtualizeFrom?` (80), `maxHeight?` (640), `busy?` (`aria-busy` on the grid while a save is in flight), `zooms?` (default `MILESTONE_ZOOMS`), `ref?: Ref<TimelineHandle>` (`focusRow`; a plain prop in React 19, no `forwardRef`).

## Overlay geometry

`overlay?: (g: TimelineGeometry) => ReactNode` renders its result inside ONE absolutely positioned `<svg aria-hidden>` over the body (`pointer-events: none`, origin = left of the range / top of the first row). `TimelineGeometry` is computed from DATA, never measured:
`scale`, `xOf(iso)`, `rowTop(i) = i × 36`, `rowHeight = 36`, `rowIndexOf(rowId) → index | null` (the row with that `TimelineRowData.id`; the id map is built on first call), `barRect(rowIndex, barId) → {x, y, width, height} | null` (`y = rowTop + 6`, `height = 24`; the committed dates, not a drag preview) and `visibleRows{first, last}` (the mounted
window; draw arrows only for these). Arrows therefore work identically on the plain and the virtual path.

## Arrows

Files: `utils/timelineArrows.ts` (pure routing + resolution), `components/TimelineArrows.tsx` (the renderer), `TimelineArrowData` in `utils/timelineModel.ts` (the input). A page passes `overlay={(g) => <TimelineArrows arrows={specs} geometry={g} />}`; the component draws, it decides nothing.

### The input contract

`TimelineArrowData{id, from, to, violated, label}`, `from` the predecessor and `to` the successor, each end `{row, bar, kind}`: `row` = the `TimelineRowData.id` of the row, `bar` = the `TimelineBarData.id` inside it, `kind` = `START` (the bar's left edge) or `END` (its right edge).
Dependency types map as FS = END→START, SS = START→START, FF = END→END, SF = START→END. `violated` draws the arrow red; `label` ("A → B, FS") is the path's `<title>` only. `id` is unique among the arrows. A page maps its view onto this; the component never learns what a dependency is.

### The route

The route (`arrowRoute`, all legs horizontal or vertical): the arrow leaves its anchor (the middle of the bar's edge) outward, runs vertically to the successor's row and enters the successor's anchor moving INTO the bar. Stubs are 8 px.
- Edges facing the same way (SS, FF) on different rows: one vertical leg just outside the further of the two 8 px stubs; never a backtrack.
- Opposite ways (FS, SF) and the successor's anchor is AHEAD of the predecessor's in the leaving direction (FS: `to.x >= from.x`; SF: `to.x <= from.x`): one vertical leg at `min(8 px, gap / 2)` from the predecessor's edge, then straight in. A narrow gap shrinks the stub instead of reading as a backtrack: back-to-back bars (gap 0) run straight down the shared edge,
  Friday to Monday at quarter zoom (9 px) turns at 4.5 px.
- The BACKTRACK is used only when the successor's anchor is BEHIND the predecessor's in the leaving direction (FS with the successor starting before the predecessor ends — a violation or a lead; SF whenever the successor ends right of the predecessor's start, its usual case) and for SS/FF on the SAME row (their straight leg would run through the bars' centre line;
  not a planned shape, but guarded): the vertical leg runs along the ROW BOUNDARY next to the successor's row (`rowTop(toRow)` when the predecessor's row is above, `rowTop(toRow) + rowHeight` when it is below or the same), a second horizontal leg goes to the approach point (anchor ± 8 px) and a short vertical leg drops onto the row — so the arrow never crosses a bar it connects.
- The overlay svg spans exactly the track, so a stub left of the range start (x < 0) is clipped. That strip is the sticky left columns' (opaque, z-index 3 over the overlay's 2), which would cover it anyway; the page's range is padded outward from its data, so a bar does not touch the range ends in practice.

### Which arrows are drawn, and the output

Which arrows are drawn (`arrowsToDraw`): an arrow whose row or bar is unknown to the geometry is skipped; so is an arrow with NEITHER end in `visibleRows` (the mounted window — on the plain path every row, on the virtual path the window with its overscan). An arrow with one mounted end is drawn whole: the other end is positioned from data. An arrow whose both ends lie outside the window but whose
line would cross it is NOT drawn (accepted: the project view never virtualises). **Committed dates only**: the geometry is built from `rows`, so a drag or resize preview does not drag an arrow; the optimistic update moves it at the drop.

Output: one `<path data-arrow={id} data-violated={true|false}>` per arrow with a `<title>` and a `marker-end` arrowhead; two `<marker>`s with the FIXED ids `timeline-arrowhead` / `timeline-arrowhead-violated` (one timeline per page). Tests and e2e count `data-arrow` and read `data-violated`; colour is never asserted. **Decorative**: the svg is `aria-hidden`, the accessible surface is the page's dependency table.
Where a page has no such table its text path is a link into the Dependencies list: the Roadmap and Programs project rows' menu item "Dependencies" (`?projectId=`), the team page's facts line ("N dependencies" and the red conflicts badge, `?teamId=`); no bar's name and no arrow's role changes.
Colour: tokens on `timelineGrid`: `--timeline-arrow` (the SOLID dimmed text colour, gray; the path carries `opacity: 0.7` so its line and arrowhead fade as one group instead of compounding an alpha colour where they meet; the head's tip sits on the anchor, `refX = 10`) and `--timeline-violation` (`light-dark(red-8, red-5)`: red = a violated constraint), 1.5 px strokes.

Cost: resolving the arrows is O(arrows) per render, never per scroll frame (the Timeline does not re-render on a scroll); the virtual pages re-run the mounted-rows filter on every scroll frame, and a per-row index is the remedy if that is ever not enough. Where two arrows end on the same anchor (an SS and an FS into one bar's start) their heads overlap and read darker, the only visible compounding. Figures: "Measured figures".

## Bar tones

Tones (`TimelineBarData.tone`, read-only bars only; rendered as a class and a `data-tone` attribute): `ghost` = an endpoint that lives on another project — the bar colour at 35 % with a dashed outline; `summary` = the project's own derived span — hollow, a 2 px outline; `proposal` = a proposed span, hollow with a DASHED 2 px text-colour outline ("The proposal preview"); `baseline` = the span a baseline froze, a thin SHADOW bar along the bottom of the row ("The baseline overlay"). A tone changes no accessible name: the page's `describe` carries the words
(`timeline.bar.ghost` "{label}, from project {project}" and `timeline.bar.summary` "{name}, the project's span {start} to {end}" are the strings the project view's ghost and summary rows use, `timeline.bar.window` "{name}, target window {start} to {end}" the one the roadmap's window bar uses; its bar names for a link's own ends gain ", N conflicts" while violated links end on them).

**The window tone:** `tone: "window"` is the target window drawn as a BAR, so it can be moved and resized with the bar machinery (the roadmap and programs pages put it in the project's row beside the span bar, `window:<projectId>`).
It is the one tone an EDITABLE bar honours: the band look (the `--timeline-band` tint shared with `TimelineBand`, 2 px dashed `--timeline-window-edge` edges, square corners) over the WHOLE row height (the wrapper's `timelineBarFrameWindow` class: `top: 0; bottom: 0`, where an ordinary bar sits 6 px inset), with the edge handles and the keyboard path of any editable bar (`data-tone="window"` on the body, read-only or editable). Held, it turns a translucent accent instead of the solid fill so the bar behind it stays readable.
It is mounted before the span bar, so the span paints over it. **A read-only `summary` bar is transparent to the pointer** (its frame gets `.timelineBarInert`, `pointer-events: none`; it stays a labelled, focusable image for the keyboard and assistive technology): a project's span usually covers most of its window, so a span that took the pointer would leave the window under it ungrabbable and the row's draw surface unreachable across it.
The decision is by tone, for every read-only summary bar on every page (an editable bar ignores the tone, ghost and window bars are unaffected); `Timeline.test.tsx` pins the class, the e2e (`roadmap.spec.ts`, third test) presses the middle of the span bar to move the window and to draw. The accessible name is the page's `describe` (`timeline.bar.window`); arrows never end on a window bar (the pages' arrow specs name the span bars).

## The load strip

`strip?: TimelineStripData{label, render(scale)}` renders a THIRD header row (`STRIP_HEIGHT` 36 px) under the date cells: a sticky left caption cell (`strip.label`, visible text) and a track part (`scale.totalWidth` wide, `overflow: hidden`) holding `render(scale)`. The whole row is `aria-hidden` and decorative; the page's weekly table is the accessible surface.
The row is part of the sticky header (z 4), so it stays under the dates while the body scrolls, and scrolls horizontally with the track.

**The header height rule.** The header is `headerHeight(hasStrip) = HEADER_HEIGHT (56) + (hasStrip ? STRIP_HEIGHT : 0)`, computed ONCE in `Timeline.tsx`; every consumer follows it: the drop zone's `visibleBounds().top`, the virtualiser's `scrollMargin` and `scrollPaddingStart`, `revealFocused`'s `clearTop`, and the two `scroll-margin-top` literals (`.timelineCell`, `.timelineBarBody`), which use `var(--timeline-head)`, set on the grid's inline style beside `--timeline-left`. With no strip the variable is `56px` and nothing else changes (pinned by `Timeline.test.tsx`).
The geometry's origin (the top of the first body row) is unchanged, so arrows need nothing.
Any future sticky header part adds to `headerHeight()`; a literal is a bug.

**The cells** (`components/TimelineLoadStrip.tsx`, geometry in the pure `utils/timelineLoad.ts` `stripCells(weeks, scale)`): input is a LOCAL `LoadWeek` type mirroring the server's week row `{weekStart, load, capacity, overloaded, overloadMd, maxWip, wipExceeded}` (the page maps its API type onto it).
One cell per ISO week at `scale.xOf(weekStart)`, seven days wide, clipped to the range like the header's cells (a week wholly outside is dropped; a cut week is a narrow cell of 3-28 px, so the cell is `overflow: hidden` and a cell under 40 px prints no figure — the `title` keeps it); `data-week`, `data-overloaded`, `data-wip-exceeded` and a `title` (the full sentence, `timeline.strip.*`).
- **The column** rises from the baseline; its height is `min(load / capacity, 1.25) x 24 px`; a hairline at 24 px across the cell is the capacity line, so a column past it IS the overload. Gray (`--timeline-bar`), ORANGE (`--timeline-overload` = `light-dark(orange-8, orange-5)`, the drift token's pair) when `overloaded`; a translucent fill under a crisp 2 px top edge, so the figure on top stays readable. A zero capacity (on hold) with a load is the 125 % cap; any non-zero load shows at least a 1 px column.
  The capacity hairline is the solid dimmed ink (no opacity: >= 3:1 non-text in both schemes), the only "100 %" cue.
- **No capacity** (`capacity: null`: the weeks before the team's first period): no column and no line, only the load figure in the dimmed ink, never flagged — distinct from a capacity of 0.
- **The figure:** week zoom "8.5 / 14", month zoom "8.5", quarter zoom none (a 21 px cell); a prorated capacity is simply the week's number.
- **The WIP mark** (distinct from the overload by SHAPE, the same warning hue): while `wipExceeded`, a small chip with a DASHED orange outline in the cell's top-right corner carrying the peak `maxWip` (week and month zoom), a 6 px dot at quarter zoom. The chip's ink is the text colour (orange text on white is under 4.5:1).
- Tests read the data attributes and the `data-part` of each mark (`capacity-line`, `fill`, `figure`, `wip`), never colour. Pure geometry: `utils/timelineLoad.test.ts`.

## Drag, resize and keyboard

ONE `TimelineDndContext` per page wraps the `Timeline` and the `TimelineUnscheduledTray` (`scale`, `onSchedule(barId, start, end) → boolean`). Sensors: `PointerSensor` (activation distance 5 px) and `KeyboardSensor` with `keyboardCoordinates(dayWidth)` (`scrollBehavior: "auto"`).
Collision is `pointerWithin` (over a filtered candidate list — see "Row drag"). Every draggable carries `DragData{kind, barId, label, start?, end?, position?, count?}`; `kind` is `move | resize-start | resize-end | tray | row | draw` (the fourth family, "Row drag" below, proposes a slot, not dates; the fifth, "The draw gesture" below, proposes a span from two days) and the pure `dropOutcome(kind, bar, deltaDays, dayAtPointer)` turns it into dates:

- `move`: both ends + Δ days. `resize-start`: start + Δ, clamped to ≤ end. `resize-end`: end + Δ, clamped to ≥ start (a one-day bar is the minimum). `tray`: start = the day under the pointer, end = start + 6 (one calendar week; the page's Schedule
  button uses the same `dropOutcome("tray", …)` with its own day). Δ = `round(delta.x / dayWidth)`; bar gestures are held to one row and whole days by the modifiers `horizontalOnly` and `snapToDays(dayWidth)` (a tray item is left free).
- The tray's day is `dayAt(pointer.x − zoneLeft)` while `over` is the track drop zone (`TIMELINE_DROP_ID`, an invisible element exactly as wide as the range and as tall as every row) AND the pointer is inside the part of it the scroller shows: the zone's droppable `data` carries two live readers, `visibleBounds()` (the scroller's rectangle minus the sticky columns on the left and the sticky header on top) and `zoneLeft()` (the zone element's `getBoundingClientRect().left`), both read at the moment of the event;
  a release over the tray, the footer or the left columns schedules nothing, and neither does the keyboard (no coordinates).
  **The pointer is the live one**: `TimelineDndContext` records it from the activator on and follows `pointermove` on `window` for the length of a tray drag. dnd-kit's own `delta` is NOT used for a tray item: once `over` is the zone, dnd-kit takes the scroll offsets of the OVER node's scrollers, so `delta` gains the grid's whole `scrollLeft` (a drop landed thousands of pixels away), and `over.rect` is a snapshot from the drag's start that any later scroll makes stale. One timeline per page: `TIMELINE_DROP_ID` and the DndContext id are fixed.
- Bar anatomy: a `div` wrapper positioned by the scale holding three SIBLING draggables (no button inside a button): the body (translated in place while moved) and the two edge handles, which sit OUTSIDE the bar (`left/right: −w`) with a CONSTANT width per zoom (6 px at week/month, 4 px at quarter) — a width derived from the live bar would change mid-resize and make dnd-kit re-measure the node it is dragging, and outside handles leave even a 1-day bar at quarter zoom (3 px) its whole body as the move target (a pointer hit on 3 px is still precise work: the keyboard path is the reliable
  one there). While an EDGE is held, the bar redraws from the context's
  preview dates (`useTimelinePreview`); a move keeps its geometry and translates. Read-only bars are a labelled `role="img"`, no handles.
- **Autoscroll** is dnd-kit's, narrowed per gesture: its default zone is 20 % of the scroller on both axes, which a bar near the right edge of the grid sits inside — a one-day resize there scrolled the grid by days under a 28 px pointer move. A BAR gesture gets `{ x: 0.05, y: 0.02 }` (along time only, and only when the held bar really reaches the edge; never zero, dnd-kit divides by the threshold); a TRAY drag gets `{ x: 0.05, y: 0.15 }` (it travels from the tray under the grid up to it, so the page or a tall grid may need to scroll vertically).
  `autoScroll` is a prop of the one `DndContext`, so the context swaps the two configs at drag start and back at the end. Trade-off: dnd-kit measures the zone on the scrollers of the node the item is OVER, so a tray item held over the grid also scrolls the grid's rows near its top/bottom edge — wanted with 1,000 rows, a little eager with 20.
- `onDragEnd` proposes through `onSchedule` only when the outcome differs from the bar's current dates; a cancel, a no-op or a tray drop outside the track proposes nothing.
  `onSchedule` is a proposal and answers whether the page TOOK it: a refusal (`false` — the project view refuses while a save is running) is never silent — dnd-kit's drop announcement is corrected to `timeline.announce.dropRefused` ("… was not changed: a save is still running"), the bar snaps back, and the page shows and announces its own "try again" notice (the Schedule button and the schedule dialog get the same treatment through the page's one `commit`).
- **Keyboard:** Space or Enter on a focused bar or handle picks it up; ←/→ one day, Shift+←/→ seven; Space/Enter drops (`onSchedule`); Escape cancels; ↑/↓ do nothing while held. A resize cannot cross the opposite edge: the getter clamps the displacement from the held bar's dates and steps from the clamped value, so ← after an overshoot is never silent. Read-only bars are not touch drag targets (the page still scrolls under a finger). While a bar is held the grid's own arrow handling is suspended (`useDndContext().active`).
- **Announcements** are dnd-kit's own live region, localized (`timeline.announce.*`, EN/PL): pick-up (kind-specific, with the dates and the keys), every step (`name: start to end`, said once per distinct span), the drop, cancel; for a tray item: pick-up, scheduled/not scheduled, cancel. The
  `screenReaderInstructions` (`timeline.dnd.instructions`) are the `aria-describedby` text of every draggable. A page announces its own non-drag changes (the Schedule button, the schedule dialog, the save verdict) in its polite live region.
- **The deterministic path** (the Roadmap rule: a dnd-kit surface always ships explicit controls): the page provides "Edit schedule…" (a dialog with two date inputs and Unschedule) and the tray's Schedule button. The tray's drag handle is pointer-only (`aria-hidden`, no keyboard
  sensor attached); the Schedule button is its keyboard and screen-reader path. The tray is deliberately not in a scroll region: a dragged row translates out of the table over the timeline and a scroller would clip it.

## Row drag

A team manager reorders the page's rows by dragging a row's handle. It is the **fourth drag kind (`kind: "row"`) on the ONE `TimelineDndContext`**, not a second context: dnd-kit's hooks bind to the NEAREST `DndContext`, so a sortable context inside the Timeline would capture every bar's `useDraggable`, and a sibling cannot exist (headers and bars live in the same row elements).
`@dnd-kit/sortable` is not used either — it translates every sibling row, and a transform on a row makes a stacking context per row (the reason virtual rows use `top`): the sticky left cells (z 3) would drop under the overlay svg (z 2), and rows that are not mounted could not shift anyway. **No row ever gets a transform**: the held row stays put, a `DragOverlay` card follows the pointer and an insertion line marks the slot.

- **The handle** (`components/TimelineRowHandle.tsx`): `useDraggable({id: "row:<id>", data: {kind: "row", barId, label, position, count}})` with ONLY `listeners.onPointerDown` attached (the tray handle's rule: never the keyboard sensor's `onKeyDown`, no `attributes`), `aria-hidden`, not focusable, `touch-action: none`. The row's header cell stays a STATIC roving stop, so "one cell, one stop" holds; a pointer press on the handle focuses the cell (the row becomes the tab stop) without a reveal (`revealFocused` acts on `:focus-visible` only).
  The page renders it first in the name cell, only with the view's `can.editOrder`. **The keyboard and screen-reader path is the row menu** (Move up / down / to top / to bottom) — the Roadmap rule, with the handle pointer-only like the tray's.
- **The row zone** (`TIMELINE_ROW_DROP_ID`): a second invisible droppable over the WHOLE body (`leftWidth + totalWidth` wide, `bodyHeight` tall, `pointer-events: none`, `aria-hidden`), rendered by every `Timeline` and inert unless a row is held.
  Its `data` carries three live readers, the track zone's idiom: `zoneTop()` (its `getBoundingClientRect().top` read at the event — negative once scrolled), `rowBounds()` (the scroller from its left edge, below `headerHeight(hasStrip)`) and `rowCount` (`rowBounds()` is `{left, right, top, bottom, scrollerTop}`: `top` is where the rows start, `scrollerTop` the scroller's own top edge). dnd-kit measures droppables once at drag start, so its rectangle of the zone is a snapshot that does not reach over the sticky header at a scroll offset of 0 — a row drag therefore does not use
  `pointerWithin` on it (see "Collision filter"); every number comes from the live readers.

### The slot, the collision filter and the drop

- **The slot** (`utils/timelineDrag.ts`): `rowSlotAt(y, zoneTop, rowCount) = clamp(round((y − zoneTop) / 36), 0, rowCount)` while the live pointer (tracked from the activator on, like a tray drag's) is over the rows. **Over the sticky header** (inside the scroller horizontally, above `rowBounds().top`) the slot is the first one that lies below the header (`rowSlotWithin`: `ceil((top − zoneTop) / 36)`), not `null`: the header is most of the scroller's top-15 % autoscroll zone, and a target that vanished there would make scrolling UP with a held row nearly impossible.
  Outside the scroller (the tray, the page around the grid) the slot is `null` and nothing lands. The upper half of a row is the slot before it, the lower half the slot after it. The body is `rows × 36` px and row `i` sits at `i × 36` mounted or not, so **a slot between rows that are not mounted is as valid as any other**: the arithmetic never looks for a row element.
  `rowPositionAfter(index, slot)` is the announced 1-based position; a slot of `index` or `index + 1` is a no-op (`isRowNoop`) — announced as "stays" from the pick-up position, but the context still PROPOSES it: the page judges against the order it shows NOW (a refetch mid-drag can have moved the row).
- **Collision filter**: the row zone lies under the track zone, so the collision detection answers a `row` drag with the row zone ALWAYS (whether the pointer is really over the rows, the header or outside is the slot function's question, answered from the live pointer) and every other kind with `pointerWithin` over everything EXCEPT it — bars and the tray see exactly the droppables they saw before.
- **Preview, indicator, overlay**: `TimelinePreview` is the bar preview or `{kind: "row", barId, label, slot | null}` (set at pick-up with a `null` slot, updated only when the slot changes — one `setPreview` per 36 px).
  `components/TimelineRowDropIndicator.tsx` (rendered by `Timeline` after the rows; it reads the preview ITSELF, so a bar drag never re-renders the Timeline) draws a 2 px line at `max(slot × 36 − 1, 0)` (`data-row-slot`; z 3, after the rows in the DOM: over the sticky left cells but UNDER the sticky header, so a slot scrolled up beneath the header is covered by it instead of painting across it). The context mounts `<DragOverlay modifiers={[verticalOnly]} dropAnimation={null}>` with a `timelineRowGhost` card **only while a row is held** (the preview is a row's).
  **A mounted `DragOverlay` is not inert for other drags**: dnd-kit renders its fixed, z-index 999 wrapper for EVERY drag while one is mounted, even with no children, and then runs the drag in "overlay mode" (`components/TimelineDndContext.tsx`'s comment on the `DragOverlay`: no scroll compensation of the dragged node) — a bar dragged while the grid autoscrolls horizontally would drift from the pointer and an invisible wrapper would sit over it.
  So it is mounted for a row drag only; the bars' keyboard getter and translation are unchanged (the unit test runs the REAL overlay under a keyboard-held bar and asserts no wrapper). The context's own modifiers pass a `row` transform through like a tray's. The overlay is `position: fixed`, so no scroller clips it.
- **Autoscroll**: `ROW_AUTO_SCROLL = {threshold: {x: 0.02, y: 0.15}}`, swapped in at pick-up like the tray's. dnd-kit scrolls the scrollable ancestors of the OVER node (else the active one) — both inside the grid's scroll region — so holding a row near the top or bottom 15 % scrolls it, rows mount as they come into the window, and the slot follows the pointer against the live `zoneTop()`.
- **A row that unmounts mid-drag**: dnd-kit swaps an active node's `data` for an empty object when its draggable unmounts, which a virtualised row's handle does when autoscroll carries the row out of the window. The context therefore keeps the picked-up `DragData` (`held`) and resolves the drag from it when the active data is empty; the drop still knows what was held.
- **The drop**: slot `null` → nothing proposed, announced `dropRowNone`; otherwise `onReorder(barId, slot) → boolean` for every non-null slot (the page decides: `placed` answers `true` WITHOUT a PUT when the permutation equals the displayed order, so a drop beside the row sends nothing) (a new optional prop, `onSchedule`'s twin; the page's is `order.dropAt` — optimistic `applyTeamOrder`, the PUT against `order.revision`, the stale 409 → rollback and reload). `false` (a save in flight) is announced as `dropRefused` and the page shows its "try again" note.
  Pages without reordering (the project view) render no handle and pass no `onReorder`.
- **Announcements** (dnd-kit's region, `timeline.announce.*` EN/PL): `startRow` "Picked up {name}, position {n} of {count}. Move the pointer to the new place and release; Escape cancels.", `stepRow` (once per distinct slot), `dropRow` "Dropped {name} at position {n} of {count}.", `dropRowNone`, `cancelRow`. `screenReaderInstructions` ride on elements that spread `attributes`; the handle does not, so no bar-key instructions are read on it.
- **Tests**: the slot arithmetic and `moveToSlot` are table-tested; `Timeline.test.tsx` feeds the wrapped context the row events (overlay, indicator, announcements, `onReorder`, the refusal, the lost-data case, the collision filter); `TeamDetails.test.tsx` pins the PUT; the real pointer drag is one e2e scenario (`team-view.spec.ts`, with Escape) — a drag through autoscroll to unmounted rows is a manual pass on the sample plan.

## The draw gesture

A row with no target window yet opts in with `TimelineRowData.draw = {barId, label}` (`barId` = the id the window bar will have, `window:<projectId>`): a pointer drag across its EMPTY stretch draws the window. It is the **fifth kind (`kind: "draw"`) on the ONE `TimelineDndContext`**, for the same reason as the row kind (dnd-kit binds to the nearest context).

- **The surface** (`components/TimelineDrawSurface.tsx`, mounted by `TimelineRow` FIRST in the track, behind the bands and bars, so a bar or a band always wins the pointer where it sits): an absolutely positioned `aria-hidden` div, `useDraggable({id: "draw:<barId>", data: {kind: "draw", barId, label, trackLeft}})` with ONLY `listeners.onPointerDown` attached (the row handle's rule: never the keyboard sensor's `onKeyDown`, no `attributes`, not focusable, no roving stop of its own).
  `touch-action: pan-x pan-y pinch-zoom`: a finger scrolls the grid instead of drawing, so **the page's dialog is the touch, keyboard and screen-reader path** (the Roadmap rule). While a draw runs it paints a ghost over the span so far (`[data-draw-preview]`, the window look: `.timelineDrawGhost` shares `.timelineBarWindow`'s declarations).
- **The span** (`utils/timelineDrag.ts` `drawOutcome(anchorDay, pointerDay)`): `[min, max]` of the two epoch days, either direction, one day when equal (the minimum). The ANCHOR is the day under the pointer-down, read at pick-up from the activator's `clientX` against the surface's own live left edge (`trackLeft`: a drag has no `over` yet when it starts) and then fixed as an epoch day (the grid may autoscroll under the held pointer).
  The POINTER day is `scale.dayAt(pointer.x − zoneLeft())` with the TRACK zone's live reader and the live pointer tracked from the activator on, exactly the tray's rule; **the pointer's day is clamped to `[scale.from, scale.to]` (dnd-kit's zone rect is a snapshot, so after an autoscroll the pointer can sit over the sticky columns with a negative offset — about 300 days before the range at Year zoom), and while the pointer is not over the track zone (the tray, the page around the grid) the last span is kept**, and a drop there still proposes it.
  A draw does NOT use `visibleBounds`: drawing leftwards under the sticky columns must keep working so the autoscroll can bring the days into view. A pick-up with no pointer position (a non-pointer activator) has no anchor: nothing is previewed, nothing is proposed.
- **Collision, modifiers, autoscroll**: the collision is the bars' (`pointerWithin` minus the row zone); the modifier passes a `draw` transform through like a tray's; the autoscroll stays the bars' `{x: 0.05, y: 0.02}` (along time only; no swap at pick-up). Year zoom is 1 px per day: a 5 px activation is five days of anchor error if read late, which is why the anchor comes from the pointer-DOWN.
- **The drop** is `onSchedule(barId, start, end)` — the SAME seam as a bar move, with the `barId` the row would have, so a page handles move, resize and draw in one `window:<id>` branch; `false` (a save in flight) is announced as `dropRefused` and the page shows its "try again" note. A cancel proposes nothing and removes the ghost and the pointer listener.
- **Announcements** (dnd-kit's region, `timeline.announce.*` EN/PL): `startDraw` "Drawing {name}. Move the pointer across the days and release; Escape cancels.", the existing `step` ("{name}: {start} to {end}", once per distinct span), `dropDraw` "Drew {name}: {start} to {end}.", `cancelDraw`.
- **Tests**: `drawOutcome` is table-tested (`timelineDrag.test.ts`); `Timeline.test.tsx` "the draw gesture" feeds the wrapped context (the surface mounts only with `draw`, both directions, the live zone left, the kept span, no anchor, cancel, refusal, announcements, the listener, the collision); the real pointer draw is the third scenario of `e2e/tests/roadmap.spec.ts` (the roadmap and programs pages use it: `projectTrack` sets `draw` for a project with no window whose `can.editTargetWindow` is set).

## The pages' use

What each page does with the Timeline; the page's own mechanics are in `web-internals.md`.

### The project page

Files: `components/ProjectTimeline.tsx` composing the row builders of `ProjectTimelineRows.tsx` and `utils/projectDependencies.ts`.

Rows are the summary row (`project:<id>`, only while the project itself is a link end), the scheduled milestones, then one ghost row per distinct external end with dates (`ghost:m:<id>` / `ghost:p:<id>`, sorted by start, end, name; its name a link to that project).
An arrow per link whose status is not UNSCHEDULED, `violated` from the SERVER's check; an end with no row (a tray milestone, a project with no span) is skipped by `arrowsToDraw`. The page's range includes every end's dates.

### The team page

Files: `components/TeamTimeline.tsx`. The first consumer of the load strip: the page passes `strip={{label, render: (scale) => <TimelineLoadStrip weeks={view.weeks} scale={scale} />}}` with the server's week rows as they are (the API's `WeekLoad` is structurally `LoadWeek`). The weekly table (`TeamWeeklyLoad`) is the accessible surface; its legend is the strip's. Figures at scale: "Measured figures".

### The roadmap page's use

The first page on `PLAN_ZOOMS`. One row per visible project in rank order, a **divider row** (`id: "unranked"`, a static caption, no bars, no handle, present only while an unranked project is visible), then the unranked rows; the row's `id` is the project id, the left cells are `#` (the server's position), the project (handle, link, program dimmed), the flag icons and the row menu.
Bars: the **window bar** `window:<id>` (`tone: "window"`, editable by the project's `can.editTargetWindow`: move, resize, draw, the row menu's dialog - `web-internals.md` "The target window") drawn before the **span bar** `<id>` (`tone: "summary"`, read-only; the arrows' anchors), the drift band as a row band. Arrows come from the view's rolled-up `links[]` (a direct link by type, ONE bundle arrow per ordered project pair), `rowOf` answering only projects with a span bar on the displayed rows.
**The roadmap never rolls up:** it is a flat list with no program or work-stream row, so its anchor is the project's own id and `rolledUpLinks` is always empty there.
- **Row drag across the divider.** The page's `onReorder(id, slot)` reads the slot over the DISPLAYED rows (divider included): up to the divider's own index it is a place in the ranking (a ranked row moves there, an unranked row is ranked there), beyond it a ranked row is unranked and an unranked row stays (`rankingAfterDrop`, `utils/roadmapOrder.ts`). The handle's `position`/`count` are the row's index and the displayed row count, which is what dnd-kit's announcements say.
- **`focusRow`.** The flag panel's "Show in timeline" calls `focusRow(projectId)`: the row header of the project (the `#` cell) takes the focus and is revealed, mounted or not (the sample plan's ~100 rows take the virtual path).
- **Scale.** The grid virtualises above 80 rows; the page's range is the whole plan's spans and windows plus today and only grows, so a filter or a re-rank never shifts the bars. Figures: "Measured figures".
- **The critical path to a picked project.** A project row's `projectTrack(…, critical)` gives the span bar `emphasis: "critical"` (the "Critical path" outline of "The critical-path highlight", `describe` += `timeline.bar.critical`) for the TARGET and every `criticalPath.projects[].critical` project, and `planArrows(…, criticalPairs)` marks BOTH the direct and the bundle arrow of each ordered pair in `criticalPath.pairs` `critical: true` (`arrowSpecsForLinks`; a violated arrow stays red).
  The server's block exists only for the picked target (`?criticalPath=N`), the pick is page-local (no stored key, no toggle) and the Timeline is untouched:
  the page's panel (`RoadmapCriticalChain`) is the accessible surface, and the live region says "Showing the critical path to X" once the chain has ARRIVED (said once per PICK: the page remembers the target it said it for, so another baseline picked under that target, which re-loads the chain, does not say it again; a target with nothing scheduled says the panel's sentence instead, a rejected target nothing) and "Critical path hidden" at once. Without a target no spec, bar or attribute differs from before (`planTrack.test.ts`, `roadmapRows.test.ts`, `Roadmap.critical.test.tsx`).

### The programs page's use

The same `PLAN_ZOOMS` and the same project row, as a **collapsible tree**: one row per work stream, under an expanded one its programs, under an expanded program its projects (`treeRows`). A stream / program row is a read-only `summary` bar over the span its projects cover (the server's derived span; a stream the program pick shows in part is rolled up over the remaining programs) with the roll-up flag counts in the Flags cell; a project row is the roadmap's `projectTrack` (window bar, span bar, drift band).
Row ids: the project id for a project, `ws:<id>` / `pg:<id>` for the nodes (their bars' ids too); the arrows (`planArrows` over the view's rolled-up `links[]`) are drawn between the rows that STAND FOR the projects (next bullet).
- **Rolled-up arrows on a folded tree (web only, no wire change).** `arrowAnchors(view, pick, open)` (`programsTree.ts`) names, per project, the deepest bar the tree shows for it: its own span bar (work stream and program open), else its program's summary bar `pg:<id>` (the stream open, the program folded), else its work stream's `ws:<id>` (the stream folded). A project of a program the pick hides has no anchor (the stream's bar does not speak for it), and a row with no span bar anchors nothing.
  `planArrows(t, links, names, anchorOf)` folds the view's `links[]` in the server's order through `arrowSpecsForLinks` (`rolledUpLinks` is its second accumulator): two PROJECT rows keep today's arrows (the direct link by its type, ONE `bundle:<pred>-<succ>`); both ends on the SAME row, or on no row, draw nothing (the dependency is inside the row);
  anything else (a project and a node, two nodes) is ONE `rollup:<fromRow>-<toRow>` arrow per ordered row pair, **END to START whatever the links' types** (the bundle arrow's rule), `count` = the direct link (0 or 1) plus the `milestoneLinks.count` of every project pair folded into it, red when any link in it is `violated`, `critical` when ANY of its project pairs is in the page's critical pairs. Its `<title>` is `roadmap.rollupLabel` ("A → B, 3 links (1 violated)") with the two ROWS' names.
  At the default fold (streams open, programs folded) the arrows run between program rows, after "Collapse all" a link between two streams runs between work streams, a link inside one folded program draws none, and opening one program makes its projects' arrows end on the other, still folded, program. A node bar says ", N conflicts" (`project.barConflicts`, `conflictsByRow`) for the violated links of the rolled-up arrows ending on it, the arrows' non-visual trace; the project rows keep `conflictsByProject`, which already counts every link.
  Every figure is the server's, only summed over what the user folded; the arrows are `aria-hidden` and decorative. The roadmap passes `(id) => (withSpan.has(id) ? id : null)`, so it never rolls up.
- **The critical path on the programs page.** The same highlight as the roadmap's (`RoadmapCriticalPicker`, `RoadmapCriticalChain`, `criticalIndex`, `CriticalPathItem`; `GET /views/programs?criticalPath=N` answers the roadmap's block), drawn on the row that STANDS for each chain project (`arrowAnchors`): a project row on the chain gets `projectTrack`'s outline; a folded program or work stream row standing for at least one chain project gets the outline on its summary bar and ", holds a project on the critical path" in its name; an expanded node is not outlined;
  the arrows of the chain's pairs are `critical`, a rolled-up arrow when any pair folded into it is (a violated one stays red). Nothing is opened for the user.
- **The expand control lives in the first cell**, a function cell whose chevron button is the row's roving stop (`aria-expanded`; the Timeline itself knows nothing about trees).
  Expanding or collapsing changes the row list under the grid: rows are keyed by id, so while the rows stay on one render path the pressed button is the same DOM node and keeps the focus — but **a toggle that takes the row count across `virtualizeFrom` (80) swaps the plain path for the virtual one (or back) and every row remounts as a NEW DOM node**: the pressed chevron is gone and the focus falls to `body` (and a freshly enabled virtualiser mounts no row at all on its first render, its scroll rect being unknown).
  The Timeline does not keep a focused row across that switch; the page does: after a toggle it checks that the node's chevron is the focused element and otherwise calls `focusRow(nodeKey)` (mounted or not), as the roadmap does after a rank change. The page's polite status region says what changed. A node with no children is a static cell (the cell is the stop) with an empty chevron slot so the names line up.
- **Scale.** The default expansion is the work streams (≈ 25 rows on the sample plan); "Expand all" is ≈ 125 rows, which takes the virtual path (above 80). The range is the whole plan's spans and windows and only grows (`hooks/usePlanScale.ts`, shared with the roadmap), so folding never shifts the bars. Figures: "Measured figures".

## Accessibility model

A `div role="grid"` (labelled, `aria-rowcount`, per-row `aria-rowindex`; the header's cell row is row 1, body row `i` is `i + 1`) with `role="row"` rows of `rowheader`/`gridcell`s, inside the labelled, focusable `ScrollRegion` (`scrollRef` is its one extension). Not a listbox: a listbox
option may not contain interactive children (bars, handles, menus). Not a `<table>`: virtual rows are absolutely positioned, which a table row cannot be. The header's group row and date cells are decoration (`aria-hidden`); the bars' dates live in their accessible names.

**`focusRow(rowId)`** — `Timeline` accepts `ref?: Ref<TimelineHandle>` and exposes `focusRow(rowId)` through `useImperativeHandle` (the roadmap's flag panel "Show in timeline"). A MOUNTED row: its row-header cell (`[data-grid-pos="r,0"]`) takes the focus and is revealed with `revealFocused(target, force = true)` — `revealFocused` acts on `:focus-visible` only, and a programmatic focus after a click is not focus-visible, so `force` skips that test (the same arithmetic, clear of the sticky header).
An UNMOUNTED row (the virtual path): `pendingFocus = {r, c: 0}` + `virtualizer.scrollToIndex`, and the existing layout effect focuses the cell as soon as the row mounts (`scrollToIndex` already lands it below the header); the wish is dropped by the same events as an arrow key's. An unknown id does nothing and `focusRow` answers `false` (so does a mounted row whose cell is missing), so a caller can fall back to another target (the Roadmap's Filters button, `useRowMenuFocus`).

**One roving tab stop** (`hooks/useRovingGrid.ts`, generic over the grid element): ↑/↓ rows, ←/→ cells, Home/End row ends, Ctrl+Home/End grid ends. Columns of a row: the left cells `0…L−1`, then per bar `L + 3b` = the bar, `+1` its start handle, `+2` its end handle (editable only).
Rows have different widths, so a VERTICAL move lands on the target row's nearest lower column when the exact one is absent (a read-only row has no handle cells) and Ctrl+End goes to the last cell that exists on the last row. `isValid` treats an unmounted row or an absent column as invalid, so the
tab stop falls back to the first mounted row. Cells carry `scroll-margin` (`var(--timeline-head)`, sticky columns) so a focused cell scrolls clear of the sticky parts when the browser decides to scroll — and it does not when the item is only PARTLY covered by them (it does not count sticky elements as covering), so the grid also reveals the focused item itself (`revealFocused` on the grid's `focus` event, only for `:focus-visible` — a mouse press must not move the grid under the pointer: it measures the target against the part of the scroller that is really shown, inside its border
so a classic scrollbar is excluded, and scrolls the difference, never further than the item's own START edge reaching the sticky parts, so a bar wider than the visible track shows its start; left cells only vertically). Found by the 1,000-row measurement: a bar half under the columns took focus with its ring hidden.

**VoiceOver reading order of a keyboard bar move (Space, then an arrow, then Space): not yet recorded.** It needs a person with VoiceOver on the compose stack; the order the announcements arrive in (the grab, the move, the drop; dnd-kit's live region is the one announcer for drags) is to be recorded here as a dated note. The automated parts (axe over the grid, the open row menus and the baseline overlays, both themes) are in `e2e/tests/accessibility.spec.ts`; the roving grid at 100+ rows was probed ("Measured figures").

## Virtualisation

The body is at least `MIN_BODY_ROWS` (3) rows tall even with fewer rows, so an empty or nearly empty timeline still has an area to drop an Unscheduled item on (the drop zone is as tall as the body). Rows are virtualised with `@tanstack/react-virtual` (`useVirtualizer`; fixed 36 px rows, `overscan` 8, the `ScrollRegion` as the scroller, `scrollMargin` = the header's height, `headerHeight()`: 56 px, 92 with a strip) **only when `rows.length > virtualizeFrom`** (default 80). Both paths mount the same `TimelineRow`; the virtual one gives
each row `position: absolute; top: index × 36` inside a body of `rows × 36` px (`top`, not `transform`: a transform makes a stacking context per row and the sticky left cells could not rise above the today line and overlay). The project view (10–50 rows) never virtualises; the team view (up to ~270 rows)
and the roadmap (~100 rows) and fully expanded programs tree (~125) do. **↑/↓ and Ctrl+Home/End at an unmounted row** are taken by the Timeline: it `scrollToIndex`es, remembers the wanted cell and focuses it (or the nearest cell to its left) in a layout effect as soon as the row mounts; that wish is dropped by any other key, a focus elsewhere, or a scroll by hand (wheel, touch, pointer, a key on the scroller), so it cannot steal focus later. `scrollToIndex` lands the row below the sticky header (`scrollPaddingStart`). Horizontal (time-axis) virtualisation
is NOT built: a range is bounded by the project's span plus padding, the hatch is one periodic CSS background per row and the today line one element, so the only per-day DOM is the header's day cells (`BACKLOG.md`: the time-axis item; the plan pages measure 1,826-4,872 px of track, "Measured figures").

## Hatching and styling

The weekend hatch is ONE `repeating-linear-gradient(90deg, …)` per row track (`weekendBackground(scale)`): period `7 × dayWidth`, transparent Monday–Friday, the `--timeline-hatch` ink on Saturday–Sunday, phased to the Monday on or before the range start (a repeating gradient repeats both ways, so the phase may be
negative). Drawn at week and month zoom, not at quarter. A second layer rides on it for public holidays ("Public holidays" below). Bars are data, so they are neutral gray (`--timeline-bar`); the brand cyan appears only on the focus ring and on the bar being dragged. The today line is the text colour (2 px, 55 % opacity) with a "Today" tag in the header. All styling
is `light-dark()` in `theme.module.css` (`timelineGrid` defines the tokens). Stacking, bottom to top: bands and today line (no z-index; painted first) < row tracks and bars (the line shows through the tracks' transparent parts and passes UNDER the bars) < the overlay (z 2) < the sticky left cells (z 3) < the sticky header (z 4).

## Overlays and markers

Each overlay below has its own pick or toggle and draws nothing, and renders nothing extra, without it.

### Public holidays

`Timeline` takes `holidays?: readonly {date, name}[]` (the dictionary's rows; any range, the component filters to its own) — **a page passes `useHolidays()`'s list straight through; all four timeline components do** (`ProjectTimeline`, `TeamTimeline`, `RoadmapTimeline`, `ProgramsTimeline`), the plan pages included (the tint shows at their Month zoom). The component draws; the server's views are what decide any figure. Pure functions in `utils/timelineScale.ts`, one `holidayDayMap` (epoch day → name) built per render:

- **The row hatch is two layers.** `trackBackground(scale, map)` = `holidayBackground(...)` then `weekendBackground(scale)`, joined with `, ` into the ONE `backgroundImage` string computed once in `Timeline.tsx` and handed to every row as `hatch` (so the row still carries a single inline style).
  `holidayBackground` is one `linear-gradient(90deg, transparent 0px X0px, INK X0px X1px, transparent X1px …)` over the whole track (the track is `totalWidth` wide, so the stops are plain offsets from the range start; runs of consecutive holiday working days merge into one ink band; the last stop is `transparent X1px`). The SAME `--timeline-hatch` ink as the weekend and the same `HATCHED_ZOOMS` (week, month; none at quarter/year, 3 px a day is noise).
  **A holiday on a Saturday or Sunday is left out of the gradient** (the translucent ink would compound with the weekend stripe); it is still listed in the accessible paragraph. `null` where neither layer is drawn.
- **The header.** At week zoom the day cell of a holiday gets the weekend tint class and `title="Public holiday: {{name}}"` (`timeline.holidayTitle`) plus `data-holiday="true"` (`HeaderCell.holiday?`, set only on a DAY cell by `headerRows(scale, map)`; week/month/quarter cells and the group row never carry one). The header row is `aria-hidden`, so the title is a pointer affordance only.
- **The accessible text.** A `VisuallyHidden` `<p>` right after the toolbar: "Public holidays shown: 2027-01-06 Święto Trzech Króli, 2027-04-05 …" (`timeline.holidaysInView`, `{{list}}` = `date name` joined by `, `, in date order, the holidays inside the range, weekend ones included). It is rendered only at the zooms that draw a holiday (week, month) and only when at least one is in range, so the plan pages' multi-year Year zoom never prints a 70-entry paragraph.
  **Capped at `MAX_LISTED_HOLIDAYS` (10):** above that, `holidayListing(shown, today)` makes it "N public holidays shown; the next ones: …" (`timeline.holidaysInViewMany`) naming the first ten on or after `today` (the last ten when the whole view is in the past) — a month-zoom multi-year plan page holds ~40.
- **When the dictionary failed to load** the page passes `holidaysFailed` and `Timeline` shows a small muted line after the toolbar, "Public holidays could not be loaded; days off are not marked." (`timeline.holidaysUnavailable`), so a view whose server figures exclude holidays never silently draws them as normal days. A failed REFETCH keeps the last copy and shows nothing.
- **Not here:** the range never grows for a holiday (only the pages' own dates drive it), no holiday is a bar or a band, no arrow or figure is computed from the dictionary on the client — the one client rule is the schedule dialog's "at least one working day" pre-check (`hasWorkingDay`, `web-internals.md` "Project view").
- **Tests.** `timelineScale.test.ts` ("holidayBackground", "trackBackground", "holidays in the header and the accessible list": exact stops at 28 px/day for 2027-01-06, merged runs, the weekend and out-of-range omissions, the zoom gating), `Timeline.test.tsx` "public holidays" (two layers, the title/`data-holiday`, the paragraph, quarter/month zoom, no prop = unchanged), one wiring test per page.

### Idle bands

The project and team pages draw the server's `idleGaps[{start, end, workingDays}]` (`planning-model.md` "Idle gaps": runs of 3+ idle working days inside the span of the milestones that hold a working day; a gap starts and ends on a working day; weekends and holidays neither count nor break a run) as **one band per gap across every row**:
`idleBands(gaps, t)` in `utils/idleGaps.ts` maps each gap to `{id: "idle:<start>", start, end, label, tone: "idle"}` (the label is the band's `title`, no hover tooltip since bands take no pointer events, the Idle gaps table carries the facts: "Idle 2027-02-01 to 2027-02-05, 5 working days"; Polish plural keys `timeline.idle.band_*`). The band covers exactly the gap's first through last working day, so the weekend or holiday after it is not tinted.

- **Look.** `.timelineBandIdle` = the shared band box (`.timelineBand`: absolute, full row height, `pointer-events: none`) with the dashed edges removed and `repeating-linear-gradient(45deg, var(--timeline-idle-ink) 0 2px, transparent 2px 8px)` as its background. 45 degrees and a gray ink keep it apart from the weekend/holiday stripes (vertical, `--timeline-hatch`) and from the `window` tint and the orange `drift`; `--timeline-idle-ink` is a `light-dark()` token on `.timelineGrid`.
  Not orange and not red: an idle stretch is information (the facts-line badge is gray too), never a warning - a deliberate buffer is a legitimate plan.
- **Order.** `ProjectTimelineRows.bandsOf` returns window, drift, then the idle bands (a later band paints over an earlier one, so the hatch shows inside the target window); a project with no target window still gets its idle bands. `TeamTimeline` passes only the idle bands (the team page has no window).
- **Accessible surface.** The bands are decoration; `components/IdleGaps.tsx` (an h3 "Idle gaps" section with a `TableDisclosure`, columns From / To / Working days, an empty line otherwise) and the gray "N idle gaps" badge of the facts line carry the facts.
- **Optimistic updates.** The schedule write path's optimistic step (`applySchedule`, `applyTeamSchedule`, `applyTeamOrder`) KEEPS `idleGaps` untouched, like `span`, `drift`, the dependency checks and `weeks`: the gaps are working-calendar derivations only the server can compute, and dropping them would show a false "no idle gaps" (and make the badge and bands blink) for the round trip. The refetch after the PUT (the awaited one after a failure, whose rollback restores the pre-change figures) brings the server's gaps.
  For a moment a stale band can sit under a bar that has just moved; the same is true of the span and the load strip.
- **Tests.** `utils/idleGaps.test.ts` (the mapping, EN and PL plurals), `components/IdleGaps.test.tsx`, `Timeline.test.tsx` (`data-band-tone`, geometry), `ProjectView.test.tsx` and `TeamDetails.test.tsx` (bands, badge, table, the heading outline, the kept-then-refreshed gaps), `projectViewUpdate.test.ts`/`teamViewUpdate.test.ts` (the optimistic step keeps the same array).

### The critical-path highlight

The project page draws the server's critical path (`planning-model.md` "The critical path") on the shared Timeline behind a **toggle**: a `Button` (`aria-pressed`, filled cyan while on, `variant="default"` off) in the `Timeline` `toolbar?: ReactNode` slot (rendered after Today inside the toolbar group), persisted as `useStoredState("timeline.criticalPath", false, isBoolean)`. Off, nothing changes: no attribute, no class, no column, no marker, no section (pinned by `ProjectView.test.tsx`, "the page's DOM is the one it had before", and `Timeline.test.tsx`).
The toggle lives with the timeline, so a project without milestones has neither the toggle nor the section.

- **Monochrome.** No new hue: `--timeline-critical` (a token on `.timelineGrid`) is `var(--mantine-color-text)`. A critical **bar** gets `.timelineBarCritical` (a 2 px outline in that colour, 1 px offset, so it reads on a filled, a hollow summary or a dashed ghost bar alike; the two-class focus ring still wins) and `data-critical="true"`; a critical **arrow** gets `.timelineArrowCritical` (2.5 px, full opacity, text colour), `data-critical="true"` and its own arrowhead `<marker id="timeline-arrowhead-critical">` (the third fixed id; rendered only while some arrow is critical).
  A violated arrow stays red whatever it carries (the server never marks a violated link critical: a violation ends the chain), and `data-critical` is emitted only for an arrow that is critical and not violated, so the attribute matches what is drawn.
- **The input contract.** `TimelineBarData.emphasis?: "critical"` is independent of `tone` and honoured on editable AND read-only bars (the `data-critical` sits on the bar body, the focus target); `TimelineArrowData.critical?: boolean`, carried through `DrawnArrow.critical`. Absent/false renders nothing extra (the class string is unchanged, the attribute absent). The page's `describe` gains ", on the critical path" (`timeline.bar.critical`), after any ", N conflicts" and before the component's ", read-only".
- **What the page flags (while on).** Own milestone bars whose `critical` is true; a ghost bar whose entity is critical in `criticalPath.upstream`; the summary bar when a critical link ends on the project (`summaryCritical`); the arrows of the links the server marked `critical` (`arrowSpecs(view, true)`). All in `utils/projectDependencies.ts`, pure and tested.
- **Ghost rows are looked up by kind + id, never by `hops`.** `upstreamIndex`/`upstreamOf` key the server's `upstream` by `kind:id`. `hops` counts links, and containment is free, so EVERY milestone of a project a link names has hops 1 while only the project itself (or the milestone the link names) is a ghost row; a hop filter would hide the chain's members or list a ghost twice. A ghost the server does not list (downstream-only, unconnected) reads "—" in the Slack column (with the visually hidden "not upstream of this project's end") and is not emphasised.
- **The Slack column** (`project.column.slack`, present only while on, before the actions column): an own row reads "0" plus a visually hidden "critical path" when `critical`, else "{{count}} working days" (blank while `slackDays` is null: an optimistic move of a tray milestone, until the refetch); a ghost row the neighbour's slack from `upstream`; the summary row blank.
- **The Dependencies table** gains a gray "Critical path" `Badge` beside the status badge of a `critical` link (never colour alone) and a **Slack** column of the link's own `check.slackDays` (`SlackCell`; "—" while an end is unscheduled, a negative figure for a violated link).
- **The team page.** The same toggle (ONE remembered `timeline.criticalPath`, `useCriticalPathPick`/`CriticalPathToggle`) in the team timeline's `toolbar`; while on: the Slack column (the same `SlackCell`, after Flags), `emphasis: "critical"` on the milestones the server marked `critical`, and `markCriticalArrows` (`utils/dependencyArrows.ts`, also behind `arrowSpecs`) on the critical links' arrows. The figures are per milestone toward its OWN project's end and only links between this timeline's rows are drawn (no ghost rows, no Critical chain section): a note under the title says so.
  Off, the DOM is unchanged. **Known limitation:** the critical ARROWS (`markCriticalArrows`) have no non-visual equivalent on the team page - the Slack column and the bar's accessible description carry the per-milestone fact, a link's own criticality is visual only.
- **The programs page** is a third reader, of the roadmap's project-level block (`GET /views/programs?criticalPath=N`): the emphasis lands on the row that stands for each chain project, a folded program or work stream included ("The programs page's use" above).
- **The Critical chain section** (`components/CriticalChain.tsx`, h3, mounted between the Dependencies and Idle gaps sections while on):
  `chainEntries(view)` = the server's `upstream` MINUS the ghost-row ends (matched by kind + id), in the server's order, split into **On the chain** (the critical ones, a table: hops, the name as a `RouterLink` into its project with the `project.ghostLinkAria` name, kind, project, dates, slack; "None: the chain lies inside this project." when no critical upstream entry exists at all, "No further members beyond the neighbours shown on the timeline." when every critical one is a ghost row) and **Upstream with slack** (behind a `TableDisclosure`; "None." when empty).
  When the server cut the non-critical list (`upstreamTruncated`) a note says how many were sent ("Showing the N entries with the least slack; more are not shown." - the server reports no total, so the note states the count of rows LISTED - ghost rows excluded - not a remainder; with none listed it just says more are not shown). Members two or more hops away are listed only, never drawn: a ghost row per chain member would multiply rows, widen the range and need arrows between external rows.
- **The range** still follows the dependencies' ends only; an upstream entry that is not a ghost row is not on the timeline, so it adds no days.
- **Optimistic updates keep** `slackDays`, `critical` and `criticalPath` as the cache had them (like `idleGaps`); the refetch after the write brings the server's. A moved bar may therefore carry a stale outline for a round trip.
- **Tests.** `utils/projectDependencies.test.ts` (the lookups, the ghost subtraction), `CriticalChain.test.tsx`, `Timeline.test.tsx` (toolbar slot, `data-critical` on bars and arrows, the third marker), `ProjectView.test.tsx` ("the critical path": toggle and persistence, Slack column, ghost slack, badge, heading outline, chain groups, truncation note, off = unchanged DOM). The real-browser path is the e2e.

### The proposal preview

The team page previews the server's schedule proposal (`POST /teams/{id}/schedule-proposal`, `planning-model.md` "The auto-proposal") on the same `TeamTimeline`, through its optional `proposal?: {moves, weeks}` prop (`TeamProposalView`, `utils/scheduleProposal.ts`). Without the prop nothing changes (pinned by `TeamTimeline.test.tsx`). The server decides every date and figure; the client only draws them.

- **The tone.** `TimelineBarData.tone: "proposal"`: a HOLLOW bar (transparent fill) with a 2 px DASHED outline in the text colour (`.timelineBarProposal`, `data-tone="proposal"`). It differs from `summary` (solid outline), `ghost` (a faint filled bar with a thin dashed border) and the `critical` emphasis (an outline AROUND a filled bar) by the fill and the dash together, and adds no hue: the brand cyan stays the held bar's. Read-only like every tone but `window`: an editable bar ignores it.
  Its name is the page's `describe` (`timeline.bar.proposal`, "Proposed: {{name}}, {{start}} to {{end}}", plus the component's ", read-only").
- **Two bars per row.** Every moved milestone that has a row gets a SECOND bar after its current one (`id: "proposal:<milestoneId>"`, `start`/`end` = the move's `to`), the roadmap's two-bars-per-row precedent. Where the spans overlap, the proposal bar (mounted last) paints over the current one and the current bar shows through its hollow middle. A milestone the proposal leaves where it is (`unchanged`) gets no second bar.
- **Appended rows.** A tray milestone the proposal schedules (`proposalRows`) gets a row APPENDED after the scheduled rows, in the tray's (effective) order: the proposal bar only, a dimmed "(new)" after its name, a menu with just "Open project". The rows of the current schedule keep their places. A move whose milestone has no row and is not in the tray (it left the team meanwhile) draws nothing.
- **The strip** renders `proposal.weeks` (the load AFTER accepting every move, the team view's own row shape) under the caption "Proposed load" (`timeline.strip.proposedLabel`); the weekly table below stays the CURRENT schedule's. The weeks follow the TICKED moves: the server's check answers them while only some are ticked (`useScheduleCheck`, `overlayCheck`, `web-internals.md` "Teams and the team page"), and with none ticked the strip keeps the current load (`proposal.weeks` absent, so `proposal?.weeks ?? view.weeks`).
- **Read-only.** While previewing, the current bars are `editable: false` (images, no handles), the row handles are gone, the row menu keeps only "Open project", the tray's Schedule buttons are disabled (`TrayItem.disabled`: no drag handle either), Reset order and the capacity Add/Edit/Delete are hidden, and the **idle bands are not drawn** (they describe the current schedule and would be wrong under a proposed one).
  The lock starts when the proposal is REQUESTED, not when it opens (`hooks/useProposalLock.ts`): every entry point (row menu, tray Schedule, the schedule dialog, drags, Reset) refuses out loud while the request runs or the preview is open, an open schedule dialog, Reset confirm or capacity editor is closed and does not come back after Discard, and the focus moves to Discard on open and back to Propose on discard. Dependency arrows stay on the current bars; none ends on a proposal bar (`BACKLOG.md`: arrows between proposed bars).
- **Range.** The page's grow-only range also covers every proposed span (`proposalDays`), so no proposed bar or strip week lies outside it.
- **Accessible surface.** The bars and the strip are decoration plus `describe`; the Proposed schedule section (`components/TeamProposal.tsx` around `components/ProposalTable.tsx`: summary line, link badges, the table of moves, the unplaced rows) carries the facts. Pure derivations and their tests: `utils/scheduleProposal.ts` (`proposalBars`, `proposalRows`, `proposalDays`, `changeSentence`, `noteOf`, `acceptItems`, `outcomeSentence`). Tests: `Timeline.test.tsx` ("bar tones"), `TeamTimeline.test.tsx`, `TeamDetails.proposal.test.tsx`.

### The baseline overlay

Every timeline page can compare itself with ONE baseline (a named, frozen copy of the plan; `planning-model.md` "Baselines"): the project, team, roadmap and programs pages read the server's `?baseline=N` overlay and draw it. The server decides every date and every working-day figure on the CURRENT calendar; the client only draws and phrases them (`utils/baselineOverlay.ts`, pure). Without a pick nothing is drawn or rendered extra (the documents are exactly the plain views, pinned by the pages' tests).

#### The pick and the query keys

- **The pick.** `hooks/useBaselinePick.ts`: ONE browser-remembered id under `timeline.baseline` (`useStoredState`, so best-effort without `localStorage`), shared by the four pages like `timeline.zoom`; **no baseline by default**.
  The picker (`components/BaselinePicker.tsx`) is a labelled `Select` in the `toolbar` slot (after Today; beside the Critical path toggle on the project page): "None" and the baselines newest first, the first marked "(latest)"; disabled with a muted "could not be loaded" line while the list (`useBaselines`, a separate cached query) failed, and disabled by the page while a write is in flight or a proposal is open (a pick changed then would make the write's answer land in another view entry).
  A pick the list does not hold (still loading, just deleted) stays an option of its own ("Baseline <id>", or the loaded view's name for it): the field never shows a value that is not among the options. The page sends the stored id straight away; the **typed 400 `unknown-baseline`** (`isUnknownBaseline`) clears the pick (`useDropUnknownPick`; it re-reads the stored value first and writes `null` only if it still is the deleted id - another tab's newer pick is adopted) and the key change fetches the plain view - no loop, no flash of the error.
  A failure that is not that 400 leaves the pick and offers "Show without a baseline" (`PickedLoadState` / `ShowWithoutBaseline`), since a page without its view has no picker.
- **Query keys carry the pick**: `["plan","project",id,{baseline}]`, `["plan","team",id,{baseline}]`, `["roadmap","view",{baseline,criticalPath}]` (the roadmap's critical-path target), `["roadmap","programs",{baseline,criticalPath}]` (the programs page's critical-path target); all sit under the prefixes every mutation refreshes.
  The optimistic steps and their rollbacks (`applySchedule`, `applyTeamSchedule`, `applyTeamOrder`, the ranking, the window steps) spread the view, so the cached `baseline` block is KEPT untouched like `idleGaps` (the refetch brings the new movement); the write hooks take the pick so a step always hits the entry the page shows.
  `keepPreviousData` keeps the page mounted - and the picker focused - while another pick loads; that placeholder is read WITHOUT any overlay (`withoutStaleOverlay` clears every nested `baseline` block: the top-level one and, on the roadmap and programs views, the project rows and the program and work stream nodes), so an old pick's bars never show under the new pick's name.
  **Writes and the pick**: a change is REFUSED out loud while the shown copy is the placeholder (`placeholder` of the schedule path and the ranking, `loading` of the order, window and proposal paths: the same "try again" note and sentence as a change made during a save); a rollback goes back to the entry the change was made on (the key travels with the mutation); a success stores the answered revision (the plan revision of a schedule or pin, the order revision, the ranking's) into the entry the change was made on ONLY (the key travels with the mutation):
  a sibling pick's entry still holds the OLD order and dates, so it keeps the old revision and a write made from it before its invalidated refetch lands is a stale 409, never an accepted revert (`useRoadmapRanking.test.tsx`, `teamWriteSiblings.test.tsx`).
  The proposal's accept follows the same rule (`useScheduleProposal` takes the pick and captures the entry at accept time): the accepted dates AND the answered revision go into the entry it was made on only; sibling entries are left untouched (no dates, no revision) and the invalidated refetch brings them right (`teamWriteSiblings.test.tsx`).

#### The tone and the rows

- **The tone.** `TimelineBarData.tone: "baseline"` (`data-tone="baseline"`): a SHADOW bar, 5 px tall along the bottom of the 36 px row (`top: 30px`, under the 24 px bar that sits at 6..30 px; the wrapper class `timelineBarFrameBaseline`, the window tone's frame precedent), a solid fill in the dimmed arrow ink `--timeline-arrow`, square corners, no outline, no hue; read-only (`role="img"`, one roving stop, no handles) and pointer-transparent (`timelineBarInert`), so the roadmap's draw surface stays reachable.
  Its focus ring is the grid's (`.timelineBarBody:focus-visible`, a 2 px inset outline in the accent ink): on the 5 px bar the ring fills it, so the focused shadow turns cyan against its gray (checked in both schemes; no tone-specific ring). It differs from `proposal` (hollow, dashed, full height), `ghost` (faint, full height) and `summary` (hollow outline) by height and fill. Arrows never end on it. Its name is `timeline.bar.baseline` "Baseline: {{name}}, {{start}} to {{end}}" plus the movement sentence when the row moved. It coexists with a proposal preview (three bars in a row).
- **Project and team pages.** A milestone row the baseline had scheduled gets its shadow bar (`baseline:<milestoneId>`, after the current bar and a proposal bar); a milestone the baseline did not freeze reads "(new since the baseline)" after its name.
  **Appended rows** (`removedRows`, ids `baseline-removed:<milestoneId>`) come after the current rows (the team page: before a preview's rows), in (start, end, name) order: the baseline's milestones that are gone from the view (deleted - "(removed)"; on the team page also moved to another team - "(moved to {team})") and the tray milestones it had scheduled ("(unscheduled since the baseline)"), dimmed, the shadow bar only (an "unscheduled" row whose milestone Jira dates also carries that milestone's dashed Jira bar), a menu with "Open project" only (none on the project page).
  A frozen milestone with no dates has nothing to draw and no row (the Movement table lists it). **Range**: the page's grow-only range also covers every frozen span (`baselineDays`). The project page's facts line says how the project's own span moved ("Ends 3 working days later than the baseline", ORANGE exactly when the END is later, a gray start figure; "new since the baseline" for a project newer than the baseline).
- **Movement section** (`components/BaselineMovement.tsx`, h3 "Movement vs baseline {name}", after Idle gaps on both pages): the ACCESSIBLE surface of the bars.
  The totals badges first (`movementTotalsOf`, ORANGE for the milestones whose end is later), then a `TableDisclosure` over a Milestone (/ Project on the team page) / Baseline / Current / Start / End / Estimate ("10 → 12.5") / Status table in working days, positive = later; **"Changed only"** is on by default and an estimate-only change counts as changed (`rowChanged`, status "Re-estimated"); a milestone that moved teams reads "Moved to {team}". Status badges are the comparison page's (`movementStatus`).

#### Roadmap and programs

- **Rows and totals.** `planTrack.projectTrack` adds the shadow bar `baseline:<projectId>` from the row's `baseline.span`; the programs page adds one on work stream and program rows (`baseline.span`; a work stream the program pick shows in part is rolled up over the programs that remain, without a movement sentence). One totals line (`components/BaselineTotals.tsx`, `role="note"`: "vs baseline X: 14 end later, 3 end earlier, 2 new, 1 removed" - projects, `projectTotals`; both pages count the view's `removedProjects`).
  The flag panel and the filters are untouched; the range covers every frozen project span, the removed projects' too (`removedProjectDays`).
  - **Appended rows for the removed projects.** `removedProjectRows` (`utils/baselineOverlay.ts`, beside `removedRows`) turns `baseline.removedProjects` into rows `baseline-removed-project:<projectId>` (the shadow bar `baseline:<projectId>` from the frozen span, (start, end, name, id) order); a removed project with no frozen span gets no row. The row is dimmed with the shared "(removed)" mark (`BaselineRowName`), the bar only, empty flag and menu cells, "program · work stream" as its title, nothing editable.
    **Roadmap**: after EVERY current row (after the unranked block, no divider), rank cell "—"; `visibleRemoved` (`utils/roadmapRows.ts`) keeps those the work stream filter and the program pick leave (the frozen ids are compared) and hides ALL of them while a team, owner or flagged-only filter is on (a deleted project's teams, owner and flags are not known: a row the filter might exclude is never shown).
    **Programs**: under its live, shown, EXPANDED program after that program's projects (`treeRows`' `removedProject` kind, `programId` the frozen one); the rows count as the program's children (`childCount`, `allOpen`), so a program whose live projects are all deleted still has its chevron; one whose program is gone, hidden by the pick or folded draws nothing - the totals line and the comparison page still list it. **Empty state** (roadmap): the "no match" state shows only when no live row AND no removed row is visible. Arrows never end on these rows.
- **Rank movement.** The roadmap's rank cell (`RoadmapTimeline.tsx` `RankCell`) adds a dimmed "(was 3)" / "(was unranked)" from the row's frozen `baseline.rankPosition` when it differs, behind one `VisuallyHidden` sentence, and the totals note appends `rankTotals`; the programs page has no rank column and draws none.
- **Accessibility checks.** axe (WCAG 2.0/2.1 A and AA) finds nothing on the four pages with the overlay on, light and dark. The sample plan's own 22 px row-menu buttons fail WCAG 2.2's target-size with and without a pick (the repo's axe tags stop at 2.1). Figures: "Measured figures".
- **Tests.** `Timeline.test.tsx` ("bar tones"), `TeamTimeline.test.tsx`, `ProjectView.baseline.test.tsx`, `TeamDetails.baseline.test.tsx`, `Roadmap.baseline.test.tsx`, `Programs.baseline.test.tsx`, `BaselineMovement.test.tsx`, `BaselinePicker.test.tsx`, `useBaselinePick.test.tsx`, `baselineOverlay.test.ts`, the update helpers' "keeps the baseline" tests.

### The Jira markers

The four timeline views carry, per row, what an external tracker says about it; the shared Timeline draws it as a dashed outline bar and the pages as flags (the chips and bindings: "Deviations, bindings and the Jira chips" in `web-internals.md`).

#### The server half

A document contract; nothing is drawn from the server's side.
- `jira: {bindingId, connectionId, issueKey, start, end}|null` on a project row (roadmap, programs, `ProjectView.project`) and on a milestone row (project and team views; scheduled and unscheduled alike).
- `flags[]` (the Jira kinds, `planning-model.md` "The roadmap view") on the same rows.
- `jiraSites[{connectionId, siteUrl, state, mappingOk}]` ONCE per document, so a row never carries a URL (the client builds `siteUrl + "/browse/" + issueKey`).
  - `state` is the connection's derived sync state (`NEVER_SYNCED | CURRENT | STALE | FAILED | DISABLED`): the very value `GET /views/deviations` answers in `connections[].status.state`, derived inside the view's snapshot against the Deviations service's clock by the same step. `mappingOk` is the Deviations view's member of the same name (the effective mapping resolves against the stored discovery now).
  - 33 to 41 B a site and one or two sites a document. The site list is the connections the document's ROWS link through, so a plan with no binding sends none and reads no `sync_runs`.
  - The chips turn the two members into "may be out of date", and the roadmap's and programs' facts line says it once for the whole document.
- `jira`, `flags` and `jiraSites` are always present (`null` / `[]` when there is nothing). Inside a flag only `kind` and `severity` are always present; every other member is ABSENT when it does not apply (`days`, `teamId`, `otherProjectId`, `deviation`, `count`).
  - A flag's `deviation` is `{kind, detail}` (the severity is the flag's own, not repeated) and a `detail`'s null members (`jira`, `plan`, `days`, `count`) are absent too (the same on the lines of `GET /views/deviations`).
  - `jira.rollup` and the link's dates stay as they are, always present. The baseline overlay only adds its own keys.
- `jira.rollup` is the sixth member of the link, always present: a milestone's epic's children as the last census holds them (`{children, done, points|null, observedAt}`, the very figure the Deviations page serves as `jira.rollup`, from the same loader; one bounded statement per view fold). It is null on a project link, through a DISABLED connection, beside a `gone` issue and for an epic with no mirrored child.
- `jira.start` and `jira.end` are the dates Jira was LAST OBSERVED to hold, null when never observed, absent in Jira or the item is `gone`: a client draws a dashed bar only when both are set.
- A binding through a DISABLED connection keeps its `jira` link and its site but with null dates, no flag and no roll-up contribution (no bar; the node still reads as linked, so the page can show and unlink the binding and never offers a second link).
- A fully acknowledged binding keeps its bar and loses its flags; a binding raises one flag per OPEN line, so a partly acknowledged one keeps the flags of its open lines.
- Unscheduled milestones with Jira dates (the tray) carry the link and the flag; the page gives them an appended timeline row ("Appended rows for the tray" below).
- The roadmap raises ONE `JIRA_MILESTONES` roll-up per project (`count`, worst severity), never a flag per milestone.
- The roll-up and the flags cost no statement per binding: the Jira source sends the same `LOADER_STATEMENTS` (12, `IN (...)` reads over the bound ids) for the whole plan and for one project, plus one indexed `sync_runs` read per referenced site, so an N+1 fails `JiraFlagsScaleTest`.

#### The tone

`TimelineBarData.tone: "jira"` (`data-tone="jira"`).
- A 5 px dashed OUTLINE along the TOP of the 36 px row (`top: 1px`; the wrapper class `timelineBarFrameJira`, the baseline shadow's mirror image), hollow, a 1 px dashed border in the dimmed arrow ink `--timeline-arrow` (`var(--mantine-color-dimmed)`, which Mantine resolves per scheme), square corners.
- Read-only (`role="img"`, one roving stop, no handles, `timelineBarInert` so the draw surface stays reachable); an editable bar ignores the tone like every read-only tone.
- It differs from `baseline` (solid, bottom), `proposal` (2 px dashed, full height) and `summary` (solid outline, full height) by position and fill, and coexists with the baseline and the proposal bar in one row (up to four bars: window, span, baseline or proposal, jira).
- Its name is `timeline.bar.jira` "Jira {{key}}: {{start}} to {{end}}" (PL "od … do …") plus, when the row has open DATE deviations (`START_DIFFERS`, `END_DIFFERS`, `TARGET_DIFFERS`), their `utils/deviations.ts` sentences after a comma; the component appends ", read-only". The focused 5 px bar shows the grid's 2 px accent ring like the baseline's.

#### The window, the builder and the toggle

- **The Jira window.** `jiraWindow(planDates, today)` (`utils/jiraBars.ts`): the page's OWN dates (spans, windows, frozen spans; no Jira date) from the earliest to the latest, padded by 365 days each side, or today +/- 365 days when the plan has none.
  - `visibleJiraDates(link, window)` is what a link contributes: BOTH dates or nothing (a one-date link neither draws nor widens), each cut at the window's edge, and nothing when the whole range lies outside it.
  - The page's range follows exactly those days (`datesOf(view, window)` / `treeDates(view, window)`, via `jiraRangeDates`), so a Jira end of 2206 draws a bar cut at the window's edge, never a 200,000 px track; a bar wholly outside is not drawn. The bar's accessible name keeps the REAL Jira dates.
- **The builder.** `jiraBar(key, name, link, flags, window, t)` (`utils/jiraBars.ts`): `undefined` unless the link carries BOTH dates inside the window; id `jira:<node id>`; `flags` is the row's own `flags[]` (the roadmap's `project.flags`; the project and team pages pass the milestone's).
  - `siteUrls(jiraSites)` maps `connectionId -> siteUrl` for the browse link; no URL is ever assumed per row (`JiraKeyLink` builds `siteUrl + "/browse/" + key` and renders plain text for a site that is not `https://`).
- **The toggle.** `hooks/useJiraBarsPick.ts` (`{shown, setShown}`, the `useBaselinePick` shape): ONE browser-remembered boolean `timeline.jiraBars`, **on by default** (the user's answer; nothing is written until the user chooses), shared by all four timeline pages.
  - `components/JiraBarsToggle.tsx` is the Critical-path toggle's control (`Button` `compact-sm`, `aria-pressed`, filled while on) labelled "Jira dates" (`timeline.jiraToggle`), in the `toolbar` slot AFTER the baseline picker. It is rendered only when the view lists a Jira site (`jiraSites.length > 0`; an install without Jira has no toggle, and the stored choice is left untouched).
  - A page passes the window (`null` while the bars are hidden) down to its row builder, and the Jira days join the grow-only range only while the bars are shown (a page with them hidden keeps the range it always had; the range never shrinks when the toggle is turned off).

#### The pages

- **Roadmap and programs.** `planTrack.projectTrack(project, t, conflicts, jira)` appends `jira:<projectId>` from `project.jira.start/end` after the span and baseline bars when the toggle is on and both dates are known (a project with no span still draws it). Work stream and program rows never carry one (program-level bindings are not folded). The Flags cells' icons and the programs tree's roll-up counts are unchanged (severity-driven; a Jira flag counts like any other).
  - The roadmap's flag panel (`RoadmapFlagPanel`) phrases `JIRA_DEVIATION` as "Jira {{key}}: " + `deviationSentence(flag.deviation)` (the Deviations page's wording, working days; the sentence keeps its capital: "Jira E2E-6: Ends 3 working days later than Jira (plan …, Jira …)") followed by an icon-only `JiraKeyLink` through the view's `jiraSites`.
  - `JIRA_MILESTONES` reads "{{count}} milestones deviate from Jira" (EN/PL plurals, no link: it names no one issue); a deviation without its evidence degrades to "Jira {{key}}: Differs from Jira". "Show in timeline" is unchanged.
- **The project and team pages.** Everything is read from the page's own VIEW: no second request.
  - Each SCHEDULED milestone row with a `jira` link gets the shadow bar `jira:<milestoneId>` (`jiraBar(milestone.id, name, milestone.jira, milestone.flags, window, t)`, appended after the row's own bar, the proposal bar and the baseline shadow) while the toggle is on.
  - The page's range follows `jiraPageRange(shown, planDates, view.scheduled, today)` (`utils/jiraBars.ts`: the window - `null` while the toggle is off - and the plan's own dates plus the in-window Jira dates), `planDates` being what the page already followed (milestones, target window, link ends on the project page, proposal spans, frozen spans).
  - The toggle sits in the `toolbar` slot after the Critical-path toggle (project) or the baseline picker (team), rendered only when the view's `jiraSites` is non-empty.
  - A **Flags** column (`roadmap.column.flags`, 130 px, 210 px when a roll-up is shown, before Slack and Operations) exists while some SCHEDULED milestone has a `jira` link OR a flag (the calendar's `NO_WORKING_DAY`, an unlinked row's only flag); the view says so, nothing is remembered.
  - Its cell (`MilestoneFlags`) is the row's Jira key as an external link (`JiraKeyLink`, out of the tab order, the site from `jiraSites`, https only) beside the roadmap's icon (`FlagCountsCell`: an orange triangle and/or a gray info circle with counts, `data-flags`) whose label is each flag's sentence behind the key (`milestoneFlagLabel`, joined by semicolons).
  - A linked row with no open flag reads "Linked to Jira: KEY" for assistive technology; an unlinked row with no flag, a ghost, summary or baseline row has an empty cell, and Operations stays the last cell.
  - A **tray row** has no column: the key and the icon sit beside the name (`NameWithFlags`) and, while the row carries an open `UNSCHEDULED_IN_PLAN` flag and its link has both dates, the name cell reads "Jira: start to end" (`jiraTrayNote`, `timeline.jiraTrayNote`; an acknowledged line has no flag, so no note). Its timeline row is the appended row below.

#### Appended rows for the tray

While the "Jira dates" toggle is on, an UNSCHEDULED milestone whose link carries both dates inside the page's Jira window (`visibleJiraDates !== null`, the scheduled rows' rule: an acknowledged deviation keeps its bar) has its dashed bar drawn on the project and team timelines.
- It is the very `jiraBar(...)`, id `jira:<milestoneId>` (unique: a tray milestone is in no scheduled row), built by the pure `jiraTrayBars` (`utils/jiraBars.ts`; `window` null = none). ONE bar per milestone, placed by `jiraTrayRows`' `taken` set:

  | The tray milestone | Its Jira bar goes |
  |---|---|
  | has an appended baseline row (`reason: "unscheduled"`: a baseline is picked and had it scheduled; `baselineUnscheduledIds`) | on THAT row, after the shadow bar; the row keeps its id `baseline-removed:<id>` and its "(unscheduled since the baseline)" mark |
  | otherwise | on a row of its own, id `jira-unscheduled:<milestoneId>` (`jiraTrayRowId`) |

- Rows of their own come after the baseline's appended rows and before the project page's ghost rows and the team page's preview rows, in (drawn start, drawn end, name case-insensitively, id) order.
- The row is the baseline idiom: the name dimmed with the mark `timeline.jiraUnscheduledMark` "(unscheduled; dates from Jira)" (`AppendedRowName`, shared with `BaselineRowName`), team (project page) or project (team page) and estimate dimmed, the bar only, empty Flags and Slack cells (whether the Flags column exists is still decided by the SCHEDULED rows).
  - No menu on the project page, and "Open project" only on the team page (`OpenProjectMenu`), for a caller who may not schedule it; a caller who may gets the row menu below.
  - Never editable, draggable or an arrow end (the arrow builders name scheduled milestone ids).
- The team page's proposal-preview rows are untouched: a tray milestone a preview schedules keeps its Jira row and its preview row (two rows).
- **Range:** both pages pass `[...view.scheduled, ...view.unscheduled]` to `jiraPageRange`, so the grow-only range follows the tray's in-window Jira dates while the toggle is on, never a date outside the window.
- **Scheduling** is the tray's (drag, Schedule) or the row's menu: the cell holds "Operations for {{name}} (dates from Jira)" (`JiraRowMenu`, named apart from the tray row's kebab) with one item, "Schedule on Jira's dates".
  - It is offered only where the view's `can` allows scheduling that milestone (the milestone's own `can.schedule` on the project page, `team.can.schedule` and no proposal preview on the team page, whose menu then also keeps "Open project" after a divider) and only while Jira's two dates are in order (`jiraScheduleDates`).
  - The click writes the link's REAL dates (never the bar's, which may be cut at the window) through the page's one write path (`schedule.commit`, announced, refused out loud while a save runs, the server's 400/409/403 as the page's usual notices).
  - The focus goes to the milestone's own row (`useRowMenuFocus`, `Timeline`'s `focusRow`) because the dashed row and its kebab leave with the optimistic step; once scheduled the view moves the milestone to a normal row, which carries the same bar.
- The accessible surface is the bar's own name ("Jira KEY: start to end, read-only") and the tray row (key link, flag icon, the "Jira: start to end" note).

#### Pinned by

`Timeline.test.tsx` ("bar tones": the jira frame, the three-tone row, the editable bar ignoring it), `planTrack.test.ts`, `jiraBars.test.ts` (the window, the cut, `jiraPageRange`, the tray bars and rows), `flagSentences.test.ts`, `useJiraBarsPick.test.tsx`, `JiraBarsToggle.test.tsx`, `Roadmap.jira.test.tsx`, `Programs.jira.test.tsx`, `ProjectView.jira.test.tsx`, `TeamDetails.jira.test.tsx`, the `datesOf` / `treeDates` cases.

### The Flow capacity marker

The team view alone carries what Flow says about the team's capacity: `team.flags[]` (the header's ONE `FLOW_CAPACITY` roll-up: `count` open rows, the worst severity) and `weeks[].flowCapacity` (`WARNING` | `INFO`, the weeks strip's per-week mark, absent when unmarked).

#### The server half

A document contract (the rules: `flow-sync.md` "Deviations"; the seam: `planning-model.md` "The roadmap view").
- An open row marks every ISO week its held days `[effectiveFrom, end]` touch: a sprint crossing a weekend marks both weeks, a Saturday `effectiveFrom` marks the week it falls in, the worst severity wins a shared week.
- Nothing is marked for a disabled connection, an acknowledged row or a team with nothing scheduled.
- The cost on a linked team is six reads inside the view's snapshot (the connections select, the binding, the team's periods, the mirror's team and sprints, the stored acknowledgements and the acknowledging logins' names) plus the pure kernel over at most the team's sprints.
- **The project rows.** The Roadmap and Programs project rows carry ONE `FLOW_CAPACITY_MILESTONES` flag per team whose open difference covers days of one of the project's scheduled milestones (`count` = those milestones; the rules and the five-statement read: `planning-model.md` "The roadmap view", `flow-sync.md` "The project rows' flag"). The counts cells, the facts lines and the filters count it like any flag, and Home's figures move with it.
- `TimelineJiraFlagsTest` and `JiraFlagsScaleTest` pin that the other three views stay byte-identical and the team view's byte gate holds.

#### The web half

Read from the view, no second request, no mapping layer.
- `LoadWeek.flowCapacity?` (`utils/timelineLoad.ts`) becomes `StripCell.flowCapacity` (`null` = unmarked). `TimelineLoadStrip` puts `data-flow-capacity="WARNING|INFO"` on the cell (absent when unmarked) and a decorative mark `data-part="flow-capacity"` (+ `data-severity`) in its top-left corner, the WIP chip's mirror (top-right).
- **A shape per severity, never a hue alone:** `timelineStripFlowWarning` a solid triangle in `--timeline-overload`, `timelineStripFlowInfo` a hollow ring in `--timeline-arrow` (the two inks the strip already clears at >= 3:1 non-text). The cell's `title` appends "; capacity differs from Flow for this week's sprint" (`timeline.strip.flowCapacity`). It coexists with the overload column and the WIP chip.
- Decorative like the rest of the strip: the accessible surfaces are the header's flag (`PageHeader`'s `titleAddon`, `TeamPageHeader`'s `TeamFlags` badge) and the Weekly load table's "Differs from Flow" badge (`data-flow-badge`; `data-flow-capacity` means the strip cell only; `web-internals.md` "Teams and the team page").
- The marks follow the CURRENT plan: a proposal preview's strip draws the proposal's weeks, which carry none, while the header flag and the Weekly load table keep reading `view.weeks`.
- The project rows: `flagSentence` words the flag through `names.team`, and the Roadmap's Flags section adds an icon-only link "Open team {{name}}" (`teams.openAria`) beside the sentence, to the team's page where the sprints are (none when the document does not name the team).
  - The Programs page has no flag list, so its project, program and work stream rows show only the server's counts.
  - No Flow staleness note is shown beside the flag (the documents carry no Flow connection state).
- Tests read `data-*`, never colour.

## Print and export

Deferred: nothing timeline-specific; `hooks/usePrintLifecycle.ts` and `print.css` apply as they do to any page (a `BACKLOG.md` line at release).

## Tests

`utils/timelineScale.test.ts`, `utils/timelineDrag.test.ts`, `utils/timelineLoad.test.ts` and `components/TimelineLoadStrip.test.tsx` (the strip's cells, figures and marks per zoom; `Timeline.test.tsx` "the load strip" pins the header-height consumers with and without a strip), `utils/timelineArrows.test.ts` (pure, table-driven: every route shape per type, the backtrack above and below, the mounted-rows filter, missing rows/bars; the Timeline suite adds the tones and the arrows through the overlay, plain and virtual, and the committed-dates rule);
`hooks/useRovingGrid.test.tsx` (vertical fallback, ragged rows); `components/Timeline.test.tsx` (bars at their computed `left`/`width`, read-only rows, bands, the overlay geometry, the `track` slot, roving navigation,
the `zooms` prop and the Year header, the window tone, the draw gesture and `focusRow` (plain and virtual path), every drop outcome through the wrapped `DndContext` — happy-dom has no layout, so the handlers are fed events —, the announcements, the keyboard sensor end to end, the virtual window with `virtualizeFrom = 5` and a stubbed viewport (`clientHeight`), scroll-then-focus, the tray). The real pointer drag, the resize handles, the tray
drop under a scrolled grid and the keyboard sensor under a real layout are `e2e/tests/project-view.spec.ts` — those scenarios own them (and they found the autoscroll zone above).

## Measured figures

One-off and NON-BINDING: this machine (an Apple-silicon laptop) unless a row says CI; re-measure rather than quote. A row holds the LATEST value of its metric and the version it was taken at; older runs are in Git.

Method, so a run can be repeated:
- **Browser:** headless Chromium 1440 x 900, the compose stack's production bundle, the sample plan (`sample-data/plan/`, loader in its `README.md`), signed in as the seed ADMIN (the team page as the team's manager), three fresh page loads, throwaway Playwright scripts (not committed).
  - Page ready = navigation start until the first bar is in the DOM; scroll = 600 frames of 108 px bouncing between the ends, the interval from `requestAnimationFrame` (60 Hz cap = 16.7 ms), scripting, task and layout time per frame from CDP `Performance.getMetrics`; DOM nodes = `document.querySelectorAll('*').length`.
  - The zoom is the `localStorage` key `astrolabe.viewSettings.timeline.zoom`; window focus = dispatching `visibilitychange` on the settled page and counting the `/api/` responses for 2.5 s.
- **A list page:** the view request's resource-timing `responseEnd` to the second animation frame after the last body row is in the DOM (a `MutationObserver` from `addInitScript`); long tasks from a `longtask` `PerformanceObserver` from navigation on; one warm-up load, then five timed loads, the median.
  - The 1.23 dependencies figure: one project with 46 milestones of one team (a Monday-to-Friday week each) and 1,000 Finish-to-Start links `i → j` over the pairs `i < j` written 8 at a time through the administrator's API context, a second login that owns nothing, the view asserted first (1,000 rows, all this run's own, none cut; `can` on every row for the administrator, on none for the other login).
- **The sample plan** is loaded with `node scripts/sample-plan/load.mjs --base-url <throwaway stack> --logins --reset --polish-holidays`, never against a stack that holds real data.
- **Server:** `curl -s -o /dev/null -w '%{time_total} %{size_download}'` over loopback with a bearer token, 2 warm-ups then 40 timed calls, p50 / p95 (transfer included, `Accept-Encoding: identity`; a second series with `--compressed` for the gzip size). Concurrency: `seq 20 | xargs -P20 curl`, 5 rounds. The app's log carries no per-request timing.
- **In-process:** `testApplication` against the Postgres container (`HomeViewSizeTest`, `JiraFlagsScaleTest`, `CrossTeamProposalSizeTest`, `TeamScheduleBatchHoldTimeTest`, the `*ScaleTest` kernels), one warm-up then five timed reads, the median; each prints `scale-figure` lines. Statements are counted below Exposed.

### The component, arrows and the project page

| Metric | Figure | At |
|---|---|---|
| One project, 1,000 milestones over 10 teams (week zoom): page ready | ~350 ms | 0.3 |
| Rows mounted / DOM nodes | 25-28 of 1,000 (18 visible + overscan 8) / 1,287-1,344 (the header's day cells are not virtualised) | 0.3 |
| Scroll p50 / p95 / max | 16.7 / 16.8 / 16.8 ms; scripting 4.1 ms, whole tasks 5.2 ms a frame | 0.3 |
| Keyboard | 150 x ↓ never left the grid; Ctrl+End lands on the last row; a pointer drag of that bar by two days: `PUT` 200 | 0.3 |
| Project page, 50 milestones + 200 links (70 rows, no virtualisation): DOM nodes / arrow paths | 5,577 / 200 | 0.4 |
| The arrows in the DOM after navigation start | 360-378 ms (95-110 ms after the view's response ended) | 0.4 |
| Scroll with the overlay on and off | p50 16.7, p95 16.7-16.8 ms either way; scripting 0.03-0.06 ms a frame, layout 0 | 0.4 |
| `arrowsToDraw`, 50 rows and 200 arrows (vitest + happy-dom, no layout) | median 0.24 ms; mounting the Timeline 15.8 ms without, 21.3 ms with the arrows | 0.4 |
| Critical path toggle (project pages): page ready off / on | 294-303 / 296-330 ms | 0.7 |
| Toggle redraw (no refetch, two frames) / DOM nodes off, on | 18-34 ms / 1,044-1,046, 1,087-1,090 | 0.7 |

### The team page

| Metric | Figure | At |
|---|---|---|
| Largest team (301 milestones, 268 scheduled rows, virtual path): page ready | 323-339 ms (the view's response 24-31 ms) | 0.5 |
| Rows mounted / track | 24-35 of 268 / 14,308 px wide (511 days at week zoom) | 0.5 |
| DOM nodes: at load / maximum over the scroll | 2,924 / 3,258 (Platform, week zoom) | 1.0.0 |
| Scroll p50 / p95 | 16.6-16.7 / 18.1-18.5 ms (max 21-24); scripting 5.5-6.0 ms, layout 0.2 ms a frame | 0.5 |
| A 67-row team (plain path): page ready / DOM nodes / scroll p95 | 324-336 ms / 3,246 / 18.2-18.5 ms | 0.5 |
| Move to bottom, `PUT` round trip | 18-22 ms for 268 ids | 0.5 |
| Row drag, first row to last slot through autoscroll | 7.6-8.5 s of held autoscroll (268 rows; 1.7-1.8 s for 67); `PUT` 200 33-40 ms after the release; the row is last after the refetch | 0.5 |
| Baseline picked (301 rows, 36 mounted): DOM nodes without / with the pick | 1,964 / 2,072 (+108: the 21 mounted shadow bars and their cells); scroll at the cap either way | 0.9 |
| The same with 18 appended rows: DOM nodes without / with | 2,926 / 3,009; the grid is 648 px taller | 0.9 |
| Window focus: requests per focus | 1 (`GET /views/team/{id}`, about 203 KB, 18 KB gzip); a `staleTime` is not justified (the rule: at most 2 requests, 300 KB) | 1.0.0 |

### The roadmap and programs pages, the baseline page and the lists

| Metric | Figure | At |
|---|---|---|
| `/roadmap` (101 rows, virtual path, Quarter zoom): page ready | 319-322 ms (view 23-28 ms) | 0.6 |
| Rows mounted / DOM nodes / track | 25-35 of 101 / 1,296-1,402 / 2,466 px (822 days at 3 px a day) | 0.6 |
| Scroll p50 / p95 | 16.6-16.7 / 18.1-18.3 ms; scripting 5.2-5.5 ms a frame | 0.6 |
| Month zoom / Year zoom: track, DOM nodes, page ready | 4,872 px, 1,474, 308 ms / 1,826 px, 1,391, 328 ms | 0.6 |
| `/programs`, default (25 rows, plain path): page ready / DOM nodes | 295-324 ms / 1,129 | 0.6 |
| `/programs`, Expand all (125 rows, virtual path): the expand / DOM nodes / scroll p95 | 41-62 ms to the 125 rows / 1,146-1,207 / 18.4-18.7 ms | 0.6 |
| Rank drag, first row to the last ranked slot (80 ranked) | 2.2-2.3 s of held autoscroll; `PUT` 200 29-34 ms after the release | 0.6 |
| Window drag (one project, 21 days later) | `PUT` 204 27-41 ms after the release | 0.6 |
| Roving grid at 102 rows (`/roadmap`): ↓ x 99 | no press stuck, focus never left the grid; Ctrl+Home on row 2, Ctrl+End on row 102 | 1.0.0 |
| Baseline comparison page `/baselines/{id}` (1,017 rows, no virtualisation) | 16,062 DOM nodes; the rows are in the DOM 168 ms after the response; scroll at the cap; switching "Changed projects only" off re-renders in 116-125 ms | 0.9 |
| Dependencies list at the 1,000-row cap, administrator (a menu on every row) / no rights: response to the second frame after the 1,000th row | 416.5 / 266.3 ms (the menus cost 150 ms against a stop line of 300 ms); DOM nodes 24,348 / 17,310 | 1.23 |
| The same: the rows alone (no menu), response to the 1,000th row in the DOM | about 205 ms, linear in the rows; the view's cap bounds it | 1.23 |
| A menu opened / "Edit…" dialog painted on the full page | 28.4 ms / 50.0 ms (memoised rows: no re-render of 1,000 rows) | 1.23 |

### The views the pages read (server side)

| View or step | Time p50 / p95 | Size, gzip | Gate or stop line | At |
|---|---|---|---|---|
| `GET /views/team/{id}`, Platform (301 milestones) | 28.2 / 42.7 ms | 198 KB, 18 KB (226,495 B, 15,245 B in the 304 test) | 20 concurrent: p50 155, p95 361 ms (recorded, not gated) | 1.0.0 |
| The same, every milestone bound, three flags a row, `?baseline=` (CI) | request median 114 ms | 367,729 B, 7,907 B | `TEAM_VIEW_GATE_BYTES` 400,000 B, gzip 40,000 B | 1.16 |
| The same read answered `304` | median 31.5-38.8 ms vs 37.5-40.3 ms for the `200` | body 0 B; the tag costs 0.1 ms | helper within 2 ms of `call.respond` | 1.22 |
| `GET /views/project/{id}`, the largest | 22.4 / 30.0 ms | 12.2 KB, 1.8 KB; bound with the overlay 12,616 B | budget p50 30 / p95 45 ms (0.8 budget, on the largest project); 40,000 B size gate (with the overlay) | 1.0.0, 1.16 |
| `GET /views/roadmap` / `/views/programs` | 20.6 / 26.1 ms, 20.1 / 23.5 ms | 81.1 KB, 7.9 KB; 83.3 KB, 8.2 KB | none | 1.0.0 |
| `GET /views/plan` | 5.1 / 10.1 ms | 36.6 KB, 3.8 KB | none | 1.0.0 |
| `GET /views/team-load`, the sample's 15 teams, 203 warning weeks | 20.8 ms; exactly 6 statements | 27,928 B, 2,557 B (about 123 B a listed week) | 42,000 B | 1.22 |
| `GET /views/dependencies`, 300 links | 13.2-16.4 ms; exactly 5 statements | 117,984 B, 11,020 B (about 360 B a row; 1,000 rows about 340 KB) | 170,000 B | 1.22 |
| `POST …/schedule-proposal`, Platform (275 moves) | 43.3 / 54.3 ms | 85.5 KB, 9.6 KB | p50 80, p95 120 ms, 150 KB | 1.0.0 |
| `POST …/milestone-schedules`, 275 items | warm p50 36.5 / p95 37.7 ms (first call 63 ms) | | p50 60 ms warm | 0.9 |
| The same, 1,000 items with a token whose holidays changed (the look-again) | about 160 ms (plain batch 121-201 ms) | | median ≤ 5,000 ms (plan-lock hold, `TeamScheduleBatchHoldTimeTest`, `MAX_BATCH_SCHEDULE_ITEMS`) | 1.13.1 |
| The cross-team run, 15 teams (kernel; response) | 285-318 ms, 4 passes; the accept's hold not measured | 472,470 B | 600,000 B; median ≤ 20,000 ms (`ScheduleKernelsScaleTest` CROSS_TRIPWIRE_MS) | 1.8 |
| Baseline overlay reads (`EXPLAIN (ANALYZE, BUFFERS)` through `psql`) | index scans only: the header and the by-id read by primary key, `baseline_projects` and `baseline_milestones` by `(baseline_id, …)`, the team's rows by `idx_baseline_milestones_team`; none under 0.1 ms; no index missing | | | 0.9 |
| `POST /baselines` (1,000 + 100 rows under the plan lock) | p50 61 ms | 129.4 KB stored per baseline | p50 150 ms, 250 KB | 0.9 |
| `GET /views/baseline/{id}` (920 changed milestone rows) | 36.8 / 38.3 ms | 320,765 B, 30,902 B | 340 KB, p50 40, p95 60 ms | 0.9 |
| Kernels at the cap (`LoadKernelsScaleTest`, `ScheduleKernelsScaleTest`): `weeklyLoad` 520 weeks x 300 items; `propose` 300 milestones | 10-12 ms; 70-79 ms | | median 2,000 ms; 5,000 ms | 1.0.0 |
| The Jira fold in the roadmap service, 1,100 bindings; the team service, 301 | +50 ms (about 45 µs a binding); +16 ms | | HTTP tripwire 1,000 ms | 1.4 |

What the numbers say: the plan pages are in the team page's class (ready in about 320 ms, a scroll frame at the 60 Hz cap) because rows virtualise and the track is short (2,466 px at Quarter against 14,308 px for the team page), so nothing calls for time-axis virtualisation (`BACKLOG.md`). A held autoscroll's duration is the pointer's cost, not a latency. The per-request fixed cost of about 16-20 ms on this machine dominates every small figure. A gate is revised only with its measurement in the same commit.

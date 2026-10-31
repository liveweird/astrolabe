### Timeline component (placeholder — to be written in v0.3)

Not built yet. The shared `Timeline*` component arrives with v0.3.0 (timeline + project view) and serves every Gantt-like page (project, team, roadmap, programs). This file records the
approach decided in the bootstrap plan; it is rewritten as the binding reference (props, coordinate model, interaction and keyboard contract, accessibility, performance figures) with the first
commit that adds the component.

## Approach

- **Rendering:** DOM rows, one per work item, with **SVG arrows** drawn over them for dependencies (v0.4). No canvas: DOM keeps focus order, accessibility and testing-library queries.
- **Time axis:** day-precision dates; zoom levels **week / month / quarter**; non-working days (Saturday/Sunday; holidays from v0.7) hatched; a today line.
- **Virtualisation:** **TanStack Virtual** for rows (1,000 milestones must not mean 1,000 mounted rows) and for the time axis when the span is wide.
- **Interaction:** **dnd-kit** for drag and resize of bars (and sortable lists elsewhere), with a **keyboard path for every pointer gesture** (move/resize by day with arrow keys, row
  navigation by roving focus — `hooks/useRovingGrid.ts` is already ported; the screen-reader announcements follow dnd-kit's accessibility layer, in EN and PL).
- **Authority:** the component only proposes a change; the server decides (`PUT /milestones/{id}/schedule` is team-manager/ADMIN only, `product.md`). A page asks the view endpoint for `can:{…}` flags and
  renders read-only bars where the caller has no right.
- **One component, many views:** the pages differ in rows and bar sources (milestones by project, by team, projects by rank, programs), not in the timeline mechanics.

## Prior art to port first

Flow's `DeepDiveMatrix.tsx`, `utils/deepDiveCalendar.ts` and `hooks/useRovingGrid.ts` (`~/Sources/flow/web/src/`): a keyboard-navigable day-grid and calendar maths. Port the shape, not the
report specifics (`product.md` "Donors").

## To write here in v0.3

The coordinate model (date ↔ pixel per zoom), the row/bar data contract, the drag/resize/keyboard contract and its announcements, the virtualisation window, the print/export story, the a11y
checks (axe, heading outline, focusable scroll regions per `web/CLAUDE.md`), and the measured render figures at the 1,000-milestone scale.

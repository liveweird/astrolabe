# Baselines (take, compare, read, rename, delete)

- **Spec**: [tests/baselines.spec.ts](../tests/baselines.spec.ts)
- **Actors**: the seed administrator (takes, renames and deletes baselines in the UI, and acts through the API to seed and to re-plan); two
  throwaway logins seeded through the API — a project OWNER (the person who owns the project; no baseline right) and a team MANAGER (the
  manager of the team, owning nothing; no baseline right)
- **Owns** (exclusive server-side state): its throwaway users, people, team, work stream, program, project and milestones (unique `e2e-bl-*`
  names, every date in **2043**, a year nothing writes a holiday in: 2043-01-01 is a Thursday, so the Mondays are 01-05, 01-12, 01-19, 01-26),
  all seeded through the API and removed by the afterEach through the API (the baselines first, then the project - its milestones go with it -
  then program, work stream, team, people, users); and its throwaway **baselines** (unique `e2e-bl-*` names), each test taking its own and
  soft-deleting it (the only delete there is: the frozen rows stay, by design). Baselines are plan-wide shared state (up to 100 active, each a
  copy of the WHOLE plan, other specs' rows included), so no step counts rows, asserts the list is empty or holds only these, or reads a
  total: every assertion is anchored on this spec's own project, milestones or baseline name. The baseline pick is a browser setting
  (`localStorage`, one per browser context), so a pick made here never reaches another spec.

The world (seeded per test): the project P (owned by the OWNER) with `m1` (3 MD, scheduled 2043-01-05..01-09) and `m2` (2 MD, scheduled
2043-01-12..01-16), both on the MANAGER's team T. The re-plan used by the first two tests: `m1` moves to 2043-01-12..01-16 (onto `m2`'s days:
overlap only warns), and a new `m3` (2 MD) is scheduled 2043-01-19..01-21.

## Scenario: an editor takes a baseline and reads a milestone's movement on the team page

1. The administrator opens `/baselines`, presses **Take baseline**, enters a unique name in the dialog and presses **Take baseline** again.
   - *Expected*: the POST answers 201, the dialog closes and the list shows the row (the link "Compare <name> with the plan").
2. Through the API the administrator moves `m1` to 2043-01-12..01-16 and creates and schedules `m3` (2043-01-19..01-21).
3. The team's manager signs in and opens T's page.
   - *Expected*: no baseline is picked yet — no shadow bar (`data-tone="baseline"`).
4. They choose the baseline in the **Baseline** picker.
   - *Expected*: exactly two shadow bars (`m1`, `m2`; the new `m3` has none). `m1`'s bar reads "Baseline: <m1>, 2043-01-05 to 2043-01-09, 5
     working days later (start and end), read-only"; `m2`'s, unchanged, reads only the dates.
5. They open the **Movement vs baseline <name>** section (**Show the movement**).
   - *Expected*: `m1`'s row reads its project, baseline 2043-01-05 – 2043-01-09, current 2043-01-12 – 2043-01-16, Start +5, End +5, estimate 3 and
     the status "Later" (the ORANGE badge: the colour is pinned by the web unit tests, which assert the badge colour; here the word is the
     contract); `m3`'s row has no baseline dates, current 2043-01-19 – 2043-01-21 and the status "New"; `m2` has no row ("Changed only" is on).
6. They switch **Changed only** off.
   - *Expected*: `m2`'s row appears with the status "Unchanged".

## Scenario: the comparison page lists the project's moved, new and removed milestones and the project's own movement

1. The administrator takes a baseline through the API; then moves `m1` to 2043-01-12..01-16, creates and schedules `m3` (01-19..01-21) and
   deletes `m2`. The project's span was 2043-01-05..01-16 and is 2043-01-12..01-21 now.
2. The project OWNER (a reader) opens `/baselines/<id>` and narrows the **Project** filter to P.
   - *Expected*: the heading is the baseline's name; P's row reads "start 5 working days later, end 3 working days later" (Mon 01-05 -> Mon
     01-12 is five working days; Fri 01-16 -> Mon 19, Tue 20, Wed 21 is three), "Milestones: 1 end later, 1 new, 1 removed", baseline span
     2043-01-05 – 2043-01-16, current span 2043-01-12 – 2043-01-21, Start +5, End +3 and the status "Later".
3. They read the milestone rows under P.
   - *Expected*: `m1` — 2043-01-05 – 2043-01-09 then 2043-01-12 – 2043-01-16, +5, +5, "Later"; `m3` — no baseline dates, 2043-01-19 –
     2043-01-21, estimate 2, "New"; `m2` — baseline 2043-01-12 – 2043-01-16, no current dates, "Removed".

## Scenario: a reader opens the baselines list without the Take baseline button and the row menu

1. The administrator takes a baseline through the API. The project OWNER (no ADMIN, no `ROADMAP_EDITOR` grant) signs in and opens
   `/baselines`.
   - *Expected*: the heading "Baselines" and the baseline's row link are there; there is no **Take baseline** button and no "Operations for
     <name>" menu on the row.
2. They follow the row's link.
   - *Expected*: the URL is `/baselines/<id>`, the heading is the baseline's name and the facts line ("Taken …") is shown: a reader reads the comparison.

## Scenario: an editor renames and deletes a baseline, and a page that had it picked falls back to none

1. The administrator takes a baseline through the API (the plan is copied as it is: `m1` and `m2` scheduled) and picks it on T's page.
   - *Expected*: two shadow bars.
2. On `/baselines` they choose **Rename <name>** from the row menu, enter a new unique name and Save.
   - *Expected*: the PUT succeeds, the dialog closes and the list links the new name. T's page, opened again, still has the pick: the picker
     reads the new name and the two shadow bars are still there.
3. On `/baselines` they choose **Delete <new name>** from the row menu and confirm.
   - *Expected*: the DELETE succeeds and the row is gone. T's page, opened again (the stored pick names a deleted baseline: the server's typed
     400 clears it), reads **None** in the picker, has no shadow bar and still lists `m1`'s row.

## Not covered here (and why)

- **The cap of 100** — taking 100 baselines would fill the shared registry for every parallel spec; the cap and its 409 are covered by the server tests
  (`BaselineTest`) and the web unit tests.
- **The authz matrix and the colours** — server tests (`BaselineTest`) and the web unit tests; the specs here assert the visible consequences
  (no write control for a reader; the words "Later" and "New").
- **A `ROADMAP_EDITOR` grant** — the administrator stands for "an editor" (the grant UI is `roadmap.spec.ts`'s subject; the server decides both identically).
- **The roadmap and programs overlays** — the web unit tests (`Roadmap.baseline.test.tsx`, `Programs.baseline.test.tsx`); the axe scans in
  `accessibility.spec.ts` cover the team page, the registry and the comparison page.
- **The project page's overlay and Movement section, the comparison page's "Show on timeline" / "Show on the roadmap" and the "(latest)" label** — the web
  unit tests (`ProjectView.baseline.test.tsx`, `BaselineCompare.test.tsx`, `BaselinePicker.test.tsx`).
- **Residue of an aborted run** — a killed run leaves its in-flight baseline active (baselines are soft-deleted only); about 100 such leftovers would make
  every take answer 409. A name sweep is unsafe while parallel workers hold live `e2e-bl-*` baselines: delete leftovers by hand on `/baselines`.

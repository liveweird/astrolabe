# Jira coverage (story roll-ups, work Jira has that the plan does not, children all done, acknowledge)

- **Spec**: [tests/jira-coverage.spec.ts](../tests/jira-coverage.spec.ts)
- **Actors**: the seed administrator (seeds and tears down through the API, binds, refreshes, and works in the browser). No new guard exists to prove, so no
  second actor.
- **Owns** (exclusive server-side state): ONE Jira connection (`e2e-cov-connection-*`, scoped to the stub's `COV` project ONLY on a unique throwaway site
  `https://stub-e2ecov<random>.atlassian.net`, manual only - `pollIntervalMinutes: null`, so the scheduler never touches it - and given 0.5 man-days per story point through
  the API), tested ONCE per worker start of the file through the API in the beforeAll (**one call** of the per-IP Test connection bucket, shared with the other Jira
  specs; a 429 there waits the minute out once), its three bindings (the project to `COV-2`, the milestones to `COV-3` and `COV-4`; `COV-5` and `COV-10` are never bound),
  its runs (one in the beforeAll, one more in the third scenario, both through the API), and a throwaway world - a person, a team, a work stream, a program, a project
  `e2e-cov-project-*` and three milestones `e2e-cov-epic-one-*` (Mon 2046-03-05..Wed 03-14), `e2e-cov-epic-two-*` (Mon 03-19..Fri 03-23) and `e2e-cov-unlinked-*`
  (Mon 04-02..Fri 04-06), unique `e2e-cov-*` names, every date in **2046** (2046-01-01 is a Monday; nothing writes a holiday there). Everything is seeded and
  removed through the API (the bindings first, then the connection, then the project, whose milestones go with it, then the rest) in the beforeAll/afterAll, the
  afterAll even after a failed beforeAll or test. It **never flips the stub's `jira-day2` scenario** (`COV` is untouched by day 2) and needs no lock. The file runs
  serially (`mode: "serial"`): the third scenario acknowledges what the second read.
- **Needs**: the compose stack with its Jira stub (`E2E_JIRA_STUB_URL`), rebuilt with the `COV` project (1.4.0). The stub's `COV` project
  (`sample-data/jira/expected.json` `cov`): `COV-1` Program, `COV-2` Initiative (02-19..05-04), `COV-3` Epic One (Mon 03-05..Fri 03-09, 8 points, To Do) with four
  children - two Stories done (3 and 5 points), a Task in progress (2), a Bug to do (3) - so 2 of 4 done and 13 points; `COV-4` Epic Two (Mon 03-19..Fri 03-23, 5
  points, To Do) with two Stories, both done (2 and 3 points): 2 of 2 and 5 points; `COV-5` Epic Three, open and left unbound; `COV-10` Epic Four, DONE and unbound.
  The milestones' estimates (4 and 2.5 man-days) equal the epics' points at 0.5 per point, so no estimate deviation shows. Their names differ from the epics'
  summaries (they carry the `e2e-cov-` marker), so each linked milestone also reads a "Renamed" info - the realistic fullest Flags cell.

## Scenario: the milestone chips show each epic's story roll-up after a refresh

1. The administrator opens the project page `/projects/<id>` (the world's project) after the beforeAll's run.
   - *Expected*: the timeline grid has a **Flags** column; epic one's Flags cell holds the key link `COV-3`, its flags (a warning: "Ends 3 working days later than Jira",
     plan 2046-03-14 against Jira's 03-09, and an info: renamed) and, LAST, the chip text `2/4 · 13 pt` (the visible text is `aria-hidden`); the cell's accessible
     name for the chip is the sentence "4 child issues in Jira, done: 2, story points: 13" (the `title` and the visually hidden span).
2. They read epic two's Flags cell.
   - *Expected*: the key link `COV-4`, an info flag, and the chip `2/2 · 5 pt` with the sentence "2 child issues in Jira, done: 2, story points: 5".
3. They read the row of `e2e-cov-unlinked-*` (scheduled, linked to nothing).
   - *Expected*: the row exists and its Flags cell is empty: no key, no flag, no chip.
4. They measure the Flags cells.
   - *Expected*: neither cell clips (`scrollWidth <= clientWidth` in the 210 px column, the fullest being epic one's: key, warning, info, roll-up); the key link and the warning
     badge end inside epic one's cell.
5. They scan the page with axe (WCAG A/AA, `color-contrast` included), light, then dark (`page.emulateMedia({ colorScheme })`, the `data-mantine-color-scheme`
   attribute confirms each).
   - *Expected*: no violations in either scheme. (Scanned here because only this world has stories; `accessibility.spec.ts`'s Jira world binds `E2E-4`, which has none.)

## Scenario: the Deviations page lists the work Jira has that the plan does not, and the reverse

1. The administrator opens `/deviations?projectId=<id>`.
   - *Expected*: the project's binding row (`COV-2`) lists a **Not in plan** warning "1 Jira item is not in the plan: COV-5" and a **Not in Jira** info "1 plan item is not
     linked to Jira: e2e-cov-unlinked-…" (the unbound milestone's name).
2. They read epic two's row (`COV-4`).
   - *Expected*: a **Children done** info "All 2 child issues are done in Jira while the plan ends 2046-03-23"; the roll-up chip sits under the Jira item on this row and on
     epic one's (`COV-3`), by its sentence.
3. They look for the done, unbound epic.
   - *Expected*: `COV-10` (and its summary "COV Epic Four") appears nowhere in the table: closed work is history, and a done Jira item is never a coverage deviation.
4. They scan the page with axe, light and dark.
   - *Expected*: no violations with the three coverage rows (the badges, the chips, the sentences).
5. They open `/roadmap` narrowed to the world's program (the program pick, a browser setting) and open the flag panel.
   - *Expected*: the panel's table holds "Jira COV-2: 1 Jira item is not in the plan: COV-5" and names `COV-10` nowhere.

## Scenario: acknowledging the coverage deviation silences the flag

1. The administrator opens the Open list `/deviations?projectId=<id>&all=false`, finds `COV-2`'s row with the "Not in plan" sentence and presses **Acknowledge COV-2**.
   - *Expected*: the row leaves the Open list; the rows of `COV-3` and `COV-4` stay (the acknowledgement is the binding's alone), `COV-4` still reading "Children done".
2. They open the roadmap narrowed to the world's program, with the flag panel open.
   - *Expected*: the panel no longer holds an entry "Jira COV-2:" (the milestones' own flags remain, so the panel still opens).
3. They open the project page.
   - *Expected*: the key links `COV-3` and `COV-4` are still there (an acknowledgement silences a flag, it unlinks nothing).
4. Through the API they request one more manual run and wait (bounded, 30 s) for it to succeed; they reload the Open list and the roadmap panel.
   - *Expected*: the same coverage was read again, so the acknowledgement stands: `COV-2` is still not in the Open list and the panel still has no "Jira COV-2:" entry.

## Not covered here (and why)

- The coverage deviations appearing, growing and clearing as Jira changes (a new child, a child done, an epic bound): the server's kernel, census and view tests; the stub
  has one fixed `COV` world and this file never flips it.
- The team page's Flags column with a roll-up: the same `MilestoneFlags` component, covered by `TeamDetails.jira.test.tsx` and the project page here.
- The Polish wording: the web tests and the EN/PL parity test.

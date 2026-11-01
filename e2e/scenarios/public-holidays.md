# Public holidays (the dictionary page, and a holiday's effect on a project page)

- **Spec**: [tests/public-holidays.spec.ts](../tests/public-holidays.spec.ts)
- **Actors**: the seed administrator (adds, applies the preset, deletes; seeds through the API); one throwaway regular user (reads)
- **Owns** (exclusive server-side state): **every holiday dated in 2040** - the dictionary is global and this is the only spec that
  writes holidays, so it keeps to ONE far-off year that no other spec reads (`dependencies`/`team-view` pin 2027 working-day figures,
  `critical-path` lives in 2041); a sweep by date runs before the first test and again in the afterAll, so an aborted run leaves
  nothing. Also one throwaway user (the reader) and the calendar scenario's throwaway person, team, work stream, program, two
  projects A and B with one milestone each and their link (unique `e2e-hol-*` names), seeded through the API and removed by the
  afterEach, the projects first (their milestones and the link go with them), then team, program, work stream and person. A holiday write
  bumps the plan revision but stales no client write (nothing here or in any other spec asserts a revision).

## Scenario: an administrator adds a holiday in 2040, meets the duplicate message, applies the Polish preset twice and deletes a row

1. The administrator opens **Public holidays** and fills Date 2040-03-14 and a unique Name, then **Add holiday**.
   - *Expected*: the POST answers 201 and the toast "Public holiday added" shows; the Year picker moved to 2040 (a year with no row is not
     offered until one exists) and the table "Public holidays of 2040" has the one row.
2. They enter the same date with another name and press **Add holiday**.
   - *Expected*: the inline message "A holiday already exists on this date." shows; the table still has one row.
3. They press **Add Polish public holidays for 2040** and confirm "Add holidays".
   - *Expected*: the call answers 200; the status line reads "Polish holidays of 2040: 14 added, 0 already present."; the table has 15 rows
     (the 14 statutory days of 2040 - including "Nowy Rok" on 2040-01-01 and the first day of Christmas on 2040-12-25 - and the step-1 row).
4. They apply the preset a second time.
   - *Expected*: "0 added, 14 already present."; still 15 rows.
5. They delete the step-1 row from its trash button and confirm "Delete this holiday?".
   - *Expected*: the DELETE answers 204; the toast "Public holiday deleted" shows; the row is gone and 14 remain. Once the toasts have faded
     an axe scan of the page (a full table, the add strip, the preset button) reports no violations.

## Scenario: a regular user reads the 2040 holidays but cannot change them

1. The administrator adds a holiday on 2040-05-02 through the API. A throwaway regular user signs in and follows **Public holidays** in the
   Administration group of the navigation.
   - *Expected*: the page opens at `/public-holidays` with the read-only hint "The list is maintained by administrators."
2. They pick 2040 in the Year picker.
   - *Expected*: the table has the 2040-05-02 row; there is no add strip (no Date textbox, no Add holiday button), no Polish-preset button
     and no delete button; an axe scan of the page reports no violations.

## Scenario: a holiday on the Monday after a finish moves the dependency's needed date and tints the header day; deleting it restores both

1. The administrator seeds, through the API, project A with a1 scheduled Monday to Friday 2040-01-30..02-03 and project B with b1 scheduled
   2040-02-06..10, and the finish-to-start link a1 -> b1 (lag 0): b1 starts the working day after a1 ends. They open project B.
   - *Expected*: the Dependencies row of a1 reads "OK" and "needs 2040-02-06 · is 2040-02-06"; no header day cell is named as a holiday.
2. They add a holiday on 2040-02-06 (the Monday) through the API and reload the page.
   - *Expected*: the row still reads "OK" but now "needs 2040-02-07" (the next working day after a1's end, the Monday being a day off);
     exactly one week-zoom header day cell has `data-holiday` and the title "Public holiday: <name>"; the visually hidden paragraph
     "Public holidays shown: …" is present (the header and tracks are aria-hidden, so it is the accessible surface; which holidays it names
     depends on how many the stack holds - past a handful it lists only the next few - so only its presence is asserted here and its
     content is pinned in `Timeline.test.tsx`).
3. They delete the holiday through the API and reload.
   - *Expected*: the row reads "needs 2040-02-06 · is 2040-02-06" again and no header day cell is a holiday.

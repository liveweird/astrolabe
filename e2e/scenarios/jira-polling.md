# Jira polling (the scheduler, the interval in the editor, the telemetry Sync section)

- **Spec**: [tests/jira-polling.spec.ts](../tests/jira-polling.spec.ts)
- **Actors**: the seed administrator (creates the connections through the API, reads the connection page, edits in the editor, opens the telemetry panel)
- **Owns** (exclusive server-side state): two Jira connections (unique `e2e-poll-*` names, each scoped to the stub's `E2E` project ONLY and given a unique throwaway
  site `https://e2epoll<random>.atlassian.net`): `e2e-poll-scheduled-*` (polling every 5 minutes, tested once) and `e2e-poll-manual-*` (manual only, never tested). It binds
  nothing, creates no plan node and dates nothing - so no year, no holiday, and a run of its connections calls Jira for nothing - and never flips the stub. Both are created
  through the API in the beforeAll and deleted in the afterAll. The file runs serially (`mode: "serial"`: the second scenario edits the polled connection, the third lists it).
  The beforeAll spends ONE Test connection call (10 a minute per IP across the suite) per worker start of the file, and waits a 429 out once.
- **Needs**: the stack under test runs the scheduler (the compose default: a tick every 60 s, the first 10 s after start). A tested connection with no run is due at once, so
  the first scheduled run comes within a tick or two; the file waits at most two minutes for it (`test.setTimeout(180_000)`, a bounded `expect.poll` on the runs API, never a fixed sleep).

## Scenario: a tested connection with a polling interval is polled by the scheduler within two minutes and reads Current, and an untested manual-only connection has no run

1. Through the API, the administrator waits (bounded, 120 s) until the polled connection has a run with the trigger SCHEDULED and the outcome SUCCEEDED.
   - *Expected*: it appears within the bound; the manual-only connection has no run at all.
2. They open the polled connection's page.
   - *Expected*: the "Recent runs" table has a **Scheduled** row with the outcome "Succeeded" and no **Manual** row; the facts read the status **Current**, "next poll in n min"
     with n from 1 to 5, a dated "Last success (UTC)" and Polling "every 5 min".
3. They open the manual-only connection's page.
   - *Expected*: the status **Never synced**, "Last success (UTC)" "—", Polling "Manual only" and the runs table "No runs yet". This step claims only that: the connection
     is untested (the one Test call is spent on the polled one), so the scheduler would skip it for that reason alone. That a TESTED manual-only connection stays unpolled is
     not shown here (see below).

## Scenario: an administrator sets the polling interval and manual only in the editor

1. The administrator opens the polled connection's page, presses **Edit**.
   - *Expected*: "Polling interval (minutes)" reads 5 and **Manual only (no polling)** is unchecked.
2. They type 3 and press **Save**.
   - *Expected*: the dialog stays open and the rule's sentence ("… from 5 to 1440") shows; nothing is saved.
3. They type 20 and save, then press **Edit** again.
   - *Expected*: the dialog closes; the facts read Polling "every 20 min"; the editor reopens on 20.
4. They tick **Manual only (no polling)** and save.
   - *Expected*: the number is disabled while ticked; afterwards the facts read Polling "Manual only", and the Status and Next poll facts say "manual only".
5. They open the registry `/integrations/jira`.
   - *Expected*: the connection's row (Status column) says "manual only".
6. They open the connection's page, **Edit**, and read the dialog; they untick the box, type 5 and save.
   - *Expected*: the checkbox opened ticked and the number disabled; unticking enables the number; the facts read Polling "every 5 min" again.
7. Through the API, the administrator counts the connection's SCHEDULED runs just before step 6 (manual only had stopped the scheduler for it) and waits (bounded, 120 s) for the count to rise.
   - *Expected*: a NEW scheduled run appears - the edit made the connection due at once and polling resumed after the round trip. The scenario's timeout is 240 s.

## Scenario: the telemetry panel's Sync section lists the connection with its state

1. Through the API, the administrator waits (bounded) for the polled connection's scheduled success (normally already there from the first scenario).
2. They open the telemetry panel from the account menu and expand **Sync**.
   - *Expected*: "The scheduler looks for connections that are due every n s."; the table "Sync status per connection" has one row for the polled connection - the Jira kind,
     state **Current**, a last success (the Last success cell is an age, not "Never") and Polling "every 5 min" - and one for the manual-only one: state **Never synced**, the Last success cell "Never", Polling "Manual only".

## Not covered here (and why)

- A failing run, the back-off and the failure streak: the server's scheduler and policy tests (the stub offers no failing site for the `E2E` project beyond the wrong token,
  and a wrong-token connection cannot be tested, so the scheduler never polls it).
- A TESTED manual-only connection staying unpolled: it would cost a second Test connection call of the shared bucket (9 of 10 are spent by a clean run of the Jira files already,
  and a retry of `jira-sync`'s group spends five more); the server's scheduler tests (`SchedulePolicyTest`, `SyncSchedulerTest`) pin that rule. The first scenario therefore
  claims only that an UNTESTED manual-only connection has no run.
- An axe scan of these pages: `accessibility.spec.ts` scans the connection page's status facts, the editor's Polling controls and the Sync section in the Jira world.

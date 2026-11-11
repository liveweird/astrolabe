# Jira stub (development and test data, never production)

A deterministic stand-in for Jira Cloud: a WireMock server answering the gateway-shaped endpoints the Jira sync's client calls, over a dataset **derived from
`sample-data/plan/*.json`** by `sample-data/jira/generate.mjs` (Node >= 24, zero dependencies, seeded, no clock: two runs write byte-identical files). It exists so
every Jira feature is proven without a real site (the first real-site test is v1.1.0's open item). It is never copied into the app image (`.dockerignore`), never
loaded in production (`JIRA_STUB_BASE_URL` is refused outside development mode), and the stack ships it as its own `jira-stub` image.

```bash
node sample-data/jira/generate.mjs [--seed 42] [--plan sample-data/plan] [--out sample-data/jira-stub] [--expected sample-data/jira/expected.json]
node --test sample-data/jira/generate.test.mjs        # determinism, committed == fresh, hierarchy, planted counts, the regexes
```

Only `jira-stub/mappings/` and `jira-stub/__files/` are (re)written; `jira-stub/Dockerfile` is hand-written. A change to the generator ships with the regenerated
files (`scripts/gates.sh` and CI fail otherwise); `.gitattributes` keeps them LF.

## The site

One site (`cloudId` `b3f1a2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c`, answered by the unauthenticated `GET /_edge/tenant_info`), every other call under
`/ex/jira/{cloudId}/rest/api/3/...` with `Authorization: Basic|Bearer ...` (a missing header gets the real 401 from `auth-catchall-401`).

| Project | Content |
|---|---|
| one per work stream: `CE` (Customer Experience), `PF`, `CG`, `DI`, `OE` | 20 Programs, 100 Initiatives, 1,000 Epics in all, parents following the plan (`Epic -> Initiative -> Program`); issue numbers are assigned in id order per project (programs, then initiatives, then epics) |
| `E2E` | the small isolated project only the e2e spec binds: 1 Program, 2 Initiatives, 7 Epics, every date in **2044** (a holiday-free year), `E2E-5` is the epic whose end reads 3 working days later than the spec's milestone, `E2E-6` is deleted on day 2, `E2E-9` is undated, `E2E-10` moves to `OUT-6` on day 2 (1.13; only `jira-sync.spec.ts` binds it) |
| `IMP` | the import's isolated project (v1.2.0): 1 Program, 2 Initiatives, 6 Epics, every date in **2045** (anchor Monday 2045-01-02), every issue To Do and untouched by day 2; only the import's e2e spec imports it (table below) |
| `COV` | the coverage project (v1.4.0): 1 Program, 1 Initiative, 4 Epics and 6 children, every date in **2046** (anchor Monday 2046-03-05), untouched by day 2; only the coverage e2e spec binds it (table below) |
| `IMF` | the import filter's isolated project (v1.13.2): 15 listed issues (2 Programs, 5 Initiatives, 8 Epics), every date in **2045**, untouched by day 2, plus ONE hidden Initiative that only `IMF-15` names as its parent (table below); only the import-filter specs import it |
| `OUT` | where day 2 moves five epics (`OUT-1`..`OUT-5`) and `E2E-10` (`OUT-6`); no scope lists it |

`IMP` (ids 95001..95009, team "IMP Team"; the stub does not filter `fields`, so an issue carries every field below):

| Key | Level | Summary | Parent | Dates (2045) | Points | Team |
|---|---|---|---|---|---|---|
| `IMP-1` | Program | IMP Program | none | 01-02..02-10 | | |
| `IMP-2` | Initiative | IMP Initiative Alpha | `IMP-1` | 01-02..01-20 | | |
| `IMP-3` | Initiative | IMP Initiative Beta | `IMP-1` | 01-23..02-03 | | |
| `IMP-4` | Epic | IMP Epic One | `IMP-2` | 01-02..01-06 | 5 | IMP Team |
| `IMP-5` | Epic | IMP Epic Two | `IMP-2` | 01-16..01-20 | 8 | **none** (no Team value) |
| `IMP-6` | Epic | IMP Epic Three | `IMP-3` | **undated** | 3 | IMP Team |
| `IMP-7` | Epic | a **110-character** summary starting "IMP Epic Four with a deliberately long summary" | `IMP-3` | 01-23..01-27 | 5 | IMP Team |
| `IMP-8` | Epic | IMP Epic Five | **`IMP-1`** (the program: no project parent) | 02-06..02-10 | 1 | IMP Team |
| `IMP-9` | Epic | IMP Epic Six | `IMP-3` | 01-30..02-03 | 2 | IMP Team |

**Stories (v1.4.0, the census's child level).** Under every fifth epic of the five work-stream projects (`ref % 5 === 0`) sit 1..4 **Story** issues (Jira hierarchy level 0; story points from {1, 2, 3, 5, 8}
in the Story Points field, `parent` the epic, a status mix, `updated` within 60 days of the anchor): 538 in all (`expected.json` `totals.stories`), numbered after the epics of their project and with ids after the
1,120 (so every id-ordered read lists them last). The plan levels stay 1,120: `totals.issues` is the plan-level count and the stories are counted apart. Plus the planted set **`childrenDone`** (10 epics that start after the anchor and end at least two weeks past it, so they stay To Do as generated and raise no
other deviation; each has 2..3 stories that are ALL done). The planted epics are disjoint from every other planted milestone set but **override the every-fifth draw** (two of them, refs 795 and 440, are every-fifth epics
too): they are the only non-done epics whose children are all done, which is what `CHILDREN_DONE` is proven on (any other epic's last story is kept open). No story sits under a day-2 epic (deleted or moved out), so
stories are never orphaned, deleted or moved on day 2; they are not in the incremental `recent` set.

`COV` (ids 97001..97012, team "COV Team"; the coverage figures are in `expected.json` `cov`, also `rollups`, `unlinkedOpen`, `unlinkedDone`):

| Key | Type (level) | Summary | Parent | Status | Dates (2046) | Points |
|---|---|---|---|---|---|---|
| `COV-1` | Program | COV Program | none | To Do | 03-05..05-18 | |
| `COV-2` | Initiative | COV Initiative Alpha | `COV-1` | To Do | 02-19..05-04 | |
| `COV-3` | Epic | COV Epic One | `COV-2` | To Do | 03-05..03-09 | 8 |
| `COV-4` | Epic | COV Epic Two | `COV-2` | To Do | 03-19..03-23 | 5 |
| `COV-5` | Epic | COV Epic Three, the spec leaves it UNBOUND: open, so `UNLINKED_IN_JIRA` | `COV-2` | To Do | 04-02..04-06 | 3 |
| `COV-10` | Epic | COV Epic Four, unbound but DONE (closed work is history: excluded) | `COV-2` | Done | 02-19..02-23 | 2 |
| `COV-6`, `COV-7` | Story | COV story one, two | `COV-3` | Done | | 3, 5 |
| `COV-8` | **Task** | COV task | `COV-3` | In Progress | | 2 |
| `COV-9` | **Bug** | COV bug | `COV-3` | To Do | | 3 |
| `COV-11`, `COV-12` | Story | COV story three, four | `COV-4` | Done | | 2, 3 |

Roll-ups: `COV-3` has 4 children, 2 done, 13 points; `COV-4` has 2 children, 2 done, 5 points (all done while the epic is still To Do and its plan end is ahead: `CHILDREN_DONE`, its only deviation).

`IMF` (1.13.2, ids 98001..98015 listed, team "IMF Team"; "fresh" = `updated` 2044-12-26, "stale" = `updated` 2010-03-01, so no figure depends on the clock; the stub does **not** evaluate the import's filter, the server's own rule does, and `expected.json` `imf.byFilter` says what the server must make of the listing under each of the four filters):

| Key | Level | Summary | Parent | Status | Updated | What it proves |
|---|---|---|---|---|---|---|
| `IMF-1` | Program | IMF Program | none | To Do | fresh | the top of the live chain |
| `IMF-2` | Initiative | IMF Initiative Open | `IMF-1` | In Progress | fresh | an open parent |
| `IMF-3` | Initiative | IMF Initiative Done | `IMF-1` | Done | fresh | a DONE parent of an open epic (`IMF-7`): left out by "leave out done", kept as a parent |
| `IMF-4` | Initiative | IMF Initiative Quiet | `IMF-1` | To Do | stale | a QUIET parent of an open epic (`IMF-8`): left out by the window, kept as a parent |
| `IMF-5` | Initiative | IMF Initiative Closed | `IMF-1` | Done | fresh | a left-out parent nobody needs (only `IMF-10`, itself left out, hangs under it): never read |
| `IMF-6` | Epic | IMF Epic Open | `IMF-2` | To Do | fresh | an open epic under an open parent: no read |
| `IMF-7` | Epic | IMF Epic Under Done | `IMF-3` | In Progress | fresh | an open epic whose parent is done |
| `IMF-8` | Epic | IMF Epic Under Quiet | `IMF-4` | To Do | fresh | an open epic whose parent is quiet |
| `IMF-9` | Epic | IMF Epic Done | `IMF-2` | Done | fresh | a done epic: left out by "leave out done" |
| `IMF-10` | Epic | IMF Epic Closed | `IMF-5` | Done | fresh | a done epic under a done parent: both left out |
| `IMF-11` | Epic | IMF Epic Quiet | `IMF-2` | To Do | stale | a quiet epic: left out by the window |
| `IMF-12` | Program | IMF Program Old | none | Done | stale | the top of a TWO-ROUND chain, left out by every filter |
| `IMF-13` | Initiative | IMF Initiative Old | `IMF-12` | Done | stale | the middle of it, left out by every filter |
| `IMF-14` | Epic | IMF Epic Under Old | `IMF-13` | To Do | fresh | an open epic: its parent is read in round one, that parent's program in round two |
| `IMF-15` | Epic | IMF Epic Under Hidden | `IMF-16` (hidden) | To Do | fresh | a parent the connection cannot read: skipped `NO_PARENT` with `PARENT_UNREADABLE` under a filter |

**`IMF-16`** (id 98016, an Initiative) is in no listing and has no issue mapping: `GET /issue/98016` and `/issue/IMF-16` fall to `issue-unknown-404`, while `IMF-15`'s `parent` member names it. The server must read, in order, under a filter: both switches `IMF-3, IMF-4, IMF-13, IMF-16 (404), IMF-12` (11 rows, 10 to create, 1 skipped); done only `IMF-3, IMF-13, IMF-16 (404), IMF-12` (12 rows); window only `IMF-4, IMF-13, IMF-16 (404), IMF-12` (14 rows); no filter reads nothing (15 rows, 14 to create, 1 skipped).

Search entries carry the `parent` member with `parent.fields.issuetype` (the import classifies a parent outside its set by it); a parent's type object omits `hierarchyLevel` on the same
every-third-id rule as the issue's own (`IMP-1`, `IMP-4`, `IMP-7`).

Issue types: Sub-task (-1), Story, Task, Bug (0; the stories are Stories, `COV-8` is a Task and `COV-9` a Bug), Epic (1), Initiative (2), Program (3); ids in `expected.json` `issueTypes`. About 60 fields in `GET /field` (the
Plans pair "Target start"/"Target end" with their `jpo-custom-field-baseline-*` customs, "Start date" and `duedate` as decoys, "Story Points" before "Story point
estimate", "Team" `atlassian-team`, "Sprint", "Rank", "Epic Link", the legacy "Parent Link" `jpo-custom-field-parent`, datetime and number decoys). Epics carry
"Target start/end" and Story Points = 2 x the plan's man-days (a declared factor of 0.5 makes them comparable); every tenth epic also carries decoy "Start date" and
`duedate`. On every third issue id the issue's own type object omits `hierarchyLevel`, so the client's `/issuetype` fallback is exercised too. The statuses are
relative to the anchor Monday **2026-10-26** (ended before it = Done, started = In Progress, else To Do), so they age against today; the dates do not.

## What the stub answers

| Request | Matched by | Answer |
|---|---|---|
| `GET /_edge/tenant_info` | path | `{cloudId}` |
| `GET /myself`, `/field`, `/issuetype`, `/project/search` | path + auth | one document each (`project/search` lists all ten projects on one page) |
| `GET /project/search?keys=A&keys=B` | path + auth + the `keys` set exactly as a scope lists it (`E2E`; the five work-stream keys; those plus `E2E`), priority 2 | only the named projects (any other key set falls to the unfiltered page above) |
| `GET /issue/{id or key}` | the issue's id OR key in the path; the query is ignored | the full document; 404 for any other key (`issue-unknown-404`) |
| `GET /search/jql` **full** | `jql` names the scope and has no `updated >=`; `fields` names `summary` and `issuetype` | every issue in scope, the stories included (100 a page, `nextPageToken`) |
| `GET /search/jql` **full, typed** (the run's first read, and the import's browse) | `jql` names the scope (any of the above, or one work-stream key) AND an `issuetype in (...)` set (Epic; Epic + Initiative; all three; or the **child set** Story + Task + Bug) with no `updated >=`; `fields` as above, priority 2 | the issues of those types in scope (100 a page, cursors `<scope>-fulltypes-<set>-<state>-p<n>`) |
| `GET /search/jql` **import window** (1.13.2: the import's filtered browse with an `updated` window) | `jql` names the scope (any of the scopes below, or one work-stream key), the three-type `issuetype in (...)` set (Epic + Initiative + Program), `updated >= "-Nm"`, and ends ` ORDER BY id ASC`; `fields` as above, priority 2 | the SAME pages as that scope's typed read of the three types (its cursors `<scope>-fulltypes-eip-<state>-p<n>`, its bodies): the stub evaluates neither `statusCategory` nor the window |
| `GET /search/jql` **import window, any other type set** | the same window and ` ORDER BY id ASC` over a type set that is NOT the three, priority 2 | `401` (an unmapped shape, never the incremental mapping's recent rows) |
| `GET /search/jql` **incremental** | `jql` names the scope and has `updated >= "-Nm"`; `fields` as above | the 15 recently updated epics (2 in `E2E`) |
| `GET /search/jql` **sweep** | `jql` names the scope and an `issuetype in (...)` set; `fields=id` | `{id}` entries of the in-scope issues of those types |
| `GET /search/jql` **probe** | the scope; `fields=id`, `maxResults=1` | the first epic in scope |
| a wrong token (`Bearer wrong-token`, or a Basic header whose password is `wrong-token`, any email) | `Authorization` | `401` on every authenticated route (`auth-wrong-token-401`) |

*Scopes* (any key order, quoted or not): `E2E`; the five work-stream keys; those five plus `E2E`; `IMP`; `COV`; `IMF` (all of them answer every shape above, `project/search?keys=` and the probe included, so
Test connection, Peek and Refresh work on an `IMP`-scoped connection). The import's browse also reads ONE key at a time: the single-key scopes `CE`, `PF`, `CG`, `DI` and `OE` answer
the **typed full read only** (no connection is scoped to one key, so they have no `project/search`, probe, sweep or incremental mapping). *Issue-type sets* for a typed read or a sweep: Epic;
Epic + Initiative; all three; Story + Task + Bug (the child level, `s`: what the server's `typeIdsAtLevel(0)` names; every scope and every single key answers it, both reads). A request outside a listed shape (a `fields` value without `summary`, a different scope) matches nothing and falls to the catch-all `401`: that is deliberate (it is how the
real site's id-only default fails a client that forgot `fields`), and adding a shape or scope is a local edit in `mappings.mjs` (`scopesOf`, `keyScopesOf`, `TYPE_SETS`) plus a regenerate.
The stub does **not** filter `fields` (documents carry a superset) and ignores `maxResults` except for the probe. It does not evaluate the import's filter either (1.13.2): a browse with `AND statusCategory != Done` and no window is answered by the typed read (its pattern ignores that clause), one with a window by the import-window family above, both with the unfiltered listing; tests assert the REQUESTED `jql` and the by-id reads, and the server's own rule drops what a real site's query would have left out.

## Day 2

The `jira-day2` WireMock scenario starts at `Started`; flip it with `PUT /__admin/scenarios/jira-day2/state` and body `{"state":"day2"}` (back with `Started`, or
`POST /__admin/scenarios/reset`). On day 2: 12 epics are deleted (`/issue/...` 404, absent from every search), 5 epics are moved to project `OUT` (`/issue/{id}` answers the
moved document with its `OUT-n` key, the old key 404s, absent from every scope), and `E2E-6` is deleted; `E2E-10` is moved like them (`/issue/{id}` and `/issue/OUT-6` answer 200 with key `OUT-6` in project `OUT`, `E2E-10` 404s, absent from the `E2E` scopes: the `E2E` sweep shrinks by 2). The sweep for a sample scope therefore shrinks by 17. The stories, `IMP` and `COV` are untouched by day 2 (the epics deleted or moved have no stories: the child level's sweep and typed read are the same on both days).

## Planted deviations (the counts are in `expected.json`)

Jira's dates start as the plan's; these differ on purpose, in disjoint sets of scheduled milestones (Mon-Fri working days, no holidays): 120 epics end/start **later** by 1..10
working days, 40 **earlier** by 1..10, 30 **renamed** (`<name> (renamed)`), 25 **re-parented** to a sibling initiative, 20 **undated** in Jira, 15 **Done** while the plan's end is
at least two weeks past the anchor, 10 with **story points** +3..+9 off 2 x man-days; plus 20 milestones that are unscheduled in the plan but **dated in Jira**, and (1.4) **10 `childrenDone`** epics whose stories are all done while the epic is still To Do and the plan's end is ahead. Projects: 10 whose
Jira dates end 5 working days after their target window, 5 renamed; programs: 2 whose Jira span is 3 working days later. `expected.json` also lists every key by level
(`keys`), the search page counts per shape (`search`), the `E2E` project (`e2e`) and the `IMP` project (`imp`), the `COV` project (`cov`: issues, `rollups`, `unlinkedOpen`, `unlinkedDone`) and the `IMF` project (`imf`: issues with status and stamp, the `hidden` parent, `byFilter`).

## How it is served

- **In the server suite**: `JiraStubServer` (test sources) starts WireMock in-JVM over this directory on a dynamic port with the request journal off; `JiraStubFixture.warm()`
  warms it in a `@BeforeClass` (`StubWarmupGuardTest` fails a class that forgets). `JiraStubFixtureTest` replays the contract above over HTTP against `expected.json`.
- **On the stacks**: `jira-stub/Dockerfile` builds a `wiremock/wiremock` image (the same 3.13.2 pin as the test dependency) with these mappings; compose and the Kubernetes
  overlay run it on port 8096 (a later step wires them).

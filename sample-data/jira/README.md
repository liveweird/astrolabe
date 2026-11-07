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
| `E2E` | the small isolated project only the e2e spec binds: 1 Program, 2 Initiatives, 7 Epics, every date in **2044** (a holiday-free year), `E2E-5` is the epic whose end reads 3 working days later than the spec's milestone, `E2E-6` is deleted on day 2, `E2E-9` is undated |
| `IMP` | the import's isolated project (v1.2.0): 1 Program, 2 Initiatives, 6 Epics, every date in **2045** (anchor Monday 2045-01-02), every issue To Do and untouched by day 2; only the import's e2e spec imports it (table below) |
| `OUT` | where day 2 moves five epics (`OUT-1`..`OUT-5`); no scope lists it |

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

Search entries carry the `parent` member with `parent.fields.issuetype` (the import classifies a parent outside its set by it); a parent's type object omits `hierarchyLevel` on the same
every-third-id rule as the issue's own (`IMP-1`, `IMP-4`, `IMP-7`).

Issue types: Sub-task (-1), Story, Task, Bug (0), Epic (1), Initiative (2), Program (3); ids in `expected.json` `issueTypes`. About 60 fields in `GET /field` (the
Plans pair "Target start"/"Target end" with their `jpo-custom-field-baseline-*` customs, "Start date" and `duedate` as decoys, "Story Points" before "Story point
estimate", "Team" `atlassian-team`, "Sprint", "Rank", "Epic Link", the legacy "Parent Link" `jpo-custom-field-parent`, datetime and number decoys). Epics carry
"Target start/end" and Story Points = 2 x the plan's man-days (a declared factor of 0.5 makes them comparable); every tenth epic also carries decoy "Start date" and
`duedate`. On every third issue id the issue's own type object omits `hierarchyLevel`, so the client's `/issuetype` fallback is exercised too. The statuses are
relative to the anchor Monday **2026-10-26** (ended before it = Done, started = In Progress, else To Do), so they age against today; the dates do not.

## What the stub answers

| Request | Matched by | Answer |
|---|---|---|
| `GET /_edge/tenant_info` | path | `{cloudId}` |
| `GET /myself`, `/field`, `/issuetype`, `/project/search` | path + auth | one document each (`project/search` lists all eight projects on one page) |
| `GET /project/search?keys=A&keys=B` | path + auth + the `keys` set exactly as a scope lists it (`E2E`; the five work-stream keys; those plus `E2E`), priority 2 | only the named projects (any other key set falls to the unfiltered page above) |
| `GET /issue/{id or key}` | the issue's id OR key in the path; the query is ignored | the full document; 404 for any other key (`issue-unknown-404`) |
| `GET /search/jql` **full** | `jql` names the scope and has no `updated >=`; `fields` names `summary` and `issuetype` | every issue in scope (100 a page, `nextPageToken`) |
| `GET /search/jql` **full, typed** (the run's first read, and the import's browse) | `jql` names the scope (any of the above, or one work-stream key) AND an `issuetype in (...)` set (Epic; Epic + Initiative; all three) with no `updated >=`; `fields` as above, priority 2 | the issues of those types in scope (100 a page, cursors `<scope>-fulltypes-<set>-<state>-p<n>`) |
| `GET /search/jql` **incremental** | `jql` names the scope and has `updated >= "-Nm"`; `fields` as above | the 15 recently updated epics (2 in `E2E`) |
| `GET /search/jql` **sweep** | `jql` names the scope and an `issuetype in (...)` set; `fields=id` | `{id}` entries of the in-scope issues of those types |
| `GET /search/jql` **probe** | the scope; `fields=id`, `maxResults=1` | the first epic in scope |
| a wrong token (`Bearer wrong-token`, or a Basic header whose password is `wrong-token`, any email) | `Authorization` | `401` on every authenticated route (`auth-wrong-token-401`) |

*Scopes* (any key order, quoted or not): `E2E`; the five work-stream keys; those five plus `E2E`; `IMP` (all of them answer every shape above, `project/search?keys=` and the probe included, so
Test connection, Peek and Refresh work on an `IMP`-scoped connection). The import's browse also reads ONE key at a time: the single-key scopes `CE`, `PF`, `CG`, `DI` and `OE` answer
the **typed full read only** (no connection is scoped to one key, so they have no `project/search`, probe, sweep or incremental mapping). *Issue-type sets* for a typed read or a sweep: Epic;
Epic + Initiative; all three. A request outside a listed shape (a `fields` value without `summary`, a different scope) matches nothing and falls to the catch-all `401`: that is deliberate (it is how the
real site's id-only default fails a client that forgot `fields`), and adding a shape or scope is a local edit in `mappings.mjs` (`scopesOf`, `keyScopesOf`, `TYPE_SETS`) plus a regenerate.
The stub does **not** filter `fields` (documents carry a superset) and ignores `maxResults` except for the probe.

## Day 2

The `jira-day2` WireMock scenario starts at `Started`; flip it with `PUT /__admin/scenarios/jira-day2/state` and body `{"state":"day2"}` (back with `Started`, or
`POST /__admin/scenarios/reset`). On day 2: 12 epics are deleted (`/issue/...` 404, absent from every search), 5 epics are moved to project `OUT` (`/issue/{id}` answers the
moved document with its `OUT-n` key, the old key 404s, absent from every scope), and `E2E-6` is deleted. The sweep for a sample scope therefore shrinks by 17.

## Planted deviations (the counts are in `expected.json`)

Jira's dates start as the plan's; these differ on purpose, in disjoint sets of scheduled milestones (Mon-Fri working days, no holidays): 120 epics end/start **later** by 1..10
working days, 40 **earlier** by 1..10, 30 **renamed** (`<name> (renamed)`), 25 **re-parented** to a sibling initiative, 20 **undated** in Jira, 15 **Done** while the plan's end is
at least two weeks past the anchor, 10 with **story points** +3..+9 off 2 x man-days; plus 20 milestones that are unscheduled in the plan but **dated in Jira**. Projects: 10 whose
Jira dates end 5 working days after their target window, 5 renamed; programs: 2 whose Jira span is 3 working days later. `expected.json` also lists every key by level
(`keys`), the search page counts per shape (`search`), the `E2E` project (`e2e`) and the `IMP` project (`imp`).

## How it is served

- **In the server suite**: `JiraStubServer` (test sources) starts WireMock in-JVM over this directory on a dynamic port with the request journal off; `JiraStubFixture.warm()`
  warms it in a `@BeforeClass` (`JiraStubWarmupGuardTest` fails a class that forgets). `JiraStubFixtureTest` replays the contract above over HTTP against `expected.json`.
- **On the stacks**: `jira-stub/Dockerfile` builds a `wiremock/wiremock` image (the same 3.13.2 pin as the test dependency) with these mappings; compose and the Kubernetes
  overlay run it on port 8096 (a later step wires them).

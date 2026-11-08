# Flow stub (development and test data, never production)

A deterministic stand-in for Flow's read-only service-token surface (Flow 1.57.0, `GET /api/v1/integration/me` and `GET /api/v1/integration/teams`): a WireMock server
over a dataset derived from `sample-data/plan/teams.json` by `sample-data/flow/generate.mjs` (Node >= 24, zero dependencies, seeded, no clock: two runs write
byte-identical files). It exists so the Flow connection, the team binding, the roster and the capacity import are proven without a real Flow (the first real-Flow
walk-through is the 1.5.0 plan's section 8). It is never copied into the app image (`.dockerignore`), and the stack ships it as its own `flow-stub` image.

```bash
node sample-data/flow/generate.mjs [--seed 42] [--plan sample-data/plan] [--out sample-data/flow-stub] [--expected sample-data/flow/expected.json]
node --test sample-data/flow/generate.test.mjs        # determinism, committed == fresh, the contract's field names, the planted cases, the cadence vs Intl
```

Only `flow-stub/mappings/` and `flow-stub/__files/` are (re)written; `flow-stub/Dockerfile` is hand-written. A change to the generator ships with the regenerated
files (`scripts/gates.sh` and CI fail otherwise); `.gitattributes` keeps them LF.

## The contract lives in ONE file

`contract.mjs` is the only place the stub states what Flow does: the two paths, the `sprintsSince` parameter, the token grammar and the stub token, the uniform 401
body and the document builders with **every field name** (`FIELDS`). The mappings, the world and `expected.json` take their facts from it. If Flow 1.57.0 ships a
different field or path, the fix is two files and one test: edit `contract.mjs` and `server/src/main/kotlin/flow/FlowDocument.kt` (the only decoder), regenerate,
and `FlowStubFixtureTest` / `FlowClientTest` prove them aligned (the ledger F1 in `flow-sync.md`: "the document's field names and types equal the Flow plan section 3.1").

## The credential

The stub accepts exactly one service token, public and obviously fake (it satisfies the grammar `^flow_int_[A-Za-z0-9_-]{43}$`, so Astrolabe's own validation
accepts it); it is also `expected.json` `contract.token`:

```
flow_int_stub-stub-stub-stub-stub-stub-stub-stub-stu
```

Anything else under `/api/v1/integration/` (no header, another scheme, another token, an unknown path, and ANY non-GET method: the stub answers 401 where Flow would answer 404/405) is the **uniform 401**: `application/problem+json`
`{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or invalid service token"}` (the Flow plan section 7: one text for every reason).

## What the stub answers

| Request | Matched by | Answer |
|---|---|---|
| `GET /api/v1/integration/me` | path + `Authorization: Bearer <stub token>`, priority 10 | `{tokenId, name, createdAt, expiresAt, lastUsedAt}` (the token "astrolabe", no expiry) |
| `GET /api/v1/integration/teams[?sprintsSince=YYYY-MM-DD]` | path + the header + a well-formed value or none, priority 10, scenario `flow-day2` | the day's document `{asOf, sprintsSince, teamsTruncated, sprintsTruncated, items[]}`; the value is **ignored** (the window is the world's fixed `sprintsSince` 2025-10-27, not an echo) |
| the same with a present, malformed `sprintsSince` | the header + a value that is not a calendar-shaped date, priority 9 | `400` problem |
| anything else under `/api/v1/integration/` | `urlPathPattern`, priority 100 | the uniform `401` |
| both endpoints while `flow-outage` is in the state `down` | the header is a WELL-FORMED bearer (`Bearer flow_int_` + 43 base64url characters, whatever the token), scenario, priority 5 | `500` problem "The service is unavailable": Flow checks the shape before the database, so a well-formed unknown token costs a lookup that throws (Flow plan section 7: an outage is a 500, never a 401). Only a missing or MALFORMED header still gets the 401 |

Other paths (Flow's JWT routes, `/__admin`) are not stubbed; WireMock answers its own `404` for them.

## The world (`expected.json` has every figure)

19 teams, 523 sprints, 120 membership rows, one document of about 132 KB (the real server's cap is 2,000 sprints and Astrolabe reads up to 1 MiB). `asOf` is Thursday
2026-10-29 12:00 UTC; every sprint is two weeks, **Monday 09:00 to the second Friday 17:00 on Europe/Warsaw's clock**; instants are epoch milliseconds; a membership
interval starts/ends at a Warsaw midnight and is **half-open, as in Flow**: a member over `[validFrom, validTo)`, so `validTo` is the first instant that is NOT a member
(Flow's "End membership" sets it to the start of today); `validTo: null` = still a member.

| Team | Content |
|---|---|
| the 15 sample-plan teams | one Flow team per `sample-data/plan/teams.json` name, **"Design Systems" spelled "Design System"** (planted: no name suggestion, 14 of the 15 match); 33 sprints each, 26 closed (completeAt a few hours after the end), the active one starting on the anchor Monday **2026-10-26**, 6 future; `capacityMd` = current members x 8 varied deterministically in 0.5 MD steps (total per sprint, as Flow's `DeriveSprintStep` yields it); every sixth sprint has `hasCalendar: false`, `capacitySource: "TEAM_DEFAULT"` and the team's `defaultCapacityMd`; 4-8 current members and 1-2 closed intervals (a former member, and for some teams one current member's earlier interval: left and came back) |
| `Legacy Mainframe` | planted: no Astrolabe counterpart, no manager, `defaultCapacityMd: null`. Its 15 DATED sprints carry `capacityMd: null` / `capacitySource: null` (each imports as `NO_CAPACITY`): **SYNTHETIC**, a robustness case for the nullable wire type, because Flow's `DeriveSprintStep` never emits null for a dated sprint of a team (it falls back to `TEAM_DEFAULT` or `DEFAULT` = members x days, possibly 0.0). Plus one UNDATED sprint (no dates, null/null), which IS reachable in Flow: a team without a default has nothing to derive from |
| `Empty Team` | planted: no members and no sprints, no manager, no default (no suggestion) |
| `Identity` | planted: "Identity Sprint 31" ends on the Monday (10:00) "Identity Sprint 32" starts on (Flow's shared day, `metrics.md` A42): the capacity import gives the Monday to sprint 31 (11 working days) and sprint 32 holds from Tuesday (9) |
| `Support Tooling` | planted: a one-week "Support Tooling Sprint 30 (hotfix)" wholly inside "Support Tooling Sprint 30" (`OVERLAPS`: wholly inside, so Flow counts no day for it) |
| `Analytics` | planted: "Analytics Sprint 34 (undated)", a future sprint with no dates (`NO_DATES`) on a team WITH a default: `capacitySource: "TEAM_DEFAULT"`, `hasCalendar: false`, the default's figure, as Flow derives it |
| `Mobile` | planted: the last future sprint's capacity comes from `capacitySource: "DEFAULT"` (40 MD) |
| `Web Frontend` | planted: one membership with `displayName: null` |
| `E2E Flow Team` | the e2e spec's team, dated **2047** (2047-01-07 is a Monday; no spec writes a holiday there): six future sprints Mon 2047-01-07..Fri 01-18, then 01-21..02-01, 02-04..02-15, 02-18..03-01, 03-04..03-15, 03-18..03-29 with `capacityMd` 40 / 36 / 44 / 40 / 38 / 42 = **20.00 / 18.00 / 22.00 / 20.00 / 19.00 / 21.00 MD a week** over 10 working days on a Monday-Friday calendar; 4 current members "Stub Quebec One".."Four" (since 2025-01-06), 1 former "Stub Quebec Former" (until 2026-03-31) |
| `Axe Flow Team` | the accessibility scans' team, 2026 dates: one closed, the active and two future sprints (24 / 24 / 30 / 24 MD), 3 current members "Stub Xray One".."Three", 1 former |

Names are "Stub <Greek letter> <ordinal>" (never a real person); managers "Stub Manager <Greek letter>"; account ids `712020:0000f10e-0000-4000-8000-...`.

## Scenarios

Two WireMock scenarios, both starting at `Started` (flip with `PUT /__admin/scenarios/<name>/state` and body `{"state":"<state>"}`; back with `Started`, or `POST /__admin/scenarios/reset`):

- **`flow-day2`** (state `day2`): `teams` answers a second document, `asOf` a day later: **"Billing" vanishes**, Platform's five calendar-sourced future sprints lose 8 MD each, and
  `E2E Flow Team`'s sprint 2 goes 36 -> 30 and sprint 3 44 -> 48 (`expected.json` `day2.capacityChanges`). "Axe Flow Team" and "E2E Flow Team" exist in both states.
- **`flow-outage`** (state `down`): both endpoints answer `500`; independent of `flow-day2`. The 1.5 manual walk-through uses it
  (`curl -X PUT http://localhost:8097/__admin/scenarios/flow-outage/state -d '{"state":"down"}'`); no 1.5 e2e flips either scenario.

## How it is served

- **In the server suite**: `FlowStubServer` (test sources, an instance of the shared `StubServer`) starts WireMock in-JVM over `sample-data/flow-stub` on a dynamic port with a
  50-entry request journal; `FlowStubFixture.warm()` warms it in a `@BeforeClass` (`StubWarmupGuardTest` fails a class that forgets). `FlowStubFixtureTest` replays the
  contract above over HTTP against `expected.json`.
- **On the stacks**: `flow-stub/Dockerfile` builds a `wiremock/wiremock` image (the same 3.13.2 pin and digest as the Jira stub and the test dependency); compose runs it on
  host port **8097** (loopback; the app reaches it as `http://flow-stub:8080`), the Kubernetes overlay as the `flow-stub` Service (`k8s/local/flow-stub.yaml`).
  The app learns its origin from `FLOW_INSECURE_ORIGINS` (development mode only; the 1.5.0 plan, section 3.2).

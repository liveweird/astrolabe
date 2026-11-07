### Build, test and CI times

Astrolabe is a small app: a tiny database, no external integration in the tests, a few hundred source files. **Everything should be blazing fast.** When a build, test or CI
job is not, the job is to find out WHY — not to raise a timeout. This doc is the measuring kit, the
budgets and the investigation log. Read it before you change a gate, a CI job, the
test harness (fixtures, forks, Kover) or anything that makes a gate slower.

> **Restart at v0.1.0.** Flow's history (its WHY investigations, status checks and measured figures, ~350 KB) was not carried over: the numbers described a different app and
> would mislead here. The method and the budget mechanics below are kept. **The budgets in `scripts/timings/budgets.json` were measured at the 1.0.0 re-baseline** ("Astrolabe WHY 1" below; each row's `why` holds its figure). Flow's `~/Sources/flow/.claude/docs/build-times.md` is the donor for any technique (statement-timeout cache, batched inserts,
> fork balancing, the ESLint cache, AppCDS): read its WHY before re-inventing one, port it when the same symptom shows up.
>
> **"WHY n" in a code or workflow comment** (e.g. `build-times.md WHY 27`, 13, 24, 51) is the donor's numbering: it points at that WHY entry in Flow's file, not at this one. Astrolabe's own entries start a fresh series below and are cited as `Astrolabe WHY n`.

## How to measure

Three tools, node built-ins only (no dependency; `scripts/` is outside the `web/` and `e2e/`
workspaces, so knip and eslint never see it). Budgets live in ONE place, `scripts/timings/budgets.json`.

**Remote — `node scripts/timings/ci-times.mjs`** (needs an authenticated `gh`; read-only calls):

```
node scripts/timings/ci-times.mjs --limit 20            # last 20 successful runs per workflow (ci, e2e)
node scripts/timings/ci-times.mjs --branch master       # the trunk only (PR noise excluded)
node scripts/timings/ci-times.mjs --steps web           # + the slowest steps of that job's latest run
node scripts/timings/ci-times.mjs --workflows e2e --steps e2e   # the nightly's per-step rows (build / start / specs)
node scripts/timings/ci-times.mjs --tsv                 # raw rows: created, sha, event, branch, job, seconds
```

`--steps JOB` also shows each step's target/alarm and an `over target`/`OVER ALARM` flag when the step has a
row under `ci-steps` in `budgets.json` (keys `<job>/<step name>`, the names the workflow gives its steps; today
the nightly `e2e` job's five steps).

Per job: latest, median of the last 5, median of the 5 before, min/max, the budget, and flags —
`TREND +N%` (recent median more than 25 % above the previous one and, once the median is 60 s or more, by at least 10 s too — below that the rule is relative-only),
`over target`, `OVER ALARM`. A `(run wall)` row is the time to green. Runs that were not successful
are listed separately (cancelled/failed counts, and `TIMEOUT?` for a job stopped right at a
`timeout-minutes` value — those never enter the medians).

**Local — `node scripts/timings/local-times.mjs`:**

```
node scripts/timings/local-times.mjs record server-build -- ./gradlew cleanTest check :server:installDist -Pforks=1
node scripts/timings/local-times.mjs record web-gates -- sh -c 'cd web && npm run lint:api && npm run check:api && npm run lint && npm run knip && npm run test:coverage && npm run build'
node scripts/timings/local-times.mjs report                       # latest / median 5 / previous 5 / flags
node scripts/timings/local-times.mjs slow-tests                   # top classes + cases from server/build/test-results/test
node scripts/timings/local-times.mjs slow-tests --forks 2         # + the fork-balance block (needs a weights file, see "Fork balancing" below)
node scripts/timings/local-times.mjs test-weights                 # per-class weights of a full run -> server/test-weights.tsv (not committed in v0.1.0)
```

**The one entry point — `scripts/gates.sh [server|web|e2e|all]`** (default `all`) runs the gates the way CI does,
each wrapped in `record`: `server-build` (`./gradlew cleanTest check :server:installDist`, with `JAVA_HOME=$(mise where java)` and the
OrbStack `DOCKER_HOST` set only when unset and the socket exists), `web-gates`, `e2e-static`. It stops at the first
failing gate with that gate's exit code, prints one line per gate and ends with `local-times.mjs report`. Prefer it
to typing the commands above, so every pre-commit run lands in the series. (Playwright is not part of it — it needs
a running stack.)

`record` runs the command, appends one row (ISO time, git short sha, branch, worktree, activity,
seconds, exit code, host cores) to `${XDG_DATA_HOME:-~/.local/share}/astrolabe/timings.tsv` — outside the
repo, **shared by every worktree** — prints the verdict against the budget and exits with the
command's own code. Non-zero exits are recorded but excluded from the medians. Activity names are
free-form; the ones with budgets are `server-build`, `server-test`, `web-gates`, `e2e-static`,
`e2e-playwright` (anything else gets trend flags but no budget; the in-test targets below are not
`record` activities — Gradle and JVM start-up would swamp them). Record a full-gate run whenever you run one anyway (the pre-commit
`server-build`, `web-gates`) — the point is a series, not a benchmark session.
`slow-tests` also takes `--wall <s>` (the Gradle-reported total), `--top-classes`, `--top-tests`,
`--budget ci.server-tests` and `--summary-file`. Suite span and the sum of class times are both shown
(they agree with one fork; with `-Pforks=N` the span is the wall and the sum is N forks' CPU time, fixtures included).

**In CI** the `server` job ends its build with a "Test time report (job summary)" step (`if: always()`,
`continue-on-error`, never a gate): the top 15 slowest classes and top 10 cases go to the run's job
summary, and a `::warning::` annotation appears when the test time exceeds the `ci.server-tests` alarm (the test task's own budget; `ci.server` stays the whole job's).
It uses the runner's preinstalled `node` (the scripts need node >= 18; ubuntu-24.04 ships 20+).

## Budgets

The ONE place for the numbers is `scripts/timings/budgets.json` (`target` = what it SHOULD take for this app; `alarm` = the hard ceiling; a `why` per row; `ci`, `ci-steps` and
`local` sections). A target is a claim about the app ("tiny DB, no integrations → this cheap"), and a miss is a question to answer, not a number to adjust. CI runners are
public-repo `ubuntu-24.04` (4 vCPU, 16 GB); local figures are for the dev machine. The rows (the JSON is the source of truth, this table only orients you):

| Activity | Target | Alarm |
|---|---|---|
| CI `changes` | 15 s | 30 s |
| CI `server-tests` (the test task alone; the CI warning compares test time with this) | 3 min | 8 min |
| CI `server` (compile + detekt + tests + Kover) | 6 min | 10 min |
| CI `web` | 2 min | 4 min |
| CI `e2e-static` | 1 min | 2 min |
| CI `gradle-vulnerability-scan` | 1 min | 2 min |
| CI `images` (plain `docker compose build`, no layer cache, + Trivy) | 3.5 min | 5 min |
| CI `k8s-static` | 20 s | 45 s |
| CI `e2e` (nightly) and its five steps (`ci-steps`) | 8 min | 15 min |
| local `server-build` (`cleanTest check :server:installDist -Pforks=1`) | 3 min | 6 min |
| local `server-test` | 3 min | 5 min |
| local `web-gates` | 45 s | 1.5 min |
| local `e2e-static` | 15 s | 30 s |
| local `e2e-playwright` | 3 min | 6 min |

The rule for changing one is below ("Review cadence").

**Fork balancing (not ported).** The `-Pforks` default is 1 (`ASTROLABE_FORKS` in `gates.sh`, `-Pforks=1` in CI). Flow weight-balanced the class order across forks from a measured `server/test-weights.tsv` once two forks paid;
the technique and the `slow-tests --forks N` block are described in `test-fixtures.md` "Fork balancing (not ported)". Port it when `server-tests` outgrows its budget (`BACKLOG.md`).

## Fixtures that add start-up cost

**Jira stub (v1.1.0 C1, measured 2026-11-06, Apple M5 Max, Docker via OrbStack).** `JiraStubFixture.warm()` starts the in-JVM WireMock over `sample-data/jira-stub` (1,360 mappings, 1,334 bodies, about 7 MB when measured; 1.2.0 adds the `IMP` project and the single-key import scopes: 1,612 mappings, 1,567 bodies, 26.8 MB of file bytes, 36 MB by `du` on disk; the stub's RSS was re-measured at that size, about 146 MiB, but this start-up time was not re-timed) and makes its
first two requests: **0.74 s per fork in the full `build`** (0.90 s in a focused run), printed as `fixture-cost jira-stub` and subtracted from the suite that paid it by `local-times.mjs`. It is paid once per fork by the first class that reads
the stub (today `JiraStubFixtureTest`), in a `@BeforeClass`, never inside `testApplication`'s 60 s. The step's new server classes add 39 tests and about 8 s of class time, 5.8 s of it `OutboundTransportTest` (local sockets only: the negative control
waits out a 700 ms client timeout, the leak cases wait for the client's connection close); every other new class runs under 1.2 s. A full `./gradlew build` from an empty `GRADLE_USER_HOME` (1,148 tests, `check`, `installDist`)
took 3m18s including the downloads. The stub dataset is generated in 0.2 s; `e2e-static` gains the generator's self-test and the generate-twice `diff` (both under 1 s). No budget row moved: the CI `server-tests` target (3 min) is
the figure to re-read after the first CI run on this commit.

**The server suite at 1.1.0 (re-measured 2026-11-07, Apple M5 Max, `scripts/gates.sh server`).** 1,468 tests, `server-build` **2m58s** (2m56s in the full `all` run), against its 3 min target and 6 min alarm: last five median 2m47s, previous five 2m42s, max 2m59s. The Jira sync (C1 to C11) took the suite from about 2m05s (the 1.0.0 median) to the edge of the target, so a next server increment re-reads this row first; no budget moved. `web-gates` 20s (1,857 tests), `e2e-static` 5.6s. The Kover floors held (line 98.53%, branch 86.57%, no raise possible).

## Investigation log

A TREND flag or budget breach gets a dated entry here (the symptom, the evidence, the cause, the outcome), keyed by a running WHY number so a code comment can point at it (`Astrolabe WHY n`).

### Astrolabe WHY 1: the re-baseline (status check, 2026-11-05)

**Symptom.** The first budgets were Flow's claims scaled down, never measured. `ci-times.mjs --branch master` flagged `web` at 3m12s over its 3 min alarm with TREND +44%, `e2e-static` at 1m10s over its 1 min alarm, `gradle-vulnerability-scan` TREND +53%, `k8s-static` TREND +43%; `server`, `images` and the nightly `e2e` sat over target.

**Evidence** (14 successful `ci` runs on master, 2026-10-31 to 2026-11-04, `1deb921`..`abed03f`; 4 nightlies; local `timings.tsv`, Apple M5 Max):

| Job | Median | Range | Latest (`abed03f`) |
|---|---|---|---|
| `server` | 5m16s | 3m18s-7m22s | 5m16s; the test task 2m55s for 1,109 tests |
| `web` | 1m45s | 1m02s-3m12s | 3m12s: tests 1m18s, `npm ci` 56 s, lint 28 s, build 13 s |
| `e2e-static` | 47 s | 19-70 s | 1m10s: `npm ci` 42 s |
| `images` | 3m21s (last five) | 2m33s-3m41s | 3m31s: build 2m45s, Trivy 39 s |
| `gradle-vulnerability-scan` | 55 s (last five) | 32 s-1m16s | 1m10s: the plugin audit 50 s |
| `k8s-static` | about 8 s | 4-28 s | 8 s |
| `e2e` (nightly) | 7m32s | 6m03s-9m56s | 9m56s at `6953b44`: specs 4m48s, build 2m40s |

Local (`local-times.mjs report`): `server-build` last five median 2m05s (previous five 2m29s, max 2m59s), `web-gates` 22 s (max 41 s), `e2e-static` 4.2 s (max 6.5 s). One-offs: `:server:test --rerun` 2m40s, the Playwright suite 2m24s for 123 tests.

**Cause.**
- `web` at 3m12s: `abed03f` was the first run after `3296492` changed `web/package-lock.json` and the ESLint config, and its log reads "Cache not found" for the ESLint cache and saves a NEW npm cache. The previous run (`6953b44`), with both caches hit, took 1m20s. So this is one cold run, not a trend; the earlier 3m01s at `4b10ab6` was not investigated.
- `e2e-static` at 1m10s: its log shows a cache HIT and `npm ci` still took 42 s; the whole job took 28 s at `6953b44`, also on a hit, with the same steps. So the 19-70 s spread looks like the runner rather than the commits (the job holds only `npm ci`, lint, knip, typecheck, the audit and small self-tests), though the runner itself was not measured.
- The other TREND flags are small absolute moves on noisy jobs (`k8s-static` 7 -> 10 s); nothing in them was attributed. `gradle-vulnerability-scan` spends 50 of its 70 s on the settings-plugin audit in a `--no-daemon` JVM.
- `server`, `images` and `e2e` are simply larger than the provisional claims: the suite grew from the foundation to 1,109 tests and the e2e suite to 113, then 123.

**Outcome.** Budgets set from these figures (`budgets.json`; each `why` holds its figure). Tightened: the local `web-gates`, `e2e-static` and `e2e-playwright`, which were far looser than measured. Raised: the CI `server`, `web`, `e2e-static`, `images`, `e2e` targets, and the `web`, `e2e-static` and `images` alarms, so one cold-cache run does not alarm. `ci.server-tests` stays 3 min against the measured 2m55s on purpose: its next breach is the cue for fork balancing. The `ci-steps` rows and the two one-off local rows rest on a single run each, so treat them as weaker. The Kover and vitest floors were re-measured the same day (`server/build.gradle.kts`, `web/vite.config.ts`).

## Review cadence

- Run `node scripts/timings/ci-times.mjs --branch master` at every milestone / PR, and in every
  checkup; run `local-times.mjs report` when a local gate feels slower.
- A `TREND` flag or a budget breach becomes a dated investigation entry in this doc (WHY, evidence,
  outcome) — **never just a raised budget.** A budget changes only with the measurement that justifies
  it, in the same commit as the edit to `scripts/timings/budgets.json` and the table above.
- A new gate or CI job gets a budget row before it lands.
- The `slow-tests` output of the CI job summary is the first stop when the `server` job regresses:
  a new class or case near the top of the list is almost always the cause.
- Once fork balancing is ported, refresh `server/test-weights.tsv` (after a full run: `node scripts/timings/local-times.mjs test-weights`) whenever the CI summary's fork-balance block warns and at every milestone check.

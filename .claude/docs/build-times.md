### Build, test and CI times

Astrolabe is a small app: a tiny database, no external integration in the tests, a few hundred source files. **Everything should be blazing fast.** When a build, test or CI
job is not, the job is to find out WHY — not to raise a timeout. This doc is the measuring kit, the
budgets and the investigation log. Read it before you change a gate, a CI job, the
test harness (fixtures, forks, Kover) or anything that makes a gate slower.

> **Restart at v0.1.0.** Flow's history (its WHY investigations, status checks and measured figures, ~350 KB) was not carried over: the numbers described a different app and
> would mislead here. The method and the budget mechanics below are kept. **Every budget in `scripts/timings/budgets.json` is PROVISIONAL** (each row says so) until the
> first CI run on GitHub and the first local `scripts/gates.sh all` series are measured — **re-baseline at v0.1.0** (`BACKLOG.md`): record the series, set targets from it, and
> add the first dated "Status check" entry below. Flow's `~/Sources/flow/.claude/docs/build-times.md` is the donor for any technique (statement-timeout cache, batched inserts,
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
public-repo `ubuntu-24.04` (4 vCPU, 16 GB); local figures are for the dev machine. The rows (all PROVISIONAL, seconds target/alarm — the JSON is the source of truth, this table only
orients you):

| Activity | Target | Alarm |
|---|---|---|
| CI `changes` | 15 s | 30 s |
| CI `server-tests` (the test task alone; the CI warning compares test time with this) | 3 min | 8 min |
| CI `server` (compile + detekt + tests + Kover) | 5 min | 10 min |
| CI `web` | 1.5 min | 3 min |
| CI `e2e-static` | 30 s | 1 min |
| CI `gradle-vulnerability-scan` | 1 min | 2 min |
| CI `images` (plain `docker compose build`, no layer cache, + Trivy) | 2.5 min | 4 min |
| CI `k8s-static` | 20 s | 45 s |
| CI `e2e` (nightly) and its five steps (`ci-steps`) | 7 min | 15 min |
| local `server-build` (`cleanTest check :server:installDist -Pforks=1`) | 3 min | 6 min |
| local `server-test` | 2 min | 5 min |
| local `web-gates` | 1.5 min | 3 min |
| local `e2e-static` | 30 s | 1 min |
| local `e2e-playwright` | 5 min | 10 min |

Nothing here is measured yet: they are Flow's per-gate claims scaled down for a foundation-sized suite. The rule for changing one is below ("Review cadence").

**Fork balancing (not ported).** The `-Pforks` default is 1 (`ASTROLABE_FORKS` in `gates.sh`, `-Pforks=1` in CI). Flow weight-balanced the class order across forks from a measured `server/test-weights.tsv` once two forks paid;
the technique and the `slow-tests --forks N` block are described in `test-fixtures.md` "Fork balancing (not ported)". Port it when `server-tests` outgrows its budget (`BACKLOG.md`).

## Investigation log

Empty. The first entry is the v0.1.0 re-baseline ("Status check, <date>"): the recorded `server-build` / `web-gates` / `e2e-static` series, the first CI medians, and the
Kover/coverage floors measured at the same time. A later TREND flag or budget breach gets a dated entry here (the symptom, the evidence, the cause, the outcome), keyed by a
running WHY number so a code comment can point at it (`Astrolabe WHY n`).

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

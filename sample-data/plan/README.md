# Sample plan (development data, never production)

A deterministic planning dataset at the intended scale, written by `scripts/sample-plan/generate.mjs` (seed 42, mulberry32, no clock) and replayed through the public
API by `scripts/sample-plan/load.mjs`. It exists to exercise the Timeline's virtualised path (the largest team's page), the team view's weekly load, capacity
and WIP warnings, the team order override and the roadmap ranking at the scale the product is built for. It is **never** loaded into production, never copied into an image
(`.dockerignore`), and the Playwright suite never loads it.

## Contents

Headline counts: 30 people, 15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones (100 of them unscheduled), 349 dependencies (300 milestone links, then 8 zero-slack chains and further links with a project end), 80 ranked projects, 3 custom team
orders (the self-test asserts these). **Every other figure** (team sizes, scheduled rows per team, dependency types and kinds, how many are violated and the zero-slack chains, the capacity mix, the share of loaded weeks
tuned to be overloaded or over the WIP limit) is in `summary.json`, which the generator writes and the self-test recomputes: read it there, not here.

| File | What |
|---|---|
| `people.json` | 30 people (Polish names, `<first>.<last>@sample.astrolabe.local`, unlinked): 15 team managers (persons 1-15) and 15 owners (16-30) |
| `teams.json` | 15 teams, one manager each; sizes follow the Zipf rank-size rule (size of rank k = size of rank 1 / k), Platform the largest |
| `plan.json` | 5 work streams, 20 programs, 100 projects with owners; 60 projects carry a target window (some tighter than their milestones, so drift shows) |
| `milestones.json` | 1,000 milestones (6 to 14 per project, named from a 14-word delivery vocabulary, unique per project), 0.5 to 40 man-days; some spans start or end on a weekend |
| `dependencies.json` | 349 links (FS, SS, FF; lags -5..10 working days), each end a `MILESTONE` or a `PROJECT` (`predecessorKind` / `successorKind`): the first 300 are milestone-to-milestone (75 across projects), then 8 zero-slack cross-project chains (23 links), then project-endpoint links; acyclic and unique per pair, checked as the server does (below) |
| `capacity.json` | 2 to 4 capacity periods per team: most start on a Monday, some mid-week, two on a weekend day; about half carry a `wipLimit` |
| `ranking.json` | the global project rank: 80 of the 100 projects ranked, 20 unranked |
| `team-orders.json` | custom (partial) milestone orders for 3 teams |
| `summary.json` | seed, counts and the derived statistics named above |

Records refer to each other by `ref` (1-based per file). **Every date is a day offset from an anchor Monday** (offset 0 = the anchor, so `7 * n` is a Monday and `7 * n + 5` a
Saturday): the loader resolves them with `--anchor` (default the Monday of the current week), so the plan surrounds today and the dataset never ages. The generator draws the
schedule first, then tunes each capacity period against the team's own load (a quantile of its weekly loads and of its daily work in progress), so the overload and WIP warnings
appear at a visible rate. The 300 milestone links are acyclic by construction: every link goes from an earlier to a later milestone in (project rank, stage) order.

**Project-endpoint links and chains** (`scripts/sample-plan/project-links.mjs`; the milestone links above are untouched, so every other file is byte-identical to before they existed).
They draw from their OWN seeded stream (the seed xor a constant), after the milestone links, and every candidate is checked **exactly as the server checks it** before it is kept
(`graph.mjs`, a port of `planning/DependencyGraph.kt`): the START/END time-point graph with the containment edges (a project's start before its milestones' starts, their ends before its end),
a new edge `u -> v` is refused when `v` already reaches `u` (lags ignored), and at most one link per unordered pair of endpoints. So the loader's `POST` never meets a `409`; `load.test.mjs`
replays the rule in a stub over the whole load, and `generate.test.mjs` re-checks the file with an independent Kahn pass. All of them cross projects (a link inside one project is redundant with
containment). The mix: **a quota per direction** (10 project -> project, 8 milestone -> project, 8 project -> milestone, drawn at random like the milestone links: a candidate the schedule
already violates is kept 1 time in 5) **plus 8 zero-slack chains** of 3, 3, 3, 3, 4, 4, 5 and 6 projects (31 projects, 23 links). A chain is built backwards from a tail project: the tail's latest-ending
milestone is where it lands; each step back picks a project (in a seeded shuffle) whose link, with the lag set to exactly the gap in the drawn schedule, has slack 0 and a lag in -5..10, and
whose time-point graph stays acyclic; a middle project is entered at its latest-ending milestone (its end is the project's end, so the zero path runs through it) and left from that
milestone or from the project's own end; the source is any scheduled milestone or a project. Chain links are never violated. The result is that the critical path of the tail project's page
should show the chain (the neighbour as a ghost row, the rest under "Critical chain"; not yet measured against a real server) (`summary.json` -> `dependencyStats.zeroSlackChains` / `deepestZeroSlackChain`, measured by `critical.mjs`, a port of the server's
`CriticalPathKernels` over the holiday-free calendar). **Every zero-slack figure in `summary.json` (`zeroSlackCrossProjectLinks`, `zeroSlackChains`, `deepestZeroSlackChain`, and `violated`) holds on the holiday-free calendar only.** SF links are not generated. The chains are exact on the holiday-free calendar of the figures above; with `--polish-holidays` a holiday inside a chained gap can leave that link violated on the server
(a violated link ends the chain). The violated share stays about as it was (the 300 milestone links keep their 35; only the
random project-endpoint links can add to it, the chains never do; the figure is `dependencyStats.violated` in `summary.json`). The totals grow beyond 300 instead of replacing milestone links, so the
milestone links' own mix (types, lags, a quarter across projects) is unchanged; `dependencyStats.crossProject` now counts the project-endpoint links too.

## Generate and test

```bash
node scripts/sample-plan/generate.mjs [--seed 42] [--out sample-data/plan]    # two runs: byte-identical files
node --test scripts/sample-plan/generate.test.mjs
node --test scripts/sample-plan/load.test.mjs
```

The generator's self-test covers determinism, counts, Zipf sizes, acyclicity (both an independent Kahn pass and `graph.mjs`'s port of the server's rule, link by link in both orders), the project-endpoint links in each direction, the chains and the server's limits, and fails when the committed files differ from a fresh run, so a change to the
generator ships with the regenerated files (`.gitattributes` keeps them LF). The loader's self-test runs it against `http.createServer` stubs: the development-stack check, argument
refusals, the reset matching, the collision preflight, the token refresh and the dependencies phase against a stub that replays the server's cycle rule.

## Load (development stacks only)

```bash
read -rs ASTROLABE_ADMIN_PASSWORD && export ASTROLABE_ADMIN_PASSWORD
node scripts/sample-plan/load.mjs --base-url http://localhost:8086 [--anchor 2027-01-04] [--logins] [--reset] [--polish-holidays] [--concurrency 6] [--insecure-http]
```

- **Refuses a stack that is not a development stack**, before it reads or sends the password: `GET /openapi/documentation.yaml` must answer 200 with a real `openapi: 3` document
  (a production stack answers that path with the SPA's HTML or a 404), without a redirect (production redirects to HTTPS) and without `Strict-Transport-Security` (production sends
  it whatever `HTTP_EXPOSE_OPENAPI` says), so a production-mode deployment stays refused even with the document exposed. On a development-mode stack that switched the document off, set `HTTP_EXPOSE_OPENAPI=true`.
- Plain `http` is accepted for `localhost`, loopback addresses and `*.local` hosts; any other host needs `https` or `--insecure-http`. A URL with credentials is refused.
- The admin password is read from `ASTROLABE_ADMIN_PASSWORD` only (`ASTROLABE_ADMIN_EMAIL` defaults to `admin@astrolabe.local`); an account with email MFA is refused. The session is
  revoked (`/logout`) at the end.
- Order: people (+ logins with `--logins`) -> teams -> work streams -> programs -> projects (with their target windows) -> milestones -> schedule PUTs -> dependencies -> capacity
  periods -> the project ranking -> the team orders -> (with `--polish-holidays`) the public holidays. Bounded concurrency (`--concurrency`, default 6; the server serialises plan writes on its plan lock anyway).
- **The ranking is added to, not replaced.** `PUT /roadmap/ranking` replaces the whole global rank, so the loader sends the stack's existing ranked projects first (in their order, minus any
  sample project) and the 80 sample projects after them; it fails before the PUT if that would pass the 1,000-project cap.
- **`--polish-holidays`** (v0.7) applies the Polish preset (`POST /public-holidays/apply-preset`) for every calendar year the dataset's planning dates span (target windows, milestone spans,
  capacity starts; it depends on `--anchor`, and a work stream's start date does not count: no calendar rule reads it). It only ever **adds**: it is idempotent (a date that already holds a
  holiday is skipped, so a second run adds nothing), it runs after the load, so it needs a load in the same run (a stack that already holds the sample plan stops, as always, unless `--reset`),
  and `--reset` never removes holidays. The holiday dictionary is **global, not sample-owned**: other writers may hold rows in it, and the flag neither claims nor cleans them.
  The generator's `summary.json` statistics (loaded weeks, overloaded weeks, violated links) are **holiday-free by construction**; with the preset loaded the server's own figures differ
  slightly (`timeline.md` "Measured figures (v0.7)").
- `--logins` needs `ASTROLABE_SAMPLE_LOGIN_PASSWORD` (10 to 71 bytes) and creates one login per person, linked to it.
- **Collisions stop the load.** Names of teams, programs and work streams are unique across the whole plan: when a real (non-sample) one already uses a name of the dataset the loader
  lists it and writes nothing.
- **What counts as an earlier load**, for the "already present" stop and for `--reset`: a work stream with one of the dataset's names AND an owner who is a sample person (a person whose
  email is one of `people.json`'s), the programs and projects under it that sample people own, the sample teams (a dataset name AND a sample manager), the sample people and the
  `@sample.astrolabe.local` logins. A real work stream that merely shares a sample name is not matched (it is a collision instead). If a matched sample work stream also holds a program or project
  that sample people do not own, the loader refuses and lists them, even with `--reset`: it never deletes what it did not create. `--reset` removes projects (their milestones and links go
  with them), programs, work streams, teams, people and logins, in that order, then loads.

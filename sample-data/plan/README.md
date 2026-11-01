# Sample plan (development data, never production)

A deterministic planning dataset at the intended scale, written by `scripts/sample-plan/generate.mjs` (seed 42, mulberry32, no clock) and replayed through the public
API by `scripts/sample-plan/load.mjs`. It exists to exercise the Timeline's virtualised path (the largest team's page), the team view's weekly load, capacity
and WIP warnings, the team order override and the roadmap ranking at the scale the product is built for. It is **never** loaded into production, never copied into an image
(`.dockerignore`), and the Playwright suite never loads it.

## Contents

Headline counts: 30 people, 15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones (100 of them unscheduled), 300 dependencies, 80 ranked projects, 3 custom team
orders (the self-test asserts these). **Every other figure** (team sizes, scheduled rows per team, dependency types and how many are violated, the capacity mix, the share of loaded weeks
tuned to be overloaded or over the WIP limit) is in `summary.json`, which the generator writes and the self-test recomputes: read it there, not here.

| File | What |
|---|---|
| `people.json` | 30 people (Polish names, `<first>.<last>@sample.astrolabe.local`, unlinked): 15 team managers (persons 1-15) and 15 owners (16-30) |
| `teams.json` | 15 teams, one manager each; sizes follow the Zipf rank-size rule (size of rank k = size of rank 1 / k), Platform the largest |
| `plan.json` | 5 work streams, 20 programs, 100 projects with owners; 60 projects carry a target window (some tighter than their milestones, so drift shows) |
| `milestones.json` | 1,000 milestones (6 to 14 per project, named from a 14-word delivery vocabulary, unique per project), 0.5 to 40 man-days; some spans start or end on a weekend |
| `dependencies.json` | 300 milestone-to-milestone links (FS, SS, FF; lags -5..10 working days; a quarter across projects), acyclic by construction |
| `capacity.json` | 2 to 4 capacity periods per team: most start on a Monday, some mid-week, two on a weekend day; about half carry a `wipLimit` |
| `ranking.json` | the global project rank: 80 of the 100 projects ranked, 20 unranked |
| `team-orders.json` | custom (partial) milestone orders for 3 teams |
| `summary.json` | seed, counts and the derived statistics named above |

Records refer to each other by `ref` (1-based per file). **Every date is a day offset from an anchor Monday** (offset 0 = the anchor, so `7 * n` is a Monday and `7 * n + 5` a
Saturday): the loader resolves them with `--anchor` (default the Monday of the current week), so the plan surrounds today and the dataset never ages. The generator draws the
schedule first, then tunes each capacity period against the team's own load (a quantile of its weekly loads and of its daily work in progress), so the overload and WIP warnings
appear at a visible rate. Dependencies are acyclic by construction: every link goes from an earlier to a later milestone in (project rank, stage) order.

## Generate and test

```bash
node scripts/sample-plan/generate.mjs [--seed 42] [--out sample-data/plan]    # two runs: byte-identical files
node --test scripts/sample-plan/generate.test.mjs
node --test scripts/sample-plan/load.test.mjs
```

The generator's self-test covers determinism, counts, Zipf sizes, acyclicity and the server's limits, and fails when the committed files differ from a fresh run, so a change to the
generator ships with the regenerated files (`.gitattributes` keeps them LF). The loader's self-test runs it against `http.createServer` stubs: the development-stack check, argument
refusals, the reset matching, the collision preflight and the token refresh.

## Load (development stacks only)

```bash
read -rs ASTROLABE_ADMIN_PASSWORD && export ASTROLABE_ADMIN_PASSWORD
node scripts/sample-plan/load.mjs --base-url http://localhost:8086 [--anchor 2027-01-04] [--logins] [--reset] [--concurrency 6] [--insecure-http]
```

- **Refuses a stack that is not a development stack**, before it reads or sends the password: `GET /openapi/documentation.yaml` must answer 200 with a real `openapi: 3` document
  (a production stack answers that path with the SPA's HTML or a 404), without a redirect (production redirects to HTTPS) and without `Strict-Transport-Security` (production sends
  it whatever `HTTP_EXPOSE_OPENAPI` says), so a production-mode deployment stays refused even with the document exposed. On a development-mode stack that switched the document off, set `HTTP_EXPOSE_OPENAPI=true`.
- Plain `http` is accepted for `localhost`, loopback addresses and `*.local` hosts; any other host needs `https` or `--insecure-http`. A URL with credentials is refused.
- The admin password is read from `ASTROLABE_ADMIN_PASSWORD` only (`ASTROLABE_ADMIN_EMAIL` defaults to `admin@astrolabe.local`); an account with email MFA is refused. The session is
  revoked (`/logout`) at the end.
- Order: people (+ logins with `--logins`) -> teams -> work streams -> programs -> projects (with their target windows) -> milestones -> schedule PUTs -> dependencies -> capacity
  periods -> the project ranking -> the team orders. Bounded concurrency (`--concurrency`, default 6; the server serialises plan writes on its plan lock anyway).
- **The ranking is added to, not replaced.** `PUT /roadmap/ranking` replaces the whole global rank, so the loader sends the stack's existing ranked projects first (in their order, minus any
  sample project) and the 80 sample projects after them; it fails before the PUT if that would pass the 1,000-project cap.
- `--logins` needs `ASTROLABE_SAMPLE_LOGIN_PASSWORD` (10 to 71 bytes) and creates one login per person, linked to it.
- **Collisions stop the load.** Names of teams, programs and work streams are unique across the whole plan: when a real (non-sample) one already uses a name of the dataset the loader
  lists it and writes nothing.
- **What counts as an earlier load**, for the "already present" stop and for `--reset`: a work stream with one of the dataset's names AND an owner who is a sample person (a person whose
  email is one of `people.json`'s), the programs and projects under it that sample people own, the sample teams (a dataset name AND a sample manager), the sample people and the
  `@sample.astrolabe.local` logins. A real work stream that merely shares a sample name is not matched (it is a collision instead). If a matched sample work stream also holds a program or project
  that sample people do not own, the loader refuses and lists them, even with `--reset`: it never deletes what it did not create. `--reset` removes projects (their milestones and links go
  with them), programs, work streams, teams, people and logins, in that order, then loads.

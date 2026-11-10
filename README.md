# Astrolabe

Astrolabe is a planning and roadmapping app (Jira-Plans-like, better UX, more opinionated, Gantt-centred) for a multi-stream / multi-program / multi-team environment. It keeps its own plan
data in a four-level hierarchy — **work stream → program → project → milestone** — shown in four views (project, team, roadmap, programs) on one shared timeline component. Projects are ranked
globally, teams schedule their milestones against capacity, and dependencies and overload only ever warn. It compares the plan with Jira (by polling, or on a manual refresh) and with Flow (its teams and their capacity) to detect deviations and, on request, to import its items into the plan; corrections are made in
Astrolabe and nothing is written back. Connecting to Jira (Test connection) was verified on a real Jira Cloud site in 1.5.1; the Jira sync, import and deviations, and the Flow sync, are proven against built-in stubs (the capacity deviation also read-only against a copy of real Flow data). The name is the instrument: a tool for reading where everything stands against time.

## What's here today (1.10.0 — sync follow-ups)

Astrolabe's repository started as an exact copy of [Flow](https://github.com/liveweird/flow) (1.35.0, `e9c3b726`), trimmed to its generic foundation. 0.2.0 added the plan's structure, 0.3.0 the first timeline view, 0.4.0 the dependencies, 0.5.0 the team view with capacity,
0.6.0 the roadmap and programs timelines, 0.7.0 the calendar and the critical path, 0.8.0 the auto-proposal, 0.9.0 baselines, 1.0.0 the checkup, 1.1.0 the Jira connection, 1.2.0 the import from Jira, 1.3.0 polling with Jira markers on the timelines, 1.4.0 coverage with story roll-ups, 1.5.0 the Flow connection (teams, capacity import, roster), 1.6.0 the capacity deviation, 1.7.0 the planning features (the critical path on the team page and the roadmap, pinned dates, two baselines compared) 1.8.0 the cross-team run (one schedule proposal and one accept across several teams, link warnings that follow the ticked moves), 1.9.0 the Flow follow-ups (a per-sprint acknowledge of capacity differences from Flow, and a Flow capacity flag on the team page) and 1.10.0 the sync follow-ups ("Acknowledge all", acknowledgements that end with their line, a retried and classified Jira gone-probe, import from Jira on the Plan page, and a Home page that links to the plan, the roadmap and the deviations):

- **People** — the directory of the plan's owners and managers, each optionally linked to a login; a team's manager is a person.
- **Work streams, programs and projects**, each with an owner; owners edit what they own and everything below it, ADMIN everything. A project carries an optional target window; a work
  stream is closed by setting its end date. The **Plan** page shows the whole hierarchy with the actions the caller may take.
- **Milestones** in a project (one team, a man-day estimate), scheduled only by the manager of the milestone's team or ADMIN. The **project view** (`/projects/:id`) shows them on the
  shared timeline — week/month/quarter zoom, hatched weekends, a today line, the target window as a band, the derived span and its drift — with drag/resize, a full keyboard path and an
  Unscheduled tray. Projects and programs can be moved to another parent by the owners above them.
- **Dependencies** between milestones and projects, across projects and teams: finish-to-start, start-to-start, finish-to-finish and start-to-finish, with a lag in working days (a negative lag is a lead). A link that would close a cycle is refused and the dialog names the cycle; the project view draws the links as arrows, and a link whose dates no longer hold is drawn red and listed first under Dependencies — nothing moves by itself.
- The **team view** (`/teams/:id`) — the team's milestones across projects on the shared timeline, scheduled by the team's manager; **capacity periods** (man-days per week from any date, an optional WIP limit) and a sticky weekly **load strip** that warns in orange about overloaded weeks and weeks over the WIP limit; the team's own **order of work** (row menu or a row drag handle; the project ranking is only its default, and Reset restores it). A deterministic 1,000-milestone sample plan can be loaded through the API ("Try it at scale" below).
- The **Roadmap** (`/roadmap`) — one global project ranking on the shared timeline: a row per project in rank order (the span its milestones cover over the target window's band, flags as row icons with a collapsible flag panel, rolled-up dependency arrows, Month/Quarter/Year zoom), an "Unranked" divider and the unranked projects below it, filters (work stream, team, owner, flagged only) and a program pick remembered in the browser. An ADMIN or a holder of the per-user `ROADMAP_EDITOR` permission re-ranks by dragging a row by its handle (below the divider = unrank) or from the row menu (Move up/down/top/bottom, Rank, Unrank); a concurrent edit is detected and reloaded.
- The **Programs** page (`/programs`) — the plan as a collapsible tree on the same timeline: work stream → program → project. A work stream's or program's bar is the span its projects cover and the counts beside it roll up the flags raised on those projects; opening a program shows its projects as the Roadmap draws them (target window, span, drift band, flag icons) with the rolled-up arrows between the rows shown. Expand/collapse is a button with `aria-expanded` (keyboard-operable and announced), Expand all / Collapse all, Month/Quarter/Year zoom and the same program pick as the Roadmap. Everyone reads it.
- The **calendar and the critical path** (0.7.0) — an ADMIN-curated list of **public holidays** (`/public-holidays`, add by hand or apply the Polish preset for a year); every working-day figure (dependency checks and lags, weekly load, capacity, WIP, the roadmap's links) skips them, and the timelines hatch them. The project page has a **Critical path** toggle (off by default, remembered in the browser): it outlines the chain of milestones and links, across projects, that determines the project's end, adds a **Slack** column (the working days a milestone could slip before that end moves) and lists the farther chain members under "Critical chain". The project and team pages mark **idle gaps** (3 or more working days with nothing in progress) as hatched bands and list them in an "Idle gaps" table. Nothing moves by itself.
- The **schedule proposal** (0.8.0) — on a team's page, the team's manager (or ADMIN) presses **Propose schedule**: the server places the team's not-started milestones in the team's order, after their dependencies, within capacity and the WIP limit, on the holiday calendar, and answers a proposal; nothing moves yet. The page shows it as dashed bars beside the current ones, a "Proposed load" strip and a table of moves (what changes, the working days, links it would violate or resolve), each with a checkbox. **Accept selected** writes the ticked moves in one batch under the same rights as dragging a bar; a milestone someone moved in the meantime is skipped ("rescheduled in the meantime") and the rest land; **Discard** drops the proposal. Other teams' dates are constraints, and a proposal never reorders the team's work. Since 1.8.0 the link warnings and the strip follow the ticked moves, and **Schedule proposals** (`/schedule-proposals`, under Planning) runs one proposal over several teams at once (the teams in dependency order, to a fixed point, one section per team) with one accept across teams, for a manager of every chosen team or an ADMIN.
- **Baselines** (0.9.0) — an ADMIN or a user with the roadmap-editor grant takes a named, immutable **baseline** of the whole plan on `/baselines` (every milestone's dates and estimate and every project's span, frozen at one plan revision; up to 100, deleting makes room). Every timeline page then has a **Baseline** picker: a thin gray shadow bar under each bar, a **Movement** table on the project and team pages (start and end in working days later or earlier, estimate change, new / removed / unscheduled since the baseline) and a totals line on the roadmap and programs pages; `/baselines/:id` compares the baseline with the plan, project by project. Accepting a proposal after the team's plan changed since it was made writes nothing and proposes again.
- **Jira** (1.1.0, import 1.2.0, polling and markers 1.3.0, coverage 1.4.0) — an ADMIN connects a Jira Cloud site on Administration → Jira (the API token is stored encrypted) and presses **Test connection** (probe by probe, with the scope each failed probe needs), maps the program, project and milestone levels to Jira hierarchy levels and fields (defaults from Jira Plans' names; **Peek** reads one issue through the mapping), and **Refresh now** reads the linked items. Owners and ADMIN link a project or milestone 1:1 to a Jira item from its page (programs are linked on the connection page); the **Deviations** page and the chips on the project and team pages show where the plan and Jira disagree (dates in working days, names, parents, estimates, progress, items gone). An ADMIN can **import from Jira** on the connection page (since 1.10 a work stream's owner can also start it from the stream's menu on the Plan page): a preview of what would be created, linked or skipped, then an apply into one picked work stream (existing plan items are never overwritten; linking is by name, so an item renamed in Jira previews as a new one; dates are copied only where the caller manages the team). Since 1.3.0 each connection is **polled** by the app itself (every 15 minutes by default, 5 minutes to a day, or manual only; failures back off to six hours) and shows a **status** (Current, Stale, Failed, Never synced, Disabled) on the Jira pages and the telemetry panel; an owner or ADMIN can **acknowledge** an item's deviations until they change; open deviations show as **Jira flags** on the roadmap, programs, project and team pages, and a dashed **Jira dates** bar (a toolbar toggle) under the linked rows. Since 1.10 an item that vanished is read once by its id and told apart (deleted, no longer visible to the connection's account, or moved out of its projects), and a read that did not answer is retried by later refreshes. Since 1.4.0 the same polling also reads the child issues, so the Deviations page lists the open Jira items under a linked program or project that nothing in the plan is linked to, the plan items under it that are not linked to Jira, and the epics whose children are all done, and a milestone linked to an epic shows its story roll-up (`5/12 · 34 pt`) after its Jira key. Nothing is written to Jira. **Test connection was verified on a real Jira Cloud site (1.5.1); the sync, import and deviations are proven against the built-in stub only** ("The Jira stub" below).
- **Flow** (1.5.0, capacity deviation 1.6.0) — an ADMIN connects a Flow instance (the sibling app; its read-only service token is stored encrypted, the base URL must be on the operator's allow-list) on Administration → Flow; the connection is polled (every 60 minutes by default) and mirrors Flow's teams with their sprints and members. A team's manager (or ADMIN) links a team to its Flow team by name, reads its **roster** on the team page and **imports its capacity** (a sprint's man-days spread over its working days, preview then apply; hand-entered periods are never changed). Since 1.6.0 the **Deviations** page has a "Capacity from Flow" section and the team page a "Capacity vs Flow" line: per current or future sprint, a warning when the plan holds more capacity than Flow (0.5 man-days or more), an info when it holds less. Since 1.9.0 the team's manager (or ADMIN) can **acknowledge** one sprint's difference ("known, leave it": it reopens only when that sprint's figures change), and the team page's header and weeks strip flag the open differences; since 1.10 **Acknowledge all (N)** does a team's open lines in one step, and an acknowledgement ends with its line (a sprint back in line, closed or gone from Flow loses it, so a difference that returns is open). Nothing is written to Flow. **Proven against the built-in Flow stub** ("The Flow stub" below), and read-only against a copy of real Flow 1.57.1 data.
- **Sign-in** with a JWT access/refresh pair, a server-side revocation blocklist, per-account lockout and per-IP rate limits; opt-in **email MFA**; **self-service password reset** by an
  emailed single-use link.
- **Users** (ADMIN-managed, `/api/v1/users`) with per-user **feature flags**, **permissions** and a synced UI/email **language** (English and Polish).
- **Teams** — a flat registry with an optional manager.
- The React **shell**: navigation model, command palette, light/dark theme in the deep-cyan Astrolabe brand, a changelog, and the ADMIN **telemetry panel** (memory, JVM, requests and storage
  of the running process, 90 days of history).
- The quality gates, the Docker/Compose/Kubernetes deployment and a Playwright e2e suite, all inherited from Flow.

## Roadmap

0.1.0 the foundation · 0.2.0 plan structure · 0.3.0 the timeline and the project view · 0.4.0 dependencies · 0.5.0 the team view
and capacity (shipped) · 0.6.0 roadmap and programs timelines (shipped) · 0.7.0 calendar and critical path (shipped) · 0.8.0 auto-proposal (shipped) · 0.9.0 baselines (shipped) · 1.0.0 checkup (shipped) · 1.1.0 Jira connection, bindings and deviations (shipped) · 1.2.0 import from Jira (shipped) · 1.3.0 polling, status, acknowledge and markers (shipped) · 1.4.0 coverage and roll-ups (shipped) · 1.5.0 Flow teams, capacity and roster (shipped) · 1.5.1 fixes from the first real Jira and Flow connections · 1.6.0 the capacity deviation, plan against Flow (shipped) · 1.7.0 planning features: critical path reach, pinned dates, baseline-vs-baseline (shipped) · 1.8.0 the cross-team run (shipped) · 1.9.0 Flow follow-ups: the capacity acknowledge and the team page's Flow flag (shipped) · 1.10.0 sync follow-ups: acknowledge all, acknowledgements that end with their line, the retried Jira gone-probe, the Home page (shipped). The scope of each version and the decisions
behind it: `.claude/docs/product.md`; open items: `BACKLOG.md`. `CLAUDE.md`'s "Product" and "Donors" sections say which sibling project each capability ports from.

## The stack

- **Backend**: Kotlin + [Ktor](https://ktor.io) (Netty), JWT auth with refresh tokens and a
  server-side revocation blocklist, PostgreSQL with [Flyway](https://flywaydb.org) migrations and
  [Exposed](https://github.com/JetBrains/Exposed) (R2DBC), OpenTelemetry, RFC 7807 problem-detail
  errors, Swagger UI at `/openapi` (development mode). Application-level encryption at rest
  (`infra/crypto/FieldCipher`, AES-256-GCM) is in place for the credentials the future sync will store. One process serves everything.
- **Frontend**: [Vite](https://vite.dev) + React 19 + TypeScript + [Mantine](https://mantine.dev),
  react-i18next (English + Polish), a typed API client generated from the OpenAPI contract.
- **Quality gates**: detekt (zero findings), Kover coverage floors, dependency-family alignment,
  ESLint + sonarjs, knip, Vitest coverage floors, runtime OpenAPI conformance in the server test
  suite, and Playwright e2e with axe accessibility scans. Pushes to `master` and pull requests run
  the server/web gates and E2E static/setup checks; the full browser suite runs nightly and on
  demand.

## Running the whole stack (one command)

```bash
docker compose up --build
```

Then open <http://localhost:8086> and sign in as `admin@astrolabe.local` / `changeme`. This compose
file runs in development mode (`KTOR_DEVELOPMENT=true`), which tolerates the seed admin's
well-known `changeme` password (the V3 seed migration); any real deployment ships `KTOR_DEVELOPMENT=false` (the Docker
image's default) and **refuses to start** while any active account still carries that password —
set `ADMIN_INITIAL_PASSWORD` to rotate it at first boot instead (see "Configuration" below and
`.claude/docs/security.md`). Swagger UI: <http://localhost:8086/openapi>. Mailpit (reset and MFA
email): <http://localhost:8029>.

Ports are chosen to coexist with the sibling stacks on the same machine (the full table is in
`.claude/docs/ci.md`): the app is on **8086**, Postgres is host-mapped to **5437**, the Vite dev server uses **5178**,
Mailpit **8029**, the Jira stub **8096**, the Flow stub **8097**. All host ports bind to 127.0.0.1.

**The Jira stub.** The compose file also runs `jira-stub` (`astrolabe-jira-stub`, WireMock over the deterministic dataset in `sample-data/jira-stub`, built from its own directory)
and points the app at it with `JIRA_STUB_BASE_URL=http://jira-stub:8080`, so the Jira sync works offline: sign in as the admin, Administration → Jira → New connection
(site `https://stub-sample.atlassian.net` — the stub serves only sites whose name starts with `stub-`; any other site reaches Atlassian, so a real tenant can be connected on the same stack —, any email, any token, project keys `CE,PF,CG,DI,OE` — the stub's five work-stream projects; `E2E` is the e2e suite's; `IMP`, a small isolated project of 9 issues, is the safe one to try **Import from Jira…** on, into a throwaway work stream) → Test connection (a tested connection is then polled every 15 minutes by default, so its runs table gains Scheduled rows by itself). **Importing the five work-stream projects into their real work streams creates real plan rows** (the stub's deliberately renamed items do not match any plan name and preview as new), so read the preview and its totals first. A token
of `wrong-token` makes every authenticated probe fail (`tenant_info` is unauthenticated and still passes). The app does not depend on the stub (it boots, and the rest of the product works, without it) and the stub holds no data
of yours; flip its day-2 scenario with `curl -X PUT http://localhost:8096/__admin/scenarios/jira-day2/state -d '{"state":"day2"}'`. The stub exists in development mode only:
production startup refuses `JIRA_STUB_BASE_URL` ("Configuration" below), and any real deployment leaves it unset.

**The Flow stub.** Likewise `flow-stub` (`astrolabe-flow-stub`, host port **8097**; the same WireMock image over `sample-data/flow-stub`, generated from the contract in
`sample-data/flow/contract.mjs`): Flow 1.57.0's read-only service-token surface (`GET /api/v1/integration/me` and `/teams`, 19 teams with sprints and members, one accepted
fake token, `sample-data/flow/README.md`). The app is pointed at it by `FLOW_INSECURE_ORIGINS=http://flow-stub:8080` (development mode only; the Flow connection of v1.5.0 reads it, and the server suite uses it as its test double). Flip its day-2 scenario with `curl -X PUT http://localhost:8097/__admin/scenarios/flow-day2/state -d '{"state":"day2"}'`
or simulate an outage with the `flow-outage` scenario (state `down`). **A real Flow** running as its own compose stack: start Flow's stack first, then
`docker compose -f docker-compose.yaml -f docker-compose.real-flow.yaml up --build` (the override joins Flow's network `flow_default`, lists `http://flow-app:8084`, and addresses Astrolabe's own postgres, mailpit and Jira stub by their `astrolabe-*` container names because Flow's containers share the bare names on that network; Flow can reach `astrolabe-app:8086` there too; development only, not exercised by CI), and create the connection with the base URL `http://flow-app:8084`. The form lists the origins this server allows.

On a cold start the app waits for Postgres rather than exiting: Flyway retries its boot connection
(`POSTGRES_CONNECT_RETRIES`, default 10 — about a minute of backing-off attempts; see "Configuration"),
so `docker compose up` and Kubernetes restarts need no manual ordering.

## Try it at scale (development only)

A deterministic sample plan at the intended scale (15 teams with Zipf-skewed sizes, 5 work streams, 20 programs, 100 projects, 1,000 milestones, 349 dependencies (milestone and project ends, with zero-slack chains for the critical path), capacity periods with
WIP limits, a project ranking, three custom team orders) is committed in `sample-data/plan/` and replayed through the public API by a loader. **Never production:** the loader
refuses any stack that does not serve `GET /openapi/documentation.yaml` (a development stack, like the compose one; a redirect or an HSTS header also means production), before it sends a
credential, and the data is never part of an image. Node 24 only, nothing to install:

```bash
read -rs ASTROLABE_ADMIN_PASSWORD && export ASTROLABE_ADMIN_PASSWORD   # the seed administrator's password (typed, never read from a file)
node scripts/sample-plan/load.mjs --base-url http://localhost:8086                # load: dates land on the Monday of this week
node scripts/sample-plan/load.mjs --base-url http://localhost:8086 --reset        # replace an earlier load
read -rs ASTROLABE_SAMPLE_LOGIN_PASSWORD && export ASTROLABE_SAMPLE_LOGIN_PASSWORD   # 10 to 71 bytes
node scripts/sample-plan/load.mjs --base-url http://localhost:8086 --reset --logins   # + one login per person
```

The loader prints progress and a summary (about 15 s against a local stack) and names the largest team's page (`/teams/<id>`). `--logins` creates `<first>.<last>@sample.astrolabe.local` for
every manager and owner so you can sign in as a team manager; `--anchor YYYY-MM-DD` pins the Monday the dates are offset from. It stops before writing anything when a real team, program
or work stream already uses one of the dataset's names, and `--reset` only deletes what it can recognise as its own (a sample name together with a sample owner); the sample projects are
added to the stack's existing project ranking, which stays as it was. Plain `http` is accepted for `localhost`, loopback and `*.local` hosts only (`--insecure-http` overrides). The files are
regenerated with `node scripts/sample-plan/generate.mjs` (byte-identical for the same seed); `node --test scripts/sample-plan/generate.test.mjs` and `node --test scripts/sample-plan/load.test.mjs` pin that, the
dataset's invariants and the loader's refusals against http stubs, and runs in `scripts/gates.sh e2e` and CI. Details: `sample-data/plan/README.md`.

## Running on Kubernetes (local)

Two Deployments, each a single replica with `Recreate` updates (the old pod stops before the
new one starts, so an upgrade briefly interrupts it): `postgres` and `app` (the HTTP API and the SPA; one process, no worker). The application pod migrates on boot and, under the local overlay below, runs in
development mode (`KTOR_DEVELOPMENT=true`, no proxy), in the `astrolabe` namespace. The overlay adds a third, `jira-stub` (`k8s/local/jira-stub.yaml`: the same WireMock image as compose, a
ClusterIP Service `jira-stub:8080`, and the NetworkPolicy pair app → jira-stub); `apply-local.sh` builds it as `astrolabe-jira-stub:<tag>` and the overlay ConfigMap gives the app
`JIRA_STUB_BASE_URL=http://jira-stub:8080`. The production base `k8s/` has neither the stub nor the URL. A fourth, `flow-stub` (`k8s/local/flow-stub.yaml`, the same shape;
`FLOW_INSECURE_ORIGINS=http://flow-stub:8080`), and `k8s/local/flow-egress.yaml` (app → a real Flow in the `flow` namespace, port 8084; harmless when absent) ride the same overlay.

With a local cluster that shares the Docker image store (e.g. OrbStack):

```bash
ASTROLABE_IMAGE_TAG="dev-$(git rev-parse --short=12 HEAD)-$(date +%s)"
docker build -t "astrolabe-app:${ASTROLABE_IMAGE_TAG}" .
kubectl create namespace astrolabe
# create the astrolabe-secrets Secret — see the header comment in k8s/secret.yaml
./k8s/apply-local.sh "$ASTROLABE_IMAGE_TAG"
```

The helper renders the deployment image with the selected build tag, excludes the Secret
template, and applies the OrbStack overlay `k8s/local/front-door.yaml` instead of the base
`k8s/front-door.yaml` (below). Use a new tag for each rebuild — the new pod is what reads the overlay;
do not apply `k8s/` directly, since the checked-in image name is a placeholder and the base ConfigMap
is the production posture. An existing installation already has the namespace and Secret.

The manifests are hardened: no ServiceAccount token in any pod, non-root/seccomp/`drop: [ALL]` on the
app and postgres containers, and `k8s/network-policies.yaml` — default-deny plus only
app → postgres:5432, DNS and public egress on 443 / 587, 465, 25 (SMTP), and 8086 into
the app (the overlay adds app → jira-stub:8080 and → flow-stub:8080 (plus → namespace `flow`:8084), because the egress rule excludes every private range, the pod network included). NetworkPolicy is enforced only by a CNI that implements it (OrbStack's cluster does). Details
in `.claude/docs/security.md` ("Kubernetes pod and network hardening"). CI validates every manifest and
the `apply-local.sh` render with `kubeconform` (`k8s-static` job).

**The front door (decision for 1.0.0): Kubernetes stays local on OrbStack.** `app` is exposed through a bare
`type: LoadBalancer` Service over plain HTTP, so the `app` Deployment takes `KTOR_DEVELOPMENT`,
`HTTP_BEHIND_PROXY` and `HTTP_PROXY_HOPS` from the ConfigMap `astrolabe-front-door` and `apply-local.sh`
applies the overlay `k8s/local/front-door.yaml`: `KTOR_DEVELOPMENT=true`, `HTTP_BEHIND_PROXY=false`. No manual
editing, and plain `http://<loadbalancer-ip>:8086` just works (no `X-Forwarded-Proto` needed). Development mode
is a different posture, not just "HTTP allowed": the fail-closed startup checks, the rate-limit buckets, `/openapi`
and the mail rules all relax (the full list: `.claude/docs/security.md`, "Security posture: development vs
production mode"). The real secrets still come from `astrolabe-secrets`, and `ADMIN_INITIAL_PASSWORD` still
rotates the seeded admin. Never use the overlay in a shared or production cluster; `apply-local.sh` refuses
unless the kubectl context is `orbstack` (override on purpose with `ASTROLABE_KUBE_CONTEXT=<name>`).
Never use `kubectl apply -R -f k8s/`: it applies both ConfigMaps (the overlay last) and the placeholder
Secret over the real one.

The base `k8s/front-door.yaml` stays the **production posture** (`KTOR_DEVELOPMENT=false`,
`HTTP_BEHIND_PROXY=true`, `HTTP_PROXY_HOPS=1`) for a deployment behind a TLS-terminating Ingress that sets
and overwrites `X-Forwarded-For`/`-Proto`. It is **unsafe behind a bare LoadBalancer**: plain HTTP gets a
`301` to `https://…`, and the `X-Forwarded-*` headers are client-controlled, so the per-IP rate-limit
buckets key on a value the caller controls and a caller can send `X-Forwarded-Proto: https` to skip the
redirect. No Ingress is shipped; such a deployment adds one (with a `ClusterIP` Service) and narrows
`allow-app-ingress` to the controller's namespace. Treat this manifest set as a local reference, not a
production recipe.

## Local development

Run each long-lived process in a separate terminal from the repository root:

```bash
docker compose up postgres mailpit   # database on :5437 and local mail on :8029
./gradlew :server:run                # API on :8086
(cd web && npm install --legacy-peer-deps && npm run dev)    # SPA on :5178
```

The local JDK and Node runtime are pinned in `mise.toml` (Temurin 21 and Node 24 LTS). Run
`mise install` and use `mise exec -- <command>` or activate mise in your shell. If `./gradlew`
resolves the wrong JDK (a system JRE ahead of the mise shim on `PATH`), point it explicitly:
`JAVA_HOME=$(mise where java) ./gradlew build`. If server tests need a Docker daemon and you use
OrbStack without `/var/run/docker.sock`, export `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`
first. See [dependency maintenance](.claude/docs/dependencies.md) for compatibility pins,
automated updates, and runtime verification. The gates, timed the way CI runs them: `scripts/gates.sh [server|web|e2e|all]`.

## Configuration (environment variables)

`server/src/main/resources/application.yaml` is the authoritative reference — every setting there
is a `$VAR:default` pair, and the table below lists them (defaults as shipped; the
Docker image additionally sets `KTOR_DEVELOPMENT=false`, `MAIL_TRANSPORT=disabled` and
`WEB_STATIC_DIR=/app/web`). Production mode refuses the burned demo keys and the `log` mail
transport at startup (`.claude/docs/security.md`).

JVM options are not in the table: the image bakes its heap/GC flags (`server/build.gradle.kts`), so size a deployment with
`JAVA_OPTS` (the baked heap is `-Xmx256m`). Leave `SERVER_OPTS` unset — the image uses it to switch on its
class-data-sharing (AppCDS) archive, and setting it drops the archive. Build-time identity for the telemetry panel: the image build args `ASTROLABE_BUILD_VERSION` and `ASTROLABE_BUILD_COMMIT`.

| Variable | Default | Purpose |
|---|---|---|
| `KTOR_DEVELOPMENT` | `true` | Development mode (`true`) vs production mode — HSTS/HTTPS redirect and the fail-closed startup checks. The image ships `false`. |
| `LOGIN_LOCKOUT_THRESHOLD` | `5` | Consecutive failures per account before `/login` answers 429. |
| `LOGIN_LOCKOUT_DURATION_SECONDS` | `900` | How long a locked account stays locked. |
| `LOGIN_LOCKOUT_MAX_TRACKED` | `10000` | Maximum in-memory login identities; new identities receive 429 at capacity while active counters and locks remain. |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP login bucket; blank follows the mode (10 prod / 1000 dev). |
| `REFRESH_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP refresh bucket (blank = 30). |
| `READY_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP bucket on `GET /api/v1/ready` (blank = 60; the kubelet probes 12/min). |
| `PASSWORD_RESET_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP reset bucket; blank follows the mode (5 prod / 100 dev). |
| `JIRA_TEST_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP bucket on the Jira Test connection and Peek (blank = 10, a number 1..100 pins it; each Test makes up to ~10 outbound calls). `docker-compose.yaml` and the OrbStack overlay pin 30 for the e2e suite. |
| `FLOW_TEST_RATE_LIMIT_PER_MINUTE` | *(blank)* | Per-IP bucket on the Flow Test connection (blank = 10, a number 1..100 pins it). Wired on compose and Kubernetes (30 for the e2e suite). |
| `FLOW_INSECURE_ORIGINS` | *(blank)* | **Development only.** Comma-separated exact `http://host[:port]` origins a Flow connection may name (the compose/Kubernetes-overlay `flow-stub`, port 8097; `docker-compose.yaml` sets `http://flow-stub:8080`, the overlay ConfigMap the same; a real Flow is `http://flow-app:8084` on compose through the `docker-compose.real-flow.yaml` override, `http://app.flow.svc.cluster.local:8084` in the cluster; `host.docker.internal` does not work on OrbStack, its address is in the never-allowed `0.0.0.0/8`). On compose a value in the HOST environment wins and an empty value disables the stub. Production startup **refuses** a non-blank value. Such a host may resolve to a loopback, private or docker address, never to a link-local (metadata), any-local, multicast, `0.0.0.0/8`, `::/96`, `::ffff:0:0:0/96`, 6to4 or Teredo one. A TLS Flow behind a private CA uses `FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE` instead. |
| `FLOW_ALLOWED_HOSTS` | *(blank)* | Operator-only list of the TLS Flow hosts the server may call: exact lowercase DNS names, `host` or `host:port` (https, 443 by default), comma-separated. A Flow connection's base URL must be one of the listed origins (or a `FLOW_INSECURE_ORIGINS` one in development); nothing a user or admin types widens the list. No IP literals, wildcards or credentials; malformed entries refuse startup naming the key. |
| `FLOW_ALLOWED_CIDRS` | *(blank)* | The private ranges a LISTED Flow host may resolve to (a Flow on a private address), e.g. `10.20.0.0/16`; IPv4 no wider than /8, IPv6 no wider than /32, never loopback, link-local (the cloud metadata address included) or multicast space. Requires `FLOW_ALLOWED_HOSTS`. In Kubernetes the egress NetworkPolicy still needs its own rule for such a host. |
| `FLOW_CA_BUNDLE` | *(blank)* | A PEM file of CA certificates trusted ALONGSIDE the JVM defaults when talking to a listed Flow host (a private CA). There is no way to skip certificate or hostname verification. |
| `FLOW_REQUEST_TIMEOUT_SECONDS` | `30` | One Flow attempt's timeout, 5–120 seconds. |
| `FLOW_REQUEST_DEADLINE_SECONDS` | `60` | The total time one Flow call may spend across every attempt and backoff, 10–600 seconds. |
| `FLOW_MAX_RESPONSE_BYTES` | `1048576` | The most bytes one Flow response may carry (refused as `LIMIT_EXCEEDED` past it), 65536–1048576 (1 MiB keeps Flow's parsed trees inside the heap reserve). The whole teams document is one response (about 150 KB at 15 teams). |
| `FLOW_MAX_CONCURRENT_REQUESTS` | `1` | In-flight Flow calls across every connection, 1–2. |
| `FLOW_MAX_RETRIES` | `2` | Retries of a Flow 429/5xx/network failure (exponential backoff with jitter), 0–8. |
| `FLOW_SPRINTS_SINCE_DAYS` | `365` | A Flow run asks for sprints that ended no earlier than this many days ago, 30–1095. |
| `REFRESH_REPLAY_GRACE_SECONDS` | `60` | How long a rotated refresh token may be replayed (a lost `/refresh` response, two racing tabs) before the replay is a 401; `0` = strict one-time use. In-memory, per instance (`.claude/docs/security.md` "Token storage"). |
| `PASSWORD_RESET_MIN_INTERVAL_SECONDS` | `60` | One reset request per submitted email per interval. |
| `PASSWORD_RESET_MAX_TRACKED` | `10000` | Maximum in-memory reset cooldowns; new identities receive 429 at capacity. |
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | `900` | Lifetime of the emailed single-use reset link, 1–3600 seconds. |
| `MFA_CODE_TTL_SECONDS` | `300` | Lifetime of an emailed MFA code. |
| `MFA_MAX_ATTEMPTS` | `5` | Wrong-code attempts before a challenge dies. |
| `MFA_MAX_TRACKED` | `10000` | Maximum pending email-MFA challenges; new issuance receives 429 at capacity. |
| `MFA_MAX_LIVE_PER_ACCOUNT` | `3` | Live email-MFA challenges one account may hold, 1–100; a new login gets a fresh code (unless the shared store is full) and, at the limit, the account's oldest live challenge is dropped. |
| `DATA_ENCRYPTION_KEY` | *(dev key, burned)* | AES-256-GCM key (64 hex) that encrypts the stored Jira API tokens — the dev default is burned, production refuses it. It cannot be discarded: losing it loses every stored token. Back it up apart from the database. |
| `DATA_ENCRYPTION_KEY_PREVIOUS` | *(blank)* | Decrypt-only fallback during a key rotation: set the OLD key here and the new one in `DATA_ENCRYPTION_KEY`, boot once (every stored token is re-encrypted), then remove it. Wired on compose and Kubernetes (optional there); blank = none. |
| `JIRA_STUB_BASE_URL` | *(blank)* | **Development only.** An `http(s)://host[:port]` origin that stands in for BOTH the `tenant_info` host and the Atlassian gateway of a `stub-` site (a connection whose site name starts with `stub-`; every other site reaches Atlassian) (the compose/Kubernetes-overlay `jira-stub`, port 8096; `docker-compose.yaml` sets `http://jira-stub:8080`, the overlay ConfigMap the same). On compose a value in the HOST environment wins: one exported for `./gradlew :server:run` (e.g. `http://localhost:8096`) is passed into the container, where `localhost` is not the stub, so unset it before `docker compose up`; an empty value disables the stub. Production startup **refuses** a non-blank value (`.claude/docs/security.md` "Outbound HTTP calls"). |
| `JIRA_REQUEST_TIMEOUT_SECONDS` | `30` | One Jira attempt's timeout, 5–120 seconds. |
| `JIRA_REQUEST_DEADLINE_SECONDS` | `180` | The total time one Jira call may spend across every attempt and backoff (the queue for an outbound permit included, a sibling's Retry-After wait not), 10–600 seconds; it must outlast a `Retry-After: 120`. |
| `JIRA_BIND_PERMIT_WAIT_MILLIS` | `5000` | How long a bind (linking a plan item to a Jira item) queues for an outbound permit before it answers `502` with the code `BUSY`, 100–60000 ms; Test connection and the runs are never cut short by it. |
| `JIRA_MAX_RESPONSE_BYTES` | `4194304` | The most bytes one Jira response may carry (refused as `LIMIT_EXCEEDED` past it), 65536–16777216. |
| `JIRA_MAX_CONCURRENT_REQUESTS` | `2` | In-flight Jira calls across every connection, 1–8. |
| `JIRA_MAX_RETRIES` | `4` | Retries of a Jira 429/5xx/network failure (exponential backoff with jitter), 0–8. |
| `JIRA_PAGE_SIZE` | `100` | Issues per Jira search page, 1–500. |
| `JIRA_INCREMENTAL_OVERLAP_MINUTES` | `10` | Minutes added to the time since the last successful Jira run in an incremental bound, 0–1440. |
| `JIRA_CENSUS_HOURS` | `24` | Hours between a Jira run's id-only re-listing of the child level (the stories under the mapped epics, kept for the roll-ups; a full read lists them in full anyway), 1–168. A story deleted or moved out of scope stays in a roll-up for up to this long. |
| `SYNC_MAX_RUN_MINUTES` | `10` | How long a sync run's claim stays valid, 1–60 minutes; a run that outlives it is abandoned by the next claim, and the run's own deadline is one minute shorter (never under 30 s). |
| `SYNC_SCHEDULER_ENABLED` | `true` | The in-process Jira poller: every tick it starts a run for each tested, enabled connection whose own polling interval has elapsed (with a failure back-off up to six hours, and at once after an edit to the connection); `false` leaves "Refresh now" as the only way a run starts. Every instance ticks and the run registry lets exactly one claim a run, so a second replica is safe. |
| `SYNC_TICK_SECONDS` | `60` | How often the poller looks for due connections, 15–600 seconds (validated at every boot); a poll starts at most one tick after its connection's interval has elapsed. |
| `SECURITY_CSRF_ENABLED` | `false` | CSRF plugin gate — off (bearer JWT, no cookies). |
| `JWT_SECRET` | `secret` | HMAC key for the access/refresh pair — production requires a private 64-hex key (`openssl rand -hex 32`); the placeholders and compose demo key are burned. |
| `JWT_ISSUER` | `http://0.0.0.0:8086/` | The `iss` claim the verifier requires. |
| `JWT_AUDIENCE` | `astrolabe-api` | The `aud` claim the verifier requires. |
| `JWT_REALM` | `astrolabe-api` | The `WWW-Authenticate` realm. |
| `JWT_ACCESS_EXPIRES_IN_SECONDS` | `900` | Access-token lifetime (the API bearer). |
| `JWT_REFRESH_EXPIRES_IN_SECONDS` | `3600` | Refresh-token lifetime — the idle-session window. |
| `ADMIN_INITIAL_PASSWORD` | *(blank)* | Rotates the V3 seed admin's `changeme` at startup while it still carries the seed hash; production rejects known placeholders and passwords outside the ordinary account limits. |
| `HTTP_BEHIND_PROXY` | `false` | Honour `X-Forwarded-*` from a TLS-terminating proxy (rate-limit keys, HTTPS redirect). |
| `HTTP_PROXY_HOPS` | `1` | Trusted proxies in front of the app when `HTTP_BEHIND_PROXY=true`; `X-Forwarded-For` is trusted from the END of the list (1 = the last proxy's value). |
| `CORS_ALLOWED_HOSTS` | *(blank)* | Comma-separated cross-origin hosts; blank = CORS not installed. |
| `HTTP_EXPOSE_OPENAPI` | *(blank)* | Serve Swagger UI + the spec at `/openapi`; blank follows the mode. |
| `REQUEST_READ_TIMEOUT_SECONDS` | `60` | Netty idle-read timeout: a request that sends no bytes for this long is answered `408` and its connection closed; `0` = off, otherwise 1..3600 (`.claude/docs/security.md` "Slow requests"). |
| `METRICS_REPORT_INTERVAL_SECONDS` | `300` | How often the Dropwizard metrics registry is dumped to the `metrics` logger: `0` = off, otherwise 30..3600 seconds (`.claude/docs/observability.md`). |
| `TELEMETRY_ENABLED` | `true` | The per-process telemetry sampler (JVM, container memory and connection-pool figures into the `ops` schema, 7 days raw and 90 days hourly): `false` starts none (`.claude/docs/observability.md` "Telemetry"). |
| `TELEMETRY_SAMPLE_INTERVAL_SECONDS` | `300` | How often a process samples itself, 60..1800 and a divisor of 3600. |
| `TELEMETRY_STORAGE_INTERVAL_SECONDS` | `3600` | How often database/schema sizes are measured, 900..86400. |
| `WEB_STATIC_DIR` | *(blank)* | Directory of the built SPA to serve; blank in local dev (Vite serves it). The image sets `/app/web`. |
| `MAIL_TRANSPORT` | `log` | `log` (dev only — production refuses it), `smtp`, or `disabled` (email features answer 503; the image default). |
| `SMTP_HOST` | *(blank)* | SMTP server (required for `smtp`). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | *(blank)* | SMTP user (optional). |
| `SMTP_PASSWORD` | *(blank)* | SMTP password (optional). |
| `SMTP_STARTTLS` | `true` | STARTTLS on the SMTP connection. |
| `MAIL_FROM` | `astrolabe@localhost` | Sender address of every outbound email. |
| `MAIL_APP_URL` | *(blank)* | The deployment's public **origin** (`https://host[:port]` in production — `http` only in development; no path, query or credentials) — the self-service password reset emails a link built from it. A malformed value refuses startup; blank = the reset answers 503. |
| `POSTGRES_JDBC_URL` | `jdbc:postgresql://localhost:5437/astrolabe` | Flyway's JDBC URL. |
| `POSTGRES_R2DBC_URL` | `r2dbc:postgresql://localhost:5437/astrolabe` | The runtime R2DBC URL. |
| `POSTGRES_USER` | `astrolabe` | Database user. |
| `POSTGRES_PASSWORD` | `astrolabe` | Database password. |
| `POSTGRES_CONNECT_RETRIES` | `10` | How many times Flyway retries its boot connection (doubling waits capped at 8 s, ~63 s at 10) so a cold start waits for Postgres instead of crash-looping; `0` fails fast (0..15 — 15 is ~2 min, inside the k8s startup-probe budget). |
| `POSTGRES_POOL_MAX_SIZE` | `20` | Ceiling on concurrent pooled R2DBC connections for this instance (1..1000). |
| `POSTGRES_POOL_INITIAL_SIZE` | `2` | Connections the pool fills up to on its first acquire (0..maxSize). |
| `POSTGRES_POOL_MAX_ACQUIRE_SECONDS` | `10` | How long a caller waits for a free pooled connection before failing (1..600). |
| `POSTGRES_POOL_MAX_IDLE_SECONDS` | `600` | How long an idle pooled connection may sit before recycling (1..86400). |
| `POSTGRES_POOL_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS` | `300` | PostgreSQL's `idle_in_transaction_session_timeout` on every pooled connection: a session left idle inside an open transaction is ended and its locks released (0 = off, else up to 86400; `.claude/docs/persistence.md` "Connection pool"). |

## Useful Gradle tasks

| Task | What it does |
| ---- | ------------ |
| `./gradlew build` | Compiles everything and runs every gate: detekt, tests (Testcontainers), Kover verify, dependency alignment |
| `./gradlew :server:run` | Runs the API against the compose Postgres |
| `./gradlew :server:test` | Server test suite (needs a Docker daemon for Testcontainers) |
| `./gradlew detekt` | Static analysis only |
| `./gradlew :server:checkDependencyAlignment` | One version per aligned dependency family on the runtime classpath |
| `./gradlew :server:installDist` | Builds the runnable distribution (used by the Docker image; never `buildFatJar`) |

Frontend: `cd web && npm run build | lint | test | test:coverage | knip | gen:api`.
E2E: `cd e2e && npm ci && npx playwright install chromium && npm test`.

## License

MIT — see [LICENSE](LICENSE).

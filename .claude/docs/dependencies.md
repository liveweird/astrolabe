# Dependency maintenance

Dependency declarations, lockfiles and `gradle/verification-metadata.xml` are the source of truth.
Keep Gradle and the two npm workspaces (`web/`, `e2e/`) independent; do not upgrade to the newest
major merely because it is available. `.claude/docs/dependency-reproducibility.md` describes the
Gradle lock/checksum mechanism itself (what is covered, the hard empty-`GRADLE_USER_HOME` rule for
regenerating verification metadata, and how to review a regenerated file) — this doc stays focused
on the maintenance workflow: grouping, compatibility pins, and acceptance checks.

## Update automation

`.github/dependabot.yml` checks Gradle, each npm workspace, GitHub Actions, Dockerfiles,
Kubernetes image references, and Compose weekly. Ordinary minor/patch updates are grouped by
workspace. Vitest and its coverage plugins form a separate group so their exact-version peers move
together. The Gradle bulk group excludes Exposed and the Netty/Reactor/OpenTelemetry families:
their pins need individual compatibility review before integration. Exclusion from a group does
not ignore an update or exempt it from review.

Dependabot vulnerability alerts and security update PRs are separate GitHub repository settings
from the version-update configuration, and both are currently **disabled** (Flow's state when checked, 2026-10-06; re-check on the new repository:
`gh api repos/liveweird/astrolabe --jq .security_and_analysis` reports `dependabot_security_updates:
disabled`, and the `vulnerability-alerts` endpoint answers 404); enabling them is the owner's call.
Once on, security updates still need the normal checks; never auto-merge a breaking migration to
clear an alert.

Dependabot does not cover every declaration here. At each monthly maintenance pass, inspect the
exact JDK pin in `mise.toml`, Ktor's imported catalog in `settings.gradle.kts`, and the runtime
versions actually used by cached images and local tools. Compare official release metadata, not
just open PRs. The CI toolchain pins (`.nvmrc`, the `java-version` in `ci.yml`, the wrapper checksum,
the kubeconform version/sha) are in that same manual list — see "CI toolchain pins and scans".

**The PostgreSQL image is pinned in THREE places that must move together:** `docker-compose.yaml`,
`k8s/postgres-deployment.yaml` and `PostgresTestSupport.IMAGE`
(`server/src/test/kotlin/PostgresTestSupport.kt`). Dependabot only sees the first two, and as
separate PRs (the `docker-compose` and `docker` ecosystems cannot share a group; the `postgres`
group in `dependabot.yml` merges the `/` and `/k8s` `docker` directories at most). So a Postgres
tag/digest bump lands in ONE hand-assembled PR touching all three literals — close or redo
Dependabot's split PRs into it, re-deriving the digest per the provenance rule below. The
Testcontainers literal is no longer a monthly manual inspection item: `PostgresImagePinTest`
asserts it equals the compose and k8s `image:` values, so a partial bump fails the build.

## Compatibility boundaries

- Keep TypeScript on the supported shared major across web and E2E. TypeScript 7 needs a
  coordinated migration: the current ESLint tooling requires TypeScript below 6.1, and
  `openapi-typescript` uses the compiler API and declares TypeScript 5. The existing web
  `--legacy-peer-deps` exception permits TypeScript 6; it is not permission to bypass arbitrary
  peer conflicts. In particular, all Mantine packages must use the same release.
- Match `@types/node` to the Node runtime major. Keep production on an LTS line; newer types can
  expose APIs missing at runtime even if the build passes.
- Upgrade React/React DOM and their type packages together. Upgrade Vitest and
  `@vitest/coverage-v8` together and validate coverage without lowering floors.
- Read the current rationale in `gradle/libs.versions.toml` before moving Exposed,
  Netty/Reactor Netty, or OpenTelemetry. Inspect published BOMs/POMs as well as release notes.
  `:server:checkDependencyAlignment` must pass, but alignment alone does not prove compatibility.

## Runtime and image verification

Keep PostgreSQL on the same tested major/minor across Compose, Kubernetes and Testcontainers.
External images use exact release tags and reviewed multi-platform digests where available;
refresh both together. The tag describes the intended version, while the digest selects bytes. A
local rebuild without an updated base digest does not pick up security fixes. Verify
`java -version`, `node --version`, and `postgres --version` inside the selected images when
changing runtime pins. A `mise` version identifier may differ from the Java version it installs;
record the actual binary version when verifying a JDK patch.

Use the build-specific local Kubernetes image workflow in `.claude/skills/run-stack/SKILL.md`. Do
not redeploy a mutable `latest` tag and assume every node has the same image. Never remove
development database volumes as part of an update.

## Acceptance checks

Refresh each changed workspace from its committed lockfile. For Gradle changes, regenerate the
project and buildscript locks with the command below and review their diff. Run each changed
workspace's documented lint, dead-code, type, test/coverage and build gates; regenerate frontend
API types and confirm there is no unexplained schema drift. Run `npm audit` in both workspaces and
distinguish runtime advisories from development-only exposure. For Gradle changes, run the
complete build and alignment gate on the pinned JDK; database changes need a fresh Testcontainers
database and the complete server suite, including concurrency cases.

Build the application image, verify health, and run the full Playwright journeys after
cross-stack updates. Existing Dependabot PR checks are evidence for their recorded commit only;
refresh against current master before merging. A version check or npm audit is not a comprehensive
JVM/container vulnerability scan.

Regenerate the Gradle project/buildscript/plugin lockfiles with:

```
./gradlew :verifySettingsPluginAudit :buildEnvironment :core:buildEnvironment :server:buildEnvironment \
  :dependencies :core:dependencies :server:dependencies --write-locks
```

then review the diff; do not hand-edit generated locks. `.github/workflows/ci.yml`'s
`gradle-vulnerability-scan` job scans all seven Gradle lockfiles (root/settings/core/server,
project + buildscript) with Trivy and fails on a HIGH or CRITICAL advisory; the Docker build
copies the locks before resolving server dependencies.

A dependency or plugin change also needs `gradle/verification-metadata.xml` regenerated in the
same commit — Gradle's separate SHA-256 checksum gate on every resolved artifact. This step has a
hard rule: it **must** run from an empty `GRADLE_USER_HOME` (a warm one silently omits checksums
for anything already cached), so it is a separate command from the plain `--write-locks` one above,
not an extra flag tacked onto it:

```
export JAVA_HOME=$(mise where java)
export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock
GRADLE_USER_HOME=$(mktemp -d) ./gradlew --write-verification-metadata sha256 \
  :verifySettingsPluginAudit :buildEnvironment :core:buildEnvironment :server:buildEnvironment \
  :dependencies :core:dependencies :server:dependencies \
  build :server:installDist
```

Then validate from a second, also-empty `GRADLE_USER_HOME` with
`./gradlew --dependency-verification strict build` before committing. See
`.claude/docs/dependency-reproducibility.md` for what this covers, why the task list must resolve
every configuration CI and the Docker build resolve, and how to review the generated checksums.
`.github/workflows/ci.yml`'s `server` job checks `gradle/verification-metadata.xml` is present,
runs `--dependency-verification strict`, and diffs it (with the lockfiles) after the build; the
Docker build's `server` stage copies the whole `gradle/` directory, so it picks up the file
automatically once it exists.

## CI toolchain pins and scans

`.github/workflows/ci.yml` and `e2e.yml` run on the toolchain the repo was verified on, and scan what
ships. Dependabot covers none of the pins in the first three rows — bump them by hand, together.

| Pin / gate | Where | Bump rule |
|---|---|---|
| JDK `21.0.12` (`actions/setup-java` `java-version`, both Gradle jobs) | `ci.yml` | the exact patch of `mise.toml`'s `java` and the Dockerfile's `eclipse-temurin:21.0.12.1_1` tags — one PR moves all three. A Temurin respin (`21.0.12.1+1`) is `temurin-21.0.12+101.0.LTS` in mise (Adoptium folds the respin into the build number); `setup-java` resolves `21.0.12` to its newest respin, so `ci.yml` names the patch only, while the Dockerfile tag names the respin. `node scripts/check-toolchain-pins.mjs` (an `e2e-static` step) fails the build with one line per mismatch if the JDK or node pins diverge |
| Node `24.22.0` (`node-version-file: .nvmrc`, web/e2e-static/e2e jobs) | `.nvmrc` | mirrors `mise.toml`'s `node` and the Dockerfile's `node:24.22.0-alpine` (guarded by the same script); `.nvmrc` holds the bare version, no `v` |
| Gradle `distributionSha256Sum` | `gradle/wrapper/gradle-wrapper.properties` | the wrapper validates the downloaded distribution against it (CI, local, and the Docker build's `./gradlew --version`). On a Gradle bump take the value from `https://services.gradle.org/distributions/gradle-<version>-bin.zip.sha256` (the `bin` type the URL uses), confirm it against a `shasum -a 256` of the downloaded zip, and change URL and checksum in the same commit |
| `npm audit --omit=dev --audit-level=high` | `ci.yml` `web` | runtime dependencies only (a dev-tool advisory never reaches the bundle). The LAST step of the job, so an overnight advisory cannot hide the real gate results |
| `npm audit --audit-level=high` | `ci.yml` `e2e-static` | every e2e dependency is a dev tool, so the whole tree. Also the last step |
| `trivy image` (HIGH/CRITICAL, `--ignore-unfixed`, exit 1) | `ci.yml` `images` (master pushes) and `e2e.yml` (nightly, the last step) | the same digest-pinned `trivy:0.74.0` as the Gradle lockfile scan — three copies of the pin, bump them together; run against the compose-built `flow-app`. The nightly copy catches an advisory published between merges. A red step is a fixable OS-package or JAR advisory: refresh the base-image digests (see "Runtime and image verification") or the dependency. It cannot be waived per-CVE without a `.trivyignore` with a dated justification — there is none |
| `kubeconform v0.8.0` (`-strict`, Kubernetes 1.33.0) | `ci.yml` `k8s-static` | the tarball is pinned by sha256 in the workflow (`CHECKSUMS` file of the release); bump version and sha together. Kubernetes version follows the local OrbStack cluster |
| `actions/cache` | `ci.yml` `web` (the ESLint cache), `e2e.yml` (the Playwright browsers) — the BuildKit layer cache and `docker/setup-buildx-action` are not used by either image build | SHA-pinned like every action; Dependabot's `github-actions` ecosystem updates it |
| `kubeconform -schema-location` (`yannh/kubernetes-json-schema@8df8a883…`) | `ci.yml` `k8s-static` (`KUBECONFORM_SCHEMAS`) | the schema repo is pinned to a commit so an upstream schema change cannot redden the job; move it with the kubeconform version |

The npm audits are a moving gate: a newly published advisory can turn an unrelated PR red. That is the
point — fix the dependency, or (if it is a false positive for how the package is used) record a
justified, dated exception here and adapt the audit step in the same PR (`npm audit` has no built-in
allow-list); never lower `--audit-level` to get green. Measured state on 2026-09-30: `npm audit` reports 0 vulnerabilities in
`web` (full and `--omit=dev`) and in `e2e`; the locally built image scans clean (no fixable
HIGH/CRITICAL) — those are the baselines the gates started from.

**Image build cache: none.** Both image builds (`ci.yml` `images` on master pushes, the nightly `e2e`) are a plain
`docker compose build`. A BuildKit `type=local` layer cache persisted with `actions/cache` was tried in Flow and removed: it cost more than it saved, and each ~1 GB cache entry pushed
the repository over GitHub's 10 GB cache quota and evicted the Playwright browser cache. Do not re-add one without re-measuring both.

## Buildscript advisory follow-up (inherited from Flow, 2026-09-26)

CI scans reported CVE-2026-84939 in the root plugin classpath's transitive
`org.freemarker:freemarker` 2.3.32 (caught in Covenant first). A root buildscript constraint selects
Apache FreeMarker 2.3.35, and the regenerated root buildscript lockfile records that version. This is a
build-time dependency; it is not packaged in the application runtime.

## Lessons ported from Toadie's Dependabot rounds (2026-09-26)

Sibling project Toadie hit these in its own weekly Dependabot rounds; they generalize to any
workspace here running the same tools:

- **A `knip` bump can add or drop findings with no change to this repo's code.** Toadie's 6.36
  started counting an export used only inside its own declaring file as unused, and separately
  raised a "Configuration hint … Remove from ignore" finding for an `ignore` entry that no longer
  suppressed anything. Read the whole `npm run knip` output on a Dependabot `knip` bump, not just
  a `grep knip` on the CI log — the failure can hide behind an unrelated-looking hint line. Fix by
  dropping the now-needless `export` keyword or `knip.json` ignore entry; do not silence the new
  rule. Flow's own `knip.json` carried exactly this stale entry (`ignore: ["src/api/schema.ts"]`)
  by the time this section was written — `schema.ts` is now fully consumed, so the entry was
  removed rather than kept as a no-op.
- **A required "Quality gate" style status check makes Dependabot PR merges serial, not
  parallel.** If branch protection requires every PR to contain the target branch's current HEAD,
  update-branch a Dependabot PR, wait for its checks, merge, then update-branch the next one —
  merging cheapest/most-likely-green first keeps a later red PR attributable to its own diff
  rather than a stale base. A config-only PR (`.github/**`) that doesn't change a Docker image can
  have its downstream image rebuild run in parallel with its own CI, since nothing about the image
  input changed.

## Dependency history

Flow's batch-by-batch bump log (2026-09 .. 2026-10) is not carried over: Astrolabe starts from the dependency set Flow resolved at `e9c3b726` (minus WireMock and the
Jira/GitLab-only clients), and its own rounds are recorded below, newest first, as they happen. The v0.1.0 lockfiles and `gradle/verification-metadata.xml` were
regenerated from an empty `GRADLE_USER_HOME` per `dependency-reproducibility.md`.

Dependencies kept for a future consumer (Ktor's OkHttp client engine with `infra/outbound/OutboundGuard.kt`'s guarded `OkHttpClient`, `ktor-client-mock`) stay on the classpath
only while a test or source file uses them; knip/dependency analysis flags an orphan, and a consumer-less one is deleted and re-added with the sync.

## Web runtime dependencies with a pairing rule

Installed with `npm install --legacy-peer-deps` (the existing web exception: recharts' React peers are tolerated the same way `openapi-typescript`'s TypeScript peer is).

- `@mantine/charts` (**exact**) — the telemetry panel's charts (and any later chart). Pinned to `@mantine/core`'s release, exactly like `@mantine/spotlight` and `@mantine/dates`:
  **every `@mantine/*` package must sit on one version** — a chart/date package a minor behind core renders unstyled or throws on a changed prop contract. The
  `web-minor-patch` Dependabot group batches every `@mantine/*` bump into one PR; check the resulting lockfile diff shows one Mantine version.
- `recharts` — `@mantine/charts`' rendering engine (a peer it does not bundle). ~400 kB: it must only ever enter **lazy chunks** (`npm run build` shows it as its own chunk, and the main
  `index-*.js` stays free of it). Each chart component imports `@mantine/charts/styles.css` itself — without it the tooltip renders unstyled.
- `@mantine/dates` (**exact**) and `dayjs` — the date pickers (the Polish calendar locale is `dayjs/locale/pl`; a third UI language would need its dayjs locale added there too). The planning
  increments' schedule and target-window editors use them.
- **`react-is` override** (`web/package.json` `"overrides": { "react-is": "^19" }`): under React 19 the tree otherwise keeps `react-is@17` (pulled by `@testing-library/dom`'s
  `pretty-format` and `prop-types`), and recharts imports `isFragment` from `react-is` — which must match React's major. `npm ls react-is` must show one version; keep the
  override matched to React's major when React moves.
- `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2 (**all exact**, `npm install --legacy-peer-deps --save-exact`) — the Roadmap's sortable ranked list (`pages/Roadmap.tsx`) and, later, the shared
  `Timeline*` component (`timeline.md`). They are one release family like `@mantine/*`: `sortable` declares `@dnd-kit/core ^6.3.0` as a peer and `utilities` is shared by both, so **move the three
  together and check the lockfile resolves one copy of each** (`npm ls @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`). The 0.x `@dnd-kit/dom`/`@dnd-kit/react` rewrite is a different, incompatible
  API and is NOT what these are — do not mix it in. They ride only the lazy Roadmap chunk (`npm run build` shows it as `Roadmap-*.js`; the main `index-*.js` stays free of them).
- `@tanstack/react-virtual` 3.14.24 (**exact**, `npm install --legacy-peer-deps --save-exact`) — row virtualisation of the shared `Timeline*` component (`components/Timeline.tsx`, `timeline.md`), active only above `virtualizeFrom` rows (default 80).
  It brings `@tanstack/virtual-core` (resolved by its own pin in the lockfile). It rides only the chunk of the page that imports `Timeline` (lazy, like every page): `npm run build` must show no `react-virtual` code in
  `index-*.js`. Its `useVirtualizer` is flagged by `react-hooks/incompatible-library`; the one disable in `Timeline.tsx` carries the reason.

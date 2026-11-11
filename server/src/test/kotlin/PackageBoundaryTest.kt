package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The one-way package layering (CLAUDE.md "Package layout", checkup D5): everything under `infra/` is the foundation every feature
 * builds on, so it never references a feature package (`teams`, `people`, `planning`, `users`, `auth`, `authz`, `telemetry`, `jira`,
 * `sync`, `flow`).
 * `audit` (the cross-cutting audit trail) and `plugins` (Ktor wiring: `respondProblem`) are not features and stay open to `infra`.
 * The composition root is the one documented exception ([infraCompositionRoot]): the DB/bootstrap wiring MUST construct the
 * feature services it publishes on
 * `Application.attributes` (`Bootstrap.kt` also registers the `jira` and `flow` services with the encryption-at-rest backfill), so
 * exactly those two files may name exactly those packages. `telemetry/` is the top layer (an observer of
 * every lower one): nothing else names it. A plain source scan (no Docker, no classpath tricks): any non-comment line of a file in
 * the lower package that mentions an upper package by its qualified name (an import, a wildcard import or an inline reference) is a
 * violation.
 *
 * Between the feature packages themselves the rule is an explicit allow-list ([featureEdges]): every package-to-package edge that exists
 * today is listed with its reason, so a NEW edge fails the build until its author adds it deliberately; a listed edge that is no
 * longer used fails too ("delist it"). The specific bans below stay as they are: they say more than "not listed" (and `flow`'s
 * planning symbols are pinned one by one).
 *
 * Flow's connector-side rules (`ingest`/`norm`/`jira`/`gitlab` never reach `metrics`/`reports`, `fetch` reaches only `infra`) came with
 * those packages and are ported with them.
 */
class PackageBoundaryTest {
    private val mainSources: List<File> by lazy {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    /**
     * Composition-root exceptions to "infra never references a feature": `infra/db/Database.kt` builds and publishes the feature
     * services (`teams`, `people`, `planning`, `users`, `auth`, `jira`, `flow`, `sync`) and `infra/db/Bootstrap.kt` seeds the admin through
     * `users`/`auth` and reads the `jira`/`flow` connection services for the encrypted-at-rest backfill. Keyed by file name,
     * valued by the feature packages that file may import;
     * a listed package the file no longer uses fails the test (a stale exception is dead permission).
     */
    private val infraCompositionRoot: Map<String, Set<String>> = mapOf(
        "Database.kt" to setOf("auth", "flow", "jira", "people", "planning", "sync", "teams", "users"),
        "Bootstrap.kt" to setOf("auth", "flow", "jira", "users"),
    )

    private val featurePackages = listOf(
        "teams", "people", "planning", "users", "auth", "authz", "telemetry", "jira", "flow", "sync",
    )

    /** One allowed feature-to-feature edge: [from] may name [to]; [why] is the reason and, where cheap, the symbols it uses. */
    private data class FeatureEdge(val from: String, val to: String, val why: String)

    /**
     * Every edge between two feature packages that exists today (`audit`, `plugins` and `infra` are not features and are open).
     * Several are cycles (`users`/`auth`, `users`/`authz`, `people`/`teams`, `people`/`planning`, `teams`/`planning`): the plan data
     * is one database whose tables reference each other, so a delete in one feature must refuse on another's rows.
     */
    private val featureEdges: List<FeatureEdge> = listOf(
        FeatureEdge("auth", "authz", "the typed 401/429 errors (UnauthorizedException, TooManyRequestsException)"),
        FeatureEdge(
            "auth", "users",
            "login, MFA and reset sit on the accounts: UserService/Users, User, UserRole, Feature, the validators",
        ),
        FeatureEdge("authz", "users", "the guards and the principal speak the account vocabulary: Feature, Permission, UserRole"),
        FeatureEdge("flow", "authz", "the guards and typed errors: requireAdmin, requireTeamManagerOrAdmin, caller, NotFound/Conflict"),
        FeatureEdge(
            "flow", "planning",
            "pure rules, the createdBy name rule and the 1.9 flag seam (symbols pinned by the flow test): " +
                "CapacityPeriod, capacityOn, creatorsOf, ...",
        ),
        FeatureEdge(
            "flow", "sync",
            "the connector contract, the run registry and the acknowledge vocabulary: Connector, SyncRunService, Acknowledge.kt",
        ),
        FeatureEdge(
            "flow", "teams",
            "team bindings and the capacity import write through TeamService, TeamCapacityService, TeamGuard; " +
                "the capacity-write listener seam (CapacityWriteListeners: flow registers, the capacity routes call)",
        ),
        FeatureEdge(
            "jira", "authz",
            "the guards and typed errors: requireAdmin, requireOwnerOrAdmin, requireOwnerOrTeamManagerOrAdmin, caller, OwnerChain",
        ),
        FeatureEdge("jira", "people", "PersonService: the caller's person for the owner-chain guards and the import's owner lookups"),
        FeatureEdge(
            "jira", "planning",
            "bindings follow plan nodes: chains (projectChain, ...), the import's insert*Row, withPlanWrite, SNAPSHOT",
        ),
        FeatureEdge(
            "jira", "sync",
            "the connector contract, the run registry and the acknowledge vocabulary: Connector, SyncRunService, Acknowledge.kt",
        ),
        FeatureEdge(
            "jira", "teams",
            "TeamService: the team names of the deviation rows, the import's team lookups and the milestone acknowledge's manager guard",
        ),
        FeatureEdge("jira", "users", "UserService.Users: the binding's created_by reference"),
        FeatureEdge("people", "authz", "the guards and typed errors: requireAdmin, caller, ConflictException"),
        FeatureEdge(
            "people", "planning",
            "OwnerChains: ownsActivePlanNode - a person who owns an ACTIVE plan node cannot be deleted (409)",
        ),
        FeatureEdge("people", "teams", "TeamService: a person who manages an active team cannot be deleted (409)"),
        FeatureEdge("people", "users", "UserService.Users: the optional login link (people.user_id) and its checks"),
        FeatureEdge(
            "planning", "authz",
            "the guards and typed errors: requireOwnerOrAdmin, requireRoadmapEditorOrAdmin, OwnerChain, caller",
        ),
        FeatureEdge("planning", "people", "PersonService.People: the owners' names and the active-owner check (OwnerChains)"),
        FeatureEdge(
            "planning", "teams",
            "TeamService.Teams (a milestone's team), TeamCapacityService / CapacitySource (the team view), TeamGuard",
        ),
        FeatureEdge("planning", "users", "UserService.Users (the baselines' created_by) and Permission (the roadmap-editor lookup)"),
        FeatureEdge("sync", "authz", "requireAdmin, caller, ConflictException on the run routes and the scheduler"),
        FeatureEdge("teams", "authz", "the guards and typed errors: requireAdmin, requireTeamManagerOrAdmin, caller, NotFound/Conflict"),
        FeatureEdge("teams", "people", "PersonService.People: a team's manager is a person"),
        FeatureEdge(
            "teams", "planning",
            "hasActiveMilestones (a team with milestones cannot be deleted) and validateManDays (capacity bounds)",
        ),
        FeatureEdge("teams", "users", "UserService.Users: the manager's login behind the team manager guard and the managed-teams lookup"),
        FeatureEdge("telemetry", "authz", "requireAdmin, caller on the ADMIN read API"),
        FeatureEdge(
            "telemetry", "sync",
            "the sync panel's server side reads the run registry: SyncKind, SyncStatus, SyncRunServiceKey, ...",
        ),
        FeatureEdge(
            "users", "auth",
            "password hashing and limits: hashPassword, verifyPassword, exceedsBcryptLimit, MAX_PASSWORD_BYTES, LoginThrottle",
        ),
        FeatureEdge(
            "users", "people",
            "PersonService.create, PersonCreateRequest: POST /users' alsoCreatePerson writes the linked person " +
                "in the account's transaction",
        ),
        FeatureEdge("users", "authz", "the guards and typed errors: requireAdmin, requireSelfOrAdmin, caller, NotFound/Conflict/Forbidden"),
    )

    private fun packageOf(text: String): String? =
        text.lineSequence().firstOrNull { it.startsWith("package ") }?.removePrefix("package ")?.trim()

    private fun isComment(line: String): Boolean = line.trimStart().let { it.startsWith("//") || it.startsWith("*") || it.startsWith("/*") }

    /** `line number: line` of every code line in [text] that names one of [forbidden] (`metrics`, `reports`, ...) by qualified package. */
    private fun forbiddenReferences(text: String, forbidden: List<String>): List<String> {
        val pattern = Regex("""\bch\.nokillswit\.(${forbidden.joinToString("|")})\b""")
        return text.lineSequence().withIndex()
            .filter { (_, line) -> !isComment(line) && pattern.containsMatchIn(line) }
            .map { (index, line) -> "${index + 1}: ${line.trim()}" }
            .toList()
    }

    @Test
    fun `no package outside telemetry references telemetry`() {
        // telemetry/ is the top layer (an observer of every lower one): it reaches `plugins` and `infra/db` through attribute
        // keys, so those seams never name it. The scan must see the package, or an empty result proves nothing.
        assertTrue(mainSources.any { packageOf(it.readText()) == "ch.nokillswit.telemetry" }, "no source declares ch.nokillswit.telemetry")
        val violations = mainSources.flatMap { file ->
            val text = file.readText()
            if (packageOf(text) == "ch.nokillswit.telemetry") {
                emptyList()
            } else {
                forbiddenReferences(text, listOf("telemetry")).map { "${file.name} $it" }
            }
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `sync imports no connector and planning reads nothing of jira`() {
        // sync/ is the connector-agnostic run registry (jira/ registers itself in it through an attribute); the plan never reads the sync.
        for (pkg in listOf("sync", "planning")) {
            val own = mainSources.filter { packageOf(it.readText()) == "ch.nokillswit.$pkg" }
            assertTrue(own.size > 3, "the scan saw only ${own.size} sources of $pkg")
            val violations = own.flatMap { file -> forbiddenReferences(file.readText(), listOf("jira")).map { "${file.name} $it" } }
            assertEquals(emptyList(), violations, "$pkg must not reference jira")
        }
    }

    @Test
    fun `the unguarded claim is declared in the run registry and used by no main source`() {
        // claimUnchecked skips the connection lock (the claim/delete race fix); `internal` is module-wide, so the scan is the fence.
        val uses = mainSources.flatMap { file ->
            file.readLines().filter { !isComment(it) && "claimUnchecked" in it }.map { "${file.name}: ${it.trim()}" }
        }
        assertEquals(1, uses.size, "claimUnchecked may appear only as its own declaration under src/main: $uses")
        assertTrue(uses.single().startsWith("SyncRunService.kt: internal suspend fun claimUnchecked("), uses.single())
    }

    private fun sourcesOf(pkg: String): List<File> = mainSources.filter { packageOf(it.readText()) == "ch.nokillswit.$pkg" }

    @Test
    fun `sync, planning and teams name nothing of flow`() {
        // flow/ is a connector like jira/: the run registry, the plan and the team registry never know it (flow/ registers itself in sync/
        // through an attribute and writes team data only through the teams service's own methods).
        for (pkg in listOf("sync", "planning", "teams")) {
            val own = sourcesOf(pkg)
            assertTrue(own.size > 3, "the scan saw only ${own.size} sources of $pkg")
            val violations = own.flatMap { file -> forbiddenReferences(file.readText(), listOf("flow")).map { "${file.name} $it" } }
            assertEquals(emptyList(), violations, "$pkg must not reference flow")
        }
    }

    @Test
    fun `jira and flow never name each other`() {
        for ((pkg, other) in listOf("jira" to "flow", "flow" to "jira")) {
            val own = sourcesOf(pkg)
            assertTrue(own.size > 3, "the scan saw only ${own.size} sources of $pkg")
            val violations = own.flatMap { file -> forbiddenReferences(file.readText(), listOf(other)).map { "${file.name} $it" } }
            assertEquals(emptyList(), violations, "$pkg must not reference $other")
        }
    }

    @Test
    fun `flow reaches only teams, sync, authz, audit, plugins, infra - and the plan's capacity rule and severity vocabulary`() {
        val own = sourcesOf("flow")
        assertTrue(own.size > 3, "the scan saw only ${own.size} sources of flow")
        // users/people/auth are out (the team guard and the actor's managed teams come through `teams` and `authz`); jira is the sibling.
        val violations = own.flatMap { file ->
            forbiddenReferences(file.readText(), listOf("users", "people", "auth", "telemetry", "jira")).map { "${file.name} $it" }
        }
        assertEquals(emptyList(), violations)
        val planning = Regex("""\bch\.nokillswit\.planning\.(\w+)""")
        val used = own.flatMap { file ->
            file.readLines().filterNot(::isComment).flatMap { line -> planning.findAll(line).map { it.groupValues[1] }.toList() }
        }.toSet()
        // The first two are the import's inputs (the holiday dictionary, the man-day bounds). The capacity deviation (1.6.0) adds exactly
        // three pure symbols: `CapacityPeriod` and `capacityOn` (the team view's capacity-in-force rule - the deviation must compare what
        // the team view shows, never a second copy that could drift) and `DeviationSeverity` (the WARNING/INFO scale the web already
        // types). No plan node, no `readPlanRevision`, nothing of `jira`: a capacity deviation is a team x sprint row, not a plan binding.
        // The 1.9 acknowledge adds `creatorsOf` (the `createdBy` name rule: the acknowledging login's display name; `flow/` may not name
        // `users`/`people`, so the name comes through `planning`, as the Jira acknowledge's does).
        // The 1.9 flag seam adds the types of `planning`'s `ExternalFlagSource`: `flow/FlowFlagSource` implements it the way
        // `jira/JiraFlagSource` does (the team view's Flow capacity flag and marked days): the interface, its request and answer
        // (`ExternalFlagSource`, `ExternalFlagRequest`, `ExternalFlags`, `TeamExternal`, `FlaggedRange`) and the flag vocabulary
        // (`PlanFlag`, `FlagKind`, `FlagSeverity`). Still no plan node, no `readPlanRevision`.
        val allowed = setOf(
            "loadWorkingCalendar", "validateManDays", "CapacityPeriod", "capacityOn", "DeviationSeverity", "creatorsOf",
            "ExternalFlagSource", "ExternalFlagRequest", "ExternalFlags", "TeamExternal", "FlaggedRange",
            "PlanFlag", "FlagKind", "FlagSeverity",
        )
        assertEquals(emptySet(), used - allowed, "flow may import only these planning symbols")
    }

    private fun infraSources(): List<Pair<File, String>> = mainSources.mapNotNull { file ->
        val text = file.readText()
        if (packageOf(text)?.startsWith("ch.nokillswit.infra") == true) file to text else null
    }

    @Test
    fun `infra never references a feature package outside the composition root`() {
        val infra = infraSources()
        assertTrue(infra.size > 20, "the scan saw only ${infra.size} infra sources")
        val violations = infra.flatMap { (file, text) ->
            val allowed = infraCompositionRoot[file.name].orEmpty()
            forbiddenReferences(text, featurePackages - allowed).map { "${file.name} $it" }
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `every composition-root exception is still used`() {
        val infra = infraSources().associate { (file, text) -> file.name to text }
        for ((name, allowed) in infraCompositionRoot) {
            val text = infra[name] ?: error("composition-root file $name is not under infra/")
            for (pkg in allowed) {
                assertTrue(forbiddenReferences(text, listOf(pkg)).isNotEmpty(), "$name no longer references $pkg: drop the exception")
            }
        }
    }

    /** The feature packages [text] names (not its own [own]), each with the `line: code` sites, comments skipped. */
    private fun featureReferences(text: String, own: String): Map<String, List<String>> {
        val pattern = Regex("""\bch\.nokillswit\.(${(featurePackages - own).joinToString("|")})\b""")
        val sites = linkedMapOf<String, MutableList<String>>()
        text.lineSequence().withIndex().filter { (_, line) -> !isComment(line) }.forEach { (index, line) ->
            for (match in pattern.findAll(line)) {
                sites.getOrPut(match.groupValues[1]) { mutableListOf() }.add("${index + 1}: ${line.trim()}")
            }
        }
        return sites
    }

    /** Every `from -> to` edge between two feature packages that the sources use today, with its first few sites. */
    private fun usedFeatureEdges(): Map<Pair<String, String>, List<String>> {
        val used = linkedMapOf<Pair<String, String>, MutableList<String>>()
        for (from in featurePackages) {
            val own = sourcesOf(from)
            assertTrue(own.isNotEmpty(), "the scan saw no sources of $from")
            for (file in own) {
                for ((to, sites) in featureReferences(file.readText(), from)) {
                    used.getOrPut(from to to) { mutableListOf() }.addAll(sites.map { "${file.name} $it" })
                }
            }
        }
        return used
    }

    @Test
    fun `feature packages name each other only through a listed edge`() {
        val listed = featureEdges.map { it.from to it.to }.toSet()
        val violations = usedFeatureEdges().filterKeys { it !in listed }.map { (edge, sites) ->
            "${edge.first} -> ${edge.second} is a NEW feature-to-feature edge (${sites.first()}, ${sites.size} site(s)): if it is " +
                "deliberate, add FeatureEdge(\"${edge.first}\", \"${edge.second}\", <reason>) to featureEdges in PackageBoundaryTest"
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `every listed feature edge is still used`() {
        val listed = featureEdges.map { it.from to it.to }
        assertEquals(listed.distinct(), listed, "featureEdges lists an edge twice")
        for (edge in featureEdges) {
            assertTrue(edge.from in featurePackages && edge.to in featurePackages && edge.from != edge.to, "bad edge $edge")
            assertTrue(edge.why.isNotBlank(), "$edge carries no reason")
        }
        val used = usedFeatureEdges().keys
        val stale = featureEdges.filter { (it.from to it.to) !in used }.map { "${it.from} -> ${it.to} is no longer used: delist it" }
        assertEquals(emptyList(), stale)
    }

    @Test
    fun `the feature edge scan finds qualified names in code but not in comments or look-alike packages`() {
        val source = """
            package ch.nokillswit.people

            import ch.nokillswit.planning.ownsActivePlanNode
            import ch.nokillswit.users.*
            import ch.nokillswit.audit.audit
            import ch.nokillswit.infra.db.active
            // import ch.nokillswit.teams.InComment
            import ch.nokillswit.people.Own
            val x = ch.nokillswit.planning.Other()
            import ch.nokillswit.teamsx.NotThePackage
        """.trimIndent()
        assertEquals(
            mapOf(
                "planning" to listOf("3: import ch.nokillswit.planning.ownsActivePlanNode", "9: val x = ch.nokillswit.planning.Other()"),
                "users" to listOf("4: import ch.nokillswit.users.*"),
            ),
            featureReferences(source, "people"),
        )
    }

    @Test
    fun `the scan flags imports, wildcard imports and inline references but not comments`() {
        val source = """
            package ch.nokillswit.infra

            import ch.nokillswit.teams.TeamService
            import ch.nokillswit.users.*
            // import ch.nokillswit.teams.InComment
             * ch.nokillswit.users.InKdoc
            val x = ch.nokillswit.teams.Other()
            import ch.nokillswit.teamsx.NotThePackage
        """.trimIndent()
        assertEquals(
            listOf(
                "3: import ch.nokillswit.teams.TeamService",
                "4: import ch.nokillswit.users.*",
                "7: val x = ch.nokillswit.teams.Other()",
            ),
            forbiddenReferences(source, listOf("teams", "users")),
        )
    }
}

package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.planning.programChain
import ch.nokillswit.planning.projectChain
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.planning.ownsActivePlanNode
import ch.nokillswit.planning.readPlanRevision
import ch.nokillswit.planning.withPlanWrite
import ch.nokillswit.planning.workStreamChain
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

private val programs = ProgramService.Programs
private val projects = ProjectService.Projects
private val milestones = MilestoneService.Milestones
private val bindings = JiraBindingService.Bindings
private val connections = JiraConnectionService.Connections

/** The owner chain of the rooted import's node, inside the caller's transaction: a missing or deleted one is the named-target `404`. */
internal suspend fun rootChain(root: JiraImportRoot): OwnerChain =
    activeChain(root.jiraLevel(), root.nodeId) ?: throw NotFoundException("${root.jiraLevel().title()} not found")

val JiraImportServiceKey = AttributeKey<JiraImportService>("JiraImportService")

/** Statement size of an `IN (...)` over Jira issue ids (a browse holds at most 2,000 issues and as many parents). */
private const val ID_CHUNK = 1_000

/**
 * The plan side of an import preview, read in one snapshot: the kernel's [snapshot] and the owner chain of every node of the picked
 * stream's tree ([chains], keyed by level and id; a milestone has its project's) for the resolved-target guards.
 */
class ImportRead(
    val revision: Long,
    val snapshot: ImportSnapshot,
    val streamChain: OwnerChain,
    val chains: Map<Pair<JiraLevel, UInt>, OwnerChain>,
)

/**
 * The Jira import's database side (1.2; `persistence.md` "Cross-feature table reads AND writes"). It READS `planning` (the picked work
 * stream's tree, every active program name, the holiday dictionary), `people` and `teams` (the owner and the teams, the caller's managed
 * teams) and `jira_bindings` / `jira_connections` (who holds an issue on the site); the preview writes nothing and takes no lock. The
 * apply ([apply]) is the one plan write. Every Jira call happens in the route, OUTSIDE any of these transactions.
 */
class JiraImportService(
    private val database: R2dbcDatabase,
    private val teams: TeamService,
    private val bindingService: JiraBindingService,
) {
    /**
     * The apply: ONE `withPlanWrite` ([LockedApply.run] has the lock order and every re-check), after the browse the route made OUTSIDE
     * any transaction - the plan lock is never held across HTTP. A truncated browse is a `400` before the lock, because a parent cut away
     * by the cap cannot be told from an orphan. The commit bumps the plan revision exactly once, also when every item was skipped. A
     * `23505` that escapes (a name the Kotlin-side decision could not see, for instance `LOWER()` disagreeing with `lowercase()` on an
     * exotic character) aborts the transaction and is the central whole-request `409`: the documented backstop, never caught per row.
     */
    internal suspend fun apply(ctx: ApplyContext): ImportOutcome {
        // The route validated these too; the service never trusts its caller for a client bug (conventions.md).
        validateApplyItems(ctx.request.items)
        if (ctx.browse.truncated) throw BadRequestException(if (ctx.root != null) ROOTED_IMPORT_TRUNCATED else IMPORT_TRUNCATED)
        val write = database.withPlanWrite { revision -> LockedApply(this, teams, bindingService, ctx, revision).run() }
        val written = write.value
        return ImportOutcome(JiraImportResult(write.revision, written.created, written.bound, written.skipped), written.released)
    }

    /**
     * The targets the request NAMES, for the checks that precede the browse (read-before-guard): the picked work stream must exist, and
     * so must `defaults.programId`, `defaults.projectId` and (1.14) the rooted import's `root` - the first one that is missing or deleted
     * is a `404` - and the answer is the owner chains of those (the stream itself is a target only when a program would be created, so
     * it is guarded after the kernel; a chain of a program or project includes the stream's owner). The root is one more named target:
     * its owner chain (or ADMIN) may start the import.
     */
    suspend fun namedChains(scope: JiraImportScope): List<OwnerChain> = suspendTransaction(database) {
        workStreamChain(scope.workStreamId) ?: throw NotFoundException("Work stream not found")
        listOfNotNull(
            scope.defaults?.programId?.let { programChain(it) ?: throw NotFoundException("Program not found") },
            scope.defaults?.projectId?.let { projectChain(it) ?: throw NotFoundException("Project not found") },
            scope.root?.let { rootChain(it) },
        )
    }

    /**
     * The rooted import's stored link (1.14): the root node's ACTIVE binding through connection [connectionId], as the browse's
     * [ImportRoot] (the numeric Jira id comes from the STORED binding, never from the request). No active link through THIS connection is
     * the `409` [JIRA_ROOT_UNUSABLE_PROBLEM]. One short read, no lock: the apply re-reads the holders under the plan lock and the root's
     * row must still be bound to the root node there.
     */
    internal suspend fun resolveRoot(connectionId: UInt, root: JiraImportRoot): ImportRoot = suspendTransaction(database) {
        val column = if (root.level == JiraImportRootLevel.PROGRAM) bindings.programId else bindings.projectId
        val row = bindings.select(bindings.id, bindings.jiraIssueId)
            .where {
                bindings.active() and (bindings.connectionId eq connectionId) and (bindings.level eq root.level.name) and
                    (column eq root.nodeId)
            }
            .toList().singleOrNull()
            ?: throw ConflictException(
                "This ${root.level.name.lowercase()} is not linked to Jira through this connection - the import cannot start from it. " +
                    "See the Deviations page.",
                JIRA_ROOT_UNUSABLE_PROBLEM,
            )
        ImportRoot(root.jiraLevel(), root.nodeId, row[bindings.id].value, row[bindings.jiraIssueId], connectionId)
    }

    /** Whether [personId] owns any active work stream, program or project: a login that owns nothing has no business previewing. */
    suspend fun ownsAnyNode(personId: UInt): Boolean = suspendTransaction(database) { ownsActivePlanNode(personId) }

    /**
     * The request's shape rules that need rows, after the guards (`400`): the owner and every apply item's `overrides.ownerPersonId`
     * ([overrides]) an ACTIVE person, `defaults.teamId` and every `overrides.teamId` an active team, `defaults.programId` /
     * `defaults.projectId` under the picked work stream (and, with a root, [requireDefaultsUnderRoot]). Plain reads, no lock (the preview
     * writes nothing; an apply re-checks under its own locks).
     */
    suspend fun requireShape(scope: JiraImportScope, overrides: Collection<JiraImportOverrides> = emptyList()): Unit =
        suspendTransaction(database) {
            val people = PersonService.People
            if (people.select(people.id).where { (people.id eq scope.ownerPersonId) and people.active() }.toList().isEmpty()) {
                throw BadRequestException("Unknown or deleted owner ids: ${scope.ownerPersonId}")
            }
            requireOverridesActive(overrides)
            val activeTeams = TeamService.Teams
            scope.defaults?.let { defaults ->
                defaults.teamId?.let { teamId ->
                    val found = activeTeams.select(activeTeams.id).where { (activeTeams.id eq teamId) and activeTeams.active() }.toList()
                    if (found.isEmpty()) throw BadRequestException("defaults.teamId is not an active team")
                }
                defaults.programId?.let { id ->
                    if (!programUnder(id, scope.workStreamId)) {
                        throw BadRequestException("defaults.programId is not a program of the picked work stream")
                    }
                }
                defaults.projectId?.let { id ->
                    if (!projectUnder(id, scope.workStreamId)) {
                        throw BadRequestException("defaults.projectId is not a project of the picked work stream")
                    }
                }
            }
            scope.root?.let { root ->
                val under = if (root.level == JiraImportRootLevel.PROGRAM) {
                    programUnder(root.nodeId, scope.workStreamId)
                } else {
                    projectUnder(root.nodeId, scope.workStreamId)
                }
                if (!under) throw BadRequestException("root is not a ${root.level.name.lowercase()} of the picked work stream")
                requireDefaultsUnderRoot(scope.defaults, root)
            }
        }

    /** The overrides' rules that need rows (`400`): every `ownerPersonId` an active person, every `teamId` an active team. */
    private suspend fun requireOverridesActive(overrides: Collection<JiraImportOverrides>) {
        val people = PersonService.People
        val owners = overrides.mapNotNull { it.ownerPersonId }.toSet()
        if (owners.isNotEmpty()) {
            val active = people.select(people.id).where { (people.id inList owners) and people.active() }.toList()
                .map { it[people.id].value }.toSet()
            if (!active.containsAll(owners)) throw BadRequestException("overrides.ownerPersonId is not an active person")
        }
        val teams = TeamService.Teams
        val wanted = overrides.mapNotNull { it.teamId }.toSet()
        if (wanted.isNotEmpty()) {
            val active = teams.select(teams.id).where { (teams.id inList wanted) and teams.active() }.toList()
                .map { it[teams.id].value }.toSet()
            if (!active.containsAll(wanted)) throw BadRequestException("overrides.teamId is not an active team")
        }
    }

    /**
     * A rooted import lands under the root's own node, so the defaults the request can steer there are limited (`400`, after the guards
     * and the stream rule): no `defaults.programId` (a rooted import creates no program, and its orphans have no program to fall under), no
     * `defaults.projectId` under a project root (every milestone lands under the root), and under a program root only a project OF that
     * program. (The planner's re-homing of a child linked to a project of another program of the stream is the documented rough edge.)
     */
    private suspend fun requireDefaultsUnderRoot(defaults: JiraImportDefaults?, root: JiraImportRoot) {
        if (defaults?.programId != null) throw BadRequestException("defaults.programId cannot be combined with a root")
        val projectId = defaults?.projectId ?: return
        if (root.level == JiraImportRootLevel.PROJECT) {
            throw BadRequestException("defaults.projectId cannot be combined with a project root")
        }
        val ofRoot = projects.select(projects.id)
            .where { (projects.id eq projectId) and (projects.programId eq root.nodeId) and projects.active() }.toList().isNotEmpty()
        if (!ofRoot) throw BadRequestException("defaults.projectId is not a project of the root program")
    }

    /** Whether the ACTIVE program [id] belongs to work stream [workStreamId] (the defaults' and the root's shape rule). */
    private suspend fun programUnder(id: UInt, workStreamId: UInt): Boolean =
        programs.select(programs.id).where { (programs.id eq id) and (programs.workStreamId eq workStreamId) and programs.active() }
            .toList().isNotEmpty()

    /** Whether the ACTIVE project [id], under an active program, belongs to work stream [workStreamId]. */
    private suspend fun projectUnder(id: UInt, workStreamId: UInt): Boolean =
        projects.innerJoin(programs, { projects.programId }, { programs.id }).select(projects.id)
            .where { (projects.id eq id) and projects.active() and programs.active() and (programs.workStreamId eq workStreamId) }
            .toList().isNotEmpty()

    /**
     * The preview's snapshot: ONE `READ ONLY REPEATABLE READ` transaction (the views' protocol) that reads the plan revision FIRST, then
     * the holiday calendar, the picked stream's active tree with each node's owner and whether it carries an active binding, ALL
     * active program names (program names are globally unique), the active bindings of [issueIds] on every active connection of
     * [siteUrl] (D1: a site's issue is held once across its connections) with their holders' liveness and names, the active teams and
     * the teams [managerUserId] manages (null = ADMIN, every team). [issueIds] must cover the browsed issues AND their Jira parents.
     * Null when the work stream is gone since the route's check (the route's `404`).
     */
    suspend fun read(workStreamId: UInt, siteUrl: String, issueIds: Collection<String>, managerUserId: UInt?): ImportRead? =
        suspendTransaction(database, SNAPSHOT, readOnly = true) {
            val revision = readPlanRevision()
            val canSchedule = managerUserId?.let { teams.activeManagedTeamIds(it) }
            loadPlanSide(workStreamId, siteUrl, issueIds, canSchedule, revision)
        }

    /**
     * Which of [issueIds] are held by a LIVE binding of any active connection of [siteUrl] (1.13.2): what the filtered browse asks before
     * each round of by-id parent reads, so a linked child or parent costs no read. Its own short read-only snapshot, no lock; the browse
     * calls it between Jira calls, never inside one.
     */
    suspend fun liveHeldIssueIds(siteUrl: String, issueIds: Collection<String>): Set<String> =
        suspendTransaction(database, SNAPSHOT, readOnly = true) {
            readHolders(siteUrl, issueIds).filter { it.live }.mapTo(HashSet()) { it.issueId }
        }

    /**
     * The reads of [read], inside the CALLER's transaction: the snapshot's, or (the apply) the plan-locked one, where they are exact.
     * [canScheduleTeamIds] = the teams the caller may schedule, null = every team. Null when the work stream is gone.
     */
    internal suspend fun loadPlanSide(
        workStreamId: UInt,
        siteUrl: String,
        issueIds: Collection<String>,
        canScheduleTeamIds: Set<UInt>?,
        revision: Long,
    ): ImportRead? {
        val calendar = loadWorkingCalendar()
        val streamOwner = workStreamChain(workStreamId)?.owners?.single() ?: return null
        val tree = readTree(workStreamId, streamOwner)
        val allProgramNames = programs.select(programs.name).where { programs.active() }.toList().map { it[programs.name] }
        val activeTeams = TeamService.Teams
        val teamRows = activeTeams.select(activeTeams.id, activeTeams.name).where { activeTeams.active() }.toList()
            .map { ImportTeam(it[activeTeams.id].value, it[activeTeams.name]) }
        val snapshot = ImportSnapshot(
            tree = tree.tree,
            allProgramNames = allProgramNames,
            holders = readHolders(siteUrl, issueIds),
            teams = teamRows,
            canScheduleTeamIds = canScheduleTeamIds,
            calendar = calendar,
        )
        return ImportRead(revision, snapshot, OwnerChain(listOf(streamOwner)), tree.chains)
    }

    private class Tree(val tree: ImportTree, val chains: Map<Pair<JiraLevel, UInt>, OwnerChain>)

    private suspend fun readTree(workStreamId: UInt, streamOwner: UInt): Tree {
        val inStream = programs.active() and (programs.workStreamId eq workStreamId)
        val programRows = programs.select(programs.id, programs.name, programs.ownerPersonId).where { inStream }.toList()
        val projectRows = projects.innerJoin(programs, { projects.programId }, { programs.id })
            .select(projects.id, projects.programId, projects.name, projects.ownerPersonId)
            .where { inStream and projects.active() }.toList()
        val milestoneRows = milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .select(milestones.id, milestones.projectId, milestones.name)
            .where { inStream and projects.active() and milestones.active() }.toList()
        val programIds = programRows.map { it[programs.id].value }
        val projectIds = projectRows.map { it[projects.id].value }
        val milestoneIds = milestoneRows.map { it[milestones.id].value }
        val bound = boundNodes(programIds, projectIds, milestoneIds)

        val programChains = programRows.associate {
            it[programs.id].value to OwnerChain(listOf(streamOwner, it[programs.ownerPersonId].value))
        }
        val projectChains = projectRows.associate {
            val program = programChains.getValue(it[projects.programId].value)
            it[projects.id].value to OwnerChain(program.owners + it[projects.ownerPersonId].value)
        }
        val chains = HashMap<Pair<JiraLevel, UInt>, OwnerChain>()
        programChains.forEach { (id, chain) -> chains[JiraLevel.PROGRAM to id] = chain }
        projectChains.forEach { (id, chain) -> chains[JiraLevel.PROJECT to id] = chain }
        milestoneRows.forEach {
            chains[JiraLevel.MILESTONE to it[milestones.id].value] = projectChains.getValue(it[milestones.projectId].value)
        }
        val tree = ImportTree(
            programs = programRows.map {
                val id = it[programs.id].value
                ImportPlanNode(id, null, it[programs.name], (JiraLevel.PROGRAM to id) in bound)
            },
            projects = projectRows.map {
                val id = it[projects.id].value
                ImportPlanNode(id, it[projects.programId].value, it[projects.name], (JiraLevel.PROJECT to id) in bound)
            },
            milestones = milestoneRows.map {
                val id = it[milestones.id].value
                ImportPlanNode(id, it[milestones.projectId].value, it[milestones.name], (JiraLevel.MILESTONE to id) in bound)
            },
        )
        return Tree(tree, chains)
    }

    /** The nodes among the given ids that carry an ACTIVE binding of any connection. */
    private suspend fun boundNodes(programIds: List<UInt>, projectIds: List<UInt>, milestoneIds: List<UInt>): Set<Pair<JiraLevel, UInt>> {
        val bound = HashSet<Pair<JiraLevel, UInt>>()

        suspend fun collect(level: JiraLevel, ids: List<UInt>, column: Column<EntityID<UInt>?>) {
            ids.chunked(ID_CHUNK).forEach { chunk ->
                bindings.select(column).where { bindings.active() and (column inList chunk) }.toList()
                    .forEach { row -> row[column]?.let { bound += level to it.value } }
            }
        }
        collect(JiraLevel.PROGRAM, programIds, bindings.programId)
        collect(JiraLevel.PROJECT, projectIds, bindings.projectId)
        collect(JiraLevel.MILESTONE, milestoneIds, bindings.milestoneId)
        return bound
    }

    private suspend fun readHolders(siteUrl: String, issueIds: Collection<String>): List<ImportHolder> {
        if (issueIds.isEmpty()) return emptyList()
        val siteConnectionIds = connections.select(connections.id)
            .where { connections.active() and (LowerCase(connections.siteUrl) eq siteUrl.lowercase()) }
            .toList().map { it[connections.id].value }
        if (siteConnectionIds.isEmpty()) return emptyList()
        val rows = issueIds.distinct().chunked(ID_CHUNK).flatMap { chunk ->
            bindings.selectAll().where {
                bindings.active() and (bindings.connectionId inList siteConnectionIds) and (bindings.jiraIssueId inList chunk)
            }.orderBy(bindings.id).toList()
        }
        val nodes = rows.map { JiraLevel.valueOf(it[bindings.level]) to checkNotNull(nodeIdOf(it)) { "ck_jira_bindings_node" } }
        val live = JiraLevel.entries.associateWith { level ->
            liveNodeIds(level, nodes.filter { it.first == level }.map { it.second })
        }
        val described = describeNodes(nodes)
        return rows.zip(nodes).map { (row, node) ->
            ImportHolder(
                bindingId = row[bindings.id].value,
                connectionId = row[bindings.connectionId].value,
                issueId = row[bindings.jiraIssueId],
                level = node.first,
                nodeId = node.second,
                nodeName = described[node]?.name.orEmpty(),
                live = node.second in live.getValue(node.first),
            )
        }
    }
}

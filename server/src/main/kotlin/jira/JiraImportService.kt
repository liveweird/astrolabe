package ch.nokillswit.jira

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
        if (ctx.browse.truncated) throw BadRequestException(IMPORT_TRUNCATED)
        val write = database.withPlanWrite { revision -> LockedApply(this, teams, bindingService, ctx, revision).run() }
        val written = write.value
        return ImportOutcome(JiraImportResult(write.revision, written.created, written.bound, written.skipped), written.released)
    }

    /**
     * The targets the request NAMES, for the checks that precede the browse (read-before-guard): the picked work stream must exist, and
     * so must `defaults.programId` and `defaults.projectId` - the first one that is missing or deleted is a `404` - and the answer is the
     * owner chains of the two defaults (the stream itself is a target only when a program would be created, so it is guarded after the
     * kernel; a chain of a program or project includes the stream's owner).
     */
    suspend fun namedChains(scope: JiraImportScope): List<OwnerChain> = suspendTransaction(database) {
        workStreamChain(scope.workStreamId) ?: throw NotFoundException("Work stream not found")
        listOfNotNull(
            scope.defaults?.programId?.let { programChain(it) ?: throw NotFoundException("Program not found") },
            scope.defaults?.projectId?.let { projectChain(it) ?: throw NotFoundException("Project not found") },
        )
    }

    /** Whether [personId] owns any active work stream, program or project: a login that owns nothing has no business previewing. */
    suspend fun ownsAnyNode(personId: UInt): Boolean = suspendTransaction(database) { ownsActivePlanNode(personId) }

    /**
     * The request's shape rules that need rows, after the guards (`400`): the owner an ACTIVE person, `defaults.teamId` and every
     * apply item's `overrides.teamId` ([overrideTeamIds]) an active team,
     * `defaults.programId` / `defaults.projectId` under the picked work stream. Plain reads, no lock (the preview writes nothing; an
     * apply re-checks under its own locks).
     */
    suspend fun requireShape(scope: JiraImportScope, overrideTeamIds: Collection<UInt> = emptyList()): Unit = suspendTransaction(database) {
        val people = PersonService.People
        if (people.select(people.id).where { (people.id eq scope.ownerPersonId) and people.active() }.toList().isEmpty()) {
            throw BadRequestException("Unknown or deleted owner ids: ${scope.ownerPersonId}")
        }
        val activeTeams = TeamService.Teams
        val wanted = overrideTeamIds.toSet()
        if (wanted.isNotEmpty()) {
            val active = activeTeams.select(activeTeams.id).where { (activeTeams.id inList wanted) and activeTeams.active() }.toList()
                .map { it[activeTeams.id].value }.toSet()
            if (!active.containsAll(wanted)) throw BadRequestException("overrides.teamId is not an active team")
        }
        val defaults = scope.defaults ?: return@suspendTransaction
        defaults.teamId?.let { teamId ->
            if (activeTeams.select(activeTeams.id).where { (activeTeams.id eq teamId) and activeTeams.active() }.toList().isEmpty()) {
                throw BadRequestException("defaults.teamId is not an active team")
            }
        }
        defaults.programId?.let { programId ->
            val under = programs.select(programs.id)
                .where { (programs.id eq programId) and (programs.workStreamId eq scope.workStreamId) and programs.active() }
                .toList()
            if (under.isEmpty()) throw BadRequestException("defaults.programId is not a program of the picked work stream")
        }
        defaults.projectId?.let { projectId ->
            val under = projects.innerJoin(programs, { projects.programId }, { programs.id }).select(projects.id)
                .where {
                    (projects.id eq projectId) and projects.active() and programs.active() and
                        (programs.workStreamId eq scope.workStreamId)
                }.toList()
            if (under.isEmpty()) throw BadRequestException("defaults.projectId is not a project of the picked work stream")
        }
    }

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

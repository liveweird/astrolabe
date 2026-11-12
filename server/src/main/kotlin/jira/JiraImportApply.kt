package ch.nokillswit.jira

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.planning.ValidatedBatchItem
import ch.nokillswit.planning.insertMilestoneRow
import ch.nokillswit.planning.insertProgramRow
import ch.nokillswit.planning.insertProjectRow
import ch.nokillswit.planning.programChain
import ch.nokillswit.planning.projectChain
import ch.nokillswit.planning.requireActiveOwner
import ch.nokillswit.planning.requireActiveTeam
import ch.nokillswit.planning.writeSchedules
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.statements.StatementType
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.TransactionManager

// The Jira import's apply (1.2): the ONE Jira write that moves the plan. `JiraImportService.apply` opens the single `withPlanWrite`; the
// steps below run inside it, in the order the kdoc of [LockedApply.run] fixes.

/** The word for an apply over a scope the browse could not read whole (a parent cut by the cap cannot be told from an orphan). */
internal const val IMPORT_TRUNCATED =
    "More than $MAX_IMPORT_ITEMS issues are in scope, or more than $MAX_IMPORT_PARENT_READS parents would have to be read one by one - " +
        "narrow projectKeys or the filter and preview again"

/**
 * What the route hands the apply, all of it resolved BEFORE the lock: the request, the browse (the one HTTP act, already done), the
 * connection's state as the browse used it ([mappingChangedAt] pins the mapping), and how to re-resolve the caller's person under the
 * lock ([lockedPerson]: null for an ADMIN, else the person row locked `FOR SHARE`). [guardedByName] = the request names a default
 * program or project (so its guard ran, and a caller who owns nothing else still proved ownership).
 */
internal class ApplyContext(
    val connectionId: UInt,
    val request: JiraImportApplyRequest,
    val keys: List<String>,
    val browse: ImportBrowse,
    val mapping: JiraMapping,
    val discovery: JiraDiscovery,
    val mappingChangedAt: Long?,
    val caller: CallerPrincipal,
    val lockedPerson: suspend () -> UInt?,
    val asOf: Long,
)

/** What an apply wrote: the answer (without its revision, known only after the commit) and the dead holders it released. */
internal class ImportWritten(
    val created: List<JiraImportCreated>,
    val bound: List<JiraImportBound>,
    val skipped: List<JiraImportSkipped>,
    val released: List<ReleasedBinding>,
)

/** What the apply commits: the [result] and the dead-node holders it [released] (the route audits both after the commit). */
class ImportOutcome(val result: JiraImportResult, val released: List<ReleasedBinding>)

/** Binding ids per locking statement (an `IN` list; a browse holds at most 2,000 issues). */
private const val RELEASE_LOCK_CHUNK = 1_000

/** The connection row as locked: its site and its project keys. */
private class LockedConnection(val siteUrl: String, val keys: List<String>)

/**
 * One apply, inside the caller's `withPlanWrite` transaction ([revision] = the revision it started from; the commit leaves
 * `revision + 1`). `run` is the whole body; every step before the first insert only reads or locks, so any refusal rolls back with
 * nothing written and no bump.
 */
internal class LockedApply(
    private val imports: JiraImportService,
    private val teams: TeamService,
    private val bindings: JiraBindingService,
    private val ctx: ApplyContext,
    private val revision: Long,
) {
    private val request = ctx.request
    private val defaults = request.defaults ?: JiraImportDefaults()
    private val caller = ctx.caller

    /**
     * The order (the plan's lock order, `persistence.md`): the plan lock (the caller's) -> the advisory bind lock -> the connection row
     * `FOR SHARE` (gone = `404`, disabled or its scope or mapping changed = `400`/`409`) -> the caller's person `FOR SHARE` -> the named
     * defaults re-read and guarded (`403`) -> the owner and every named team active (`400`, rows locked `FOR SHARE`) -> the caller's
     * managed teams, each locked (`lockedIsActiveManager`) -> the plan side re-read (the tree, names, holders, calendar) -> the kernel over
     * THOSE rows with the client's ticks -> the guard on every ticked CREATE/BIND row's target (`403`) -> the dead holders to release
     * locked in id order ([lockReleases]) -> the milestones' teams locked active -> the inserts top-down -> the dates -> the bindings (the
     * dead holders released) -> the lists. The caller's commit bumps once.
     */
    suspend fun run(): ImportWritten {
        takeBindLock()
        val connection = lockConnection()
        val person = ctx.lockedPerson()
        val named = guardNamedDefaults(person)
        requireActiveOwner(request.ownerPersonId)
        namedTeamIds().forEach { requireActiveTeam(it) }
        val read = imports.loadPlanSide(
            request.workStreamId, connection.siteUrl, issueIdsOf(ctx.browse), canSchedule(), revision,
        ) ?: throw NotFoundException("Work stream not found")
        val preview = ImportInput(ctx.browse, ctx.mapping, ctx.discovery, read.snapshot, defaults, request.copyDates, ctx.asOf)
        val withheld = withheldIds(preview)
        val ticks = request.items.filter { it.jiraId !in withheld }
        val plan = JiraImportKernels.plan(
            ImportInput(ctx.browse, ctx.mapping, ctx.discovery, read.snapshot, defaults, request.copyDates, ctx.asOf, ticks),
        )
        val ticked = plan.rows.filter { it.apply != null && it.apply != ImportApply.NotRequested }.map { it.item }
        requireResolvedTargets(caller, person, ticked, read, guardedByName = named > 0)
        lockReleases(plan.releases.map { it.bindingId })
        val writes = plan.writes
        writes.mapNotNull { it.item.team?.id }.distinct().forEach { requireActiveTeam(it) }
        writes.forEach { requireInScope(it.item.key(), connection.keys) }
        val nodeIds = insertNodes(writes)
        val dated = writes.filter { it.span != null }.map { ValidatedBatchItem(nodeIds.getValue(it.item.jiraId), it.span) }
        writeSchedules(dated, revision + 1)
        return bind(writes, nodeIds, siteConnectionIds(connection.siteUrl), plan, withheld)
    }

    /**
     * The ids a non-admin's apply under an active filter must treat as if the browse did not hold them (1.13.2 audit LOW-1): the rows the
     * SAME-SCOPE PREVIEW (no ticks, so no `overrides.teamId`) redacts. Judging the apply's own recomputation instead would let an override
     * turn a redacted NO_TEAM row into a CREATE, which reaches the target guard and is written: a `403` naming the key, or a new row. They
     * are dropped from the ticks before the kernel runs, so no guard looks at them; [skippedAnswer] reports them as `CHANGED`, no key.
     */
    private fun withheldIds(preview: ImportInput): Set<String> {
        if (caller.isAdmin() || !request.filter.isActive()) return emptySet()
        return JiraImportKernels.plan(preview).rows.filter { it.item.isRedactedSkip() }.mapTo(HashSet()) { it.item.jiraId }
    }

    private suspend fun takeBindLock() {
        TransactionManager.current()
            .exec("SELECT pg_advisory_xact_lock($BIND_LOCK_KEY)", explicitStatementType = StatementType.SELECT) { 0 }?.toList()
    }

    /**
     * The dead holders the writes will release, locked `FOR NO KEY UPDATE` in ONE statement in id order BEFORE the first bind: the run's
     * node sweep (`JiraRunStore`) soft-deletes its own set of bindings in id order, so two writers that each take several of these rows
     * can only wait on one another in the same direction. [JiraBindingService.insertBoundLocked] then finds them already locked.
     */
    private suspend fun lockReleases(ids: List<UInt>) {
        val bindings = JiraBindingService.Bindings
        ids.sorted().chunked(RELEASE_LOCK_CHUNK).forEach { chunk ->
            bindings.select(bindings.id).where { bindings.active() and (bindings.id inList chunk) }.orderBy(bindings.id)
                .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList()
        }
    }

    /** The connection row `FOR SHARE`: a delete or edit waits for this commit, or has won and the apply is refused here. */
    private suspend fun lockConnection(): LockedConnection {
        val connections = JiraConnectionService.Connections
        val row = connections.select(
            connections.siteUrl, connections.projectKeys, connections.enabled, connections.mappingChangedAt, connections.discoveredAt,
        )
            .where { (connections.id eq ctx.connectionId) and connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().singleOrNull()
            ?: throw NotFoundException("Jira connection not found")
        if (!row[connections.enabled]) throw BadRequestException(CONNECTION_DISABLED)
        val keys = parseStringArray(row[connections.projectKeys])
        // The scope and the mapping the browse used must still be the connection's: a PUT that landed meanwhile changed what the rows mean.
        // The effective mapping depends on the stored document (`mapping_changed_at`) AND on the discovery it is checked against.
        if (validateImportScope(request.scope(), keys) != ctx.keys) {
            throw BadRequestException("The connection's project keys changed - preview again")
        }
        if (row[connections.mappingChangedAt] != ctx.mappingChangedAt || row[connections.discoveredAt] != ctx.discovery.discoveredAt) {
            throw ConflictException(
                "The connection's mapping or discovery changed while the import was read - preview again", JIRA_MAPPING_INVALID_PROBLEM,
            )
        }
        return LockedConnection(row[connections.siteUrl], keys)
    }

    /** Re-reads and guards the chains of the named defaults (a gone one is `404`); the number guarded. */
    private suspend fun guardNamedDefaults(person: UInt?): Int {
        val chains = listOfNotNull(
            defaults.programId?.let { programChain(it) ?: throw NotFoundException("Program not found") },
            defaults.projectId?.let { projectChain(it) ?: throw NotFoundException("Project not found") },
        )
        chains.forEach { requireOwnerOrAdmin(caller, person, it) }
        return chains.size
    }

    private fun namedTeamIds(): List<UInt> = (listOfNotNull(defaults.teamId) + request.items.mapNotNull { it.overrides?.teamId }).distinct()

    /** The teams the caller may schedule (null = every team, an ADMIN), each confirmed and locked under the lock. */
    private suspend fun canSchedule(): Set<UInt>? {
        if (caller.isAdmin()) return null
        return teams.activeManagedTeamIds(caller.userId).filter { teams.lockedIsActiveManager(it, caller.userId) }.toSet()
    }

    /** The EXISTING connections of the site (D1), the command's own included: what [JiraBindingService.insertBoundLocked] checks over. */
    private suspend fun siteConnectionIds(siteUrl: String): List<UInt> {
        val connections = JiraConnectionService.Connections
        return connections.select(connections.id)
            .where { connections.active() and (LowerCase(connections.siteUrl) eq siteUrl.lowercase()) }
            .toList().map { it[connections.id].value }
    }

    /** Top-down: a CREATE inserts its node (the parent's id is the one returned a moment earlier), a BIND locks its target. */
    private suspend fun insertNodes(writes: List<ImportRow>): Map<String, UInt> {
        val ids = HashMap<String, UInt>()
        val stamp = nowMillis()
        for (row in writes) {
            val item = row.item
            ids[item.jiraId] = if (item.action == JiraImportAction.BIND) {
                val target = checkNotNull(item.target) { "a BIND row has its target" }
                // Under the plan lock a node cannot be deleted; the lock is the binding primitive's rule for a node that already exists.
                if (!lockNodeShared(item.level, target.nodeId)) throw NotFoundException("${item.level.title()} not found")
                target.nodeId
            } else {
                insertNode(row, ids, stamp)
            }
        }
        return ids
    }

    private suspend fun insertNode(row: ImportRow, ids: Map<String, UInt>, stamp: Long): UInt {
        val item = row.item
        val parent = item.parent?.let { it.nodeId ?: ids.getValue(checkNotNull(it.rowJiraId) { "a new-row parent names its row" }) }
        return when (item.level) {
            JiraLevel.PROGRAM -> insertProgramRow(request.workStreamId, item.name, null, request.ownerPersonId, stamp)
            JiraLevel.PROJECT -> insertProjectRow(
                checkNotNull(parent) { "a project has a parent" }, item.name, null, request.ownerPersonId, null, stamp,
            )
            JiraLevel.MILESTONE -> insertMilestoneRow(
                checkNotNull(parent) { "a milestone has a parent" }, checkNotNull(item.team) { "a milestone has a team" }.id,
                item.name, null,
                checkNotNull(row.estimate) { "a milestone has its estimate" }, revision + 1, stamp,
            )
        }
    }

    /**
     * The answer's `skipped[]`: the visible skips in row order (a key and the kernel's reason). For a non-admin under an active filter
     * every other ticked id - one the preview redacts ([withheld]) and one the browse does not hold - follows as `CHANGED` with no key, in
     * the order the caller ticked them, so the two cannot be told apart: the apply would otherwise be a bulk probe for the keys the
     * preview withholds. Everyone else gets the plain list (the vanished ones last, as the kernel reports them).
     */
    private fun skippedAnswer(skips: List<ImportSkip>, withheld: Set<String>): List<JiraImportSkipped> {
        val plain = skips.map { JiraImportSkipped(it.jiraId, it.issueKey, it.reason) }
        if (caller.isAdmin() || !request.filter.isActive()) return plain
        val ticked = request.items.map { it.jiraId }
        val concealed = withheld + skips.filter { it.issueKey == null }.map { it.jiraId }
        // Every concealed id is a tick (duplicates are a 400), so filtering the ticks keeps their order in one pass under the plan lock.
        return plain.filter { it.issueKey != null } +
            ticked.filter { it in concealed }.map { JiraImportSkipped(it, null, JiraImportReason.CHANGED) }
    }

    /** One binding (and first observation) per written row, in row order; the dead holders it releases are the plan's `releases`. */
    private suspend fun bind(
        writes: List<ImportRow>,
        nodeIds: Map<String, UInt>,
        siteConnectionIds: List<UInt>,
        plan: ImportPlan,
        withheld: Set<String>,
    ): ImportWritten {
        val created = ArrayList<JiraImportCreated>()
        val bound = ArrayList<JiraImportBound>()
        val released = ArrayList<ReleasedBinding>()
        for (row in writes) {
            val item = row.item
            val nodeId = nodeIds.getValue(item.jiraId)
            val inserted = bindings.insertBoundLocked(
                JiraBindCommand(ctx.connectionId, item.level, nodeId, row.observation, caller.userId), siteConnectionIds,
            )
            released += inserted.released
            if (item.action == JiraImportAction.BIND) {
                bound += JiraImportBound(item.jiraId, item.key(), item.level, nodeId, inserted.bindingId)
            } else {
                val scheduled = row.span != null
                created += JiraImportCreated(item.jiraId, item.key(), item.level, nodeId, inserted.bindingId, item.name, scheduled)
            }
        }
        return ImportWritten(created, bound, skippedAnswer(plan.skips, withheld), released)
    }
}

/** The ids the plan side must cover: every browsed issue and every Jira parent a browsed issue names (a parent outside can be bound). */
internal fun issueIdsOf(browse: ImportBrowse): List<String> =
    browse.issues.flatMap { listOfNotNull(it.observation.issueId, it.observation.parentIssueId) }.distinct()

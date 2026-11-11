package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.users.UserService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.statements.StatementType
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraBindingServiceKey = AttributeKey<JiraBindingService>("JiraBindingService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to JiraBindingService.Bindings.id,
    "createdAt" to JiraBindingService.Bindings.createdAt,
    "issueKey" to JiraBindingService.Bindings.jiraIssueKey,
)

/** The ONE sortable whitelist of `GET /integrations/jira/bindings`, derived from the column map so the two can never drift. */
val JIRA_BINDING_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

/**
 * The key of the transaction-scoped advisory lock every bind takes first (the ASCII bytes of "AstroJBd"). Binds are human clicks, a few
 * milliseconds each, so ONE global lock serializes them all: the node and issue checks below are then exact, with no per-key lock
 * ordering to get wrong. A row lock cannot do the job - D1's cross-connection rule is a check over rows that do not exist yet.
 */
internal const val BIND_LOCK_KEY = 0x417374726F4A4264L

/**
 * What a bind commits: the connection and node it binds, the issue as the bind's Jira read observed it (already fitted to its columns,
 * [JiraObservation.of]) and the login that asked.
 */
class JiraBindCommand(val connectionId: UInt, val level: JiraLevel, val nodeId: UInt, val observation: JiraObservation, val byUserId: UInt)

/** What [JiraBindingService.insertBoundLocked] wrote: the new binding's id and the dead-node holders it released. */
internal class BoundInsert(val bindingId: UInt, val released: List<ReleasedBinding>)

/** A binding row as stored, with the connection's site (for the browse URL and D1's same-site test). */
private class StoredBinding(val row: ResultRow) {
    val id: UInt get() = row[JiraBindingService.Bindings.id].value
    val connectionId: UInt get() = row[JiraBindingService.Bindings.connectionId].value
    val level: JiraLevel get() = JiraLevel.valueOf(row[JiraBindingService.Bindings.level])
    val nodeId: UInt get() = checkNotNull(nodeIdOf(row)) { "ck_jira_bindings_node: exactly one node column is set" }
    val issueId: String get() = row[JiraBindingService.Bindings.jiraIssueId]
    val issueKey: String get() = row[JiraBindingService.Bindings.jiraIssueKey]
}

/** The id of the one node column a binding row sets (the V21 CHECK guarantees exactly one). */
internal fun nodeIdOf(row: ResultRow): UInt? = (
    row[JiraBindingService.Bindings.programId] ?: row[JiraBindingService.Bindings.projectId]
        ?: row[JiraBindingService.Bindings.milestoneId]
    )?.value

/**
 * The bindings of plan nodes to Jira issues (V21, 1:1 both ways over the ACTIVE rows). The service owns `jira_bindings` and writes the
 * first `jira_observations` row of a bind; it READS the plan (the node's chain, names) and the connection registry (site, enabled) and
 * writes nothing there (`persistence.md`). A binding is not plan state: no plan lock, no revision bump. The Jira call that precedes a
 * bind happens in the route, OUTSIDE any transaction; [bind] receives its result.
 */
class JiraBindingService(private val database: R2dbcDatabase) {
    object Bindings : UIntIdTable("jira_bindings"), SoftDeletable {
        val connectionId = reference("connection_id", JiraConnectionService.Connections)
        val level = varchar("level", length = 10)
        val programId = reference("program_id", ProgramService.Programs).nullable()
        val projectId = reference("project_id", ProjectService.Projects).nullable()
        val milestoneId = reference("milestone_id", MilestoneService.Milestones).nullable()

        /** The numeric id: a key changes when the issue moves project. */
        val jiraIssueId = varchar("jira_issue_id", length = 20)
        val jiraIssueKey = varchar("jira_issue_key", length = 50)
        val createdByUserId = reference("created_by_user_id", UserService.Users).nullable()

        // V22's three whole-binding acknowledgement columns are gone (dropped by V30): the acknowledgements are per line,
        // `JiraAcknowledgeService.Acknowledgements`.
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * Binds [command]'s node to its issue. Everything runs in ONE transaction, in a fixed lock order: the global bind lock, the
     * connection row `FOR SHARE` (a delete or edit of the connection waits, or has won and this is a 400), the node row `FOR SHARE`
     * (its soft delete or owner change waits, or has won and this is a 404), then the chain re-read and [guard] re-run against it (the
     * caller's person is locked `FOR SHARE` inside the guard), then the uniqueness checks under row locks, then the inserts. Only the
     * node's own row is locked, never an ancestor's (no cycle with a plan writer that updates a chain top-down); an ancestor's owner
     * changed between the chain read and this commit is the one residual window, and the next run's sweep covers a deletion.
     *
     * The node's own active binding is a `409`; the issue's active bindings - on this connection, or on another ACTIVE connection of
     * the same site (D1: V21's index is per connection) - are a `409` unless their node is gone, in which case they are RELEASED
     * (soft-deleted, reported in [JiraBindOutcome.released] for the route to audit after the commit). Nothing else can create an active
     * binding while the bind lock is held, so the checks are exact and the two V21 unique indexes stay a pure backstop.
     */
    suspend fun bind(command: JiraBindCommand, guard: suspend (OwnerChain) -> Unit): JiraBindOutcome = suspendTransaction(database) {
        exec("SELECT pg_advisory_xact_lock($BIND_LOCK_KEY)", explicitStatementType = StatementType.SELECT) { 0 }?.toList()
        val connections = JiraConnectionService.Connections
        val locked = connections.select(connections.siteUrl, connections.projectKeys)
            .where { (connections.id eq command.connectionId) and connections.active() and (connections.enabled eq true) }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().singleOrNull()
            ?: throw BadRequestException(UNKNOWN_CONNECTION)
        val site = locked[connections.siteUrl]
        // The scope was checked before the Jira read; a `projectKeys` PUT that landed meanwhile must not commit an out-of-scope binding.
        requireInScope(command.observation.issueKey, parseStringArray(locked[connections.projectKeys]))
        if (!lockNodeShared(command.level, command.nodeId)) throw NotFoundException("${command.level.title()} not found")
        guard(activeChain(command.level, command.nodeId) ?: throw NotFoundException("${command.level.title()} not found"))

        val siteConnections = connections.select(connections.id)
            .where { connections.active() and (LowerCase(connections.siteUrl) eq site.lowercase()) }
            .toList().map { it[connections.id].value }
        val inserted = insertBoundLocked(command, siteConnections)
        val binding = checkNotNull(readOne(Bindings.id eq inserted.bindingId)) { "the binding just inserted is readable" }
        JiraBindOutcome(binding, inserted.released)
    }

    /**
     * The checks and inserts of a bind, for [bind] and the Jira import (1.2). The node's own active binding is a `409`; the issue's active
     * bindings on [siteConnectionIds] are a `409` unless their node is gone, in which case they are released (soft-deleted) and reported in
     * [BoundInsert.released] for the caller to audit after the commit. Then the binding row and its first observation are inserted.
     *
     * The checks are exact only if the CALLER has already, in its own `suspendTransaction`: taken `BIND_LOCK_KEY` (so nothing else can
     * create an active binding meanwhile) and the connection row `FOR SHARE`; called `requireInScope` against the locked connection's
     * `projectKeys`; called `lockNodeShared` on the node when it already exists (a node inserted in the same transaction needs none);
     * read and guarded the node's chain; and read [siteConnectionIds] under those locks - EVERY active connection of the site (D1),
     * the command's own included.
     *
     * Lock order of the two callers: a bind takes the bind lock, the connection row, the node row, the person row (inside the guard),
     * then the binding rows; the import takes the plan lock FIRST and the bind lock before touching any row. The bind never takes the
     * plan lock, so a bind waits only on node, person and binding rows - which a plan writer (it holds the plan lock, so never
     * concurrently with the import), a person writer or the run can hold, none of which waits for the bind lock: no cycle. A caller that
     * took the bind lock AFTER row locks, or waited for the plan lock while holding it, would close one.
     */
    internal suspend fun insertBoundLocked(command: JiraBindCommand, siteConnectionIds: List<UInt>): BoundInsert {
        val node = command.level to command.nodeId
        val onNode = lockedActive(nodeColumn(command.level) eq command.nodeId)
        onNode.firstOrNull()?.let { other ->
            val me = describeNodes(listOf(node)).getValue(node)
            throw ConflictException("${me.kind.title()} ${me.name} is already linked to ${other.issueKey}", ALREADY_BOUND_PROBLEM)
        }
        val sameIssue = lockedActive(
            (Bindings.connectionId inList siteConnectionIds) and (Bindings.jiraIssueId eq command.observation.issueId),
        )
        val released = sameIssue.mapNotNull { other -> releaseOrRefuse(other, command.observation.issueKey) }

        val stamp = nowMillis()
        val id = Bindings.insert {
            it[connectionId] = command.connectionId
            it[level] = command.level.name
            it[nodeColumn(command.level)] = command.nodeId
            it[jiraIssueId] = command.observation.issueId
            it[jiraIssueKey] = command.observation.issueKey
            it[createdByUserId] = command.byUserId
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Bindings.id].value
        insertFirstObservation(id, command.observation)
        return BoundInsert(id, released)
    }

    /**
     * A conflicting binding of the issue: refused (`409`, naming the node it is linked to) while its node is alive, released when the node
     * or any ancestor was deleted (nobody can act on a dead node, and the Jira item must not stay blocked by it).
     */
    private suspend fun releaseOrRefuse(other: StoredBinding, issueKey: String): ReleasedBinding? {
        val otherNode = other.level to other.nodeId
        if (activeChain(other.level, other.nodeId) != null) {
            val where = describeNodes(listOf(otherNode))[otherNode]
            val target = where?.let { "${it.kind.label()} ${it.name}" } ?: "another plan node"
            throw ConflictException("$issueKey is already linked to $target", ALREADY_BOUND_PROBLEM)
        }
        Bindings.update({ (Bindings.id eq other.id) and Bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        return ReleasedBinding(other.id, other.connectionId, other.level, other.nodeId, other.issueKey)
    }

    /**
     * The ACTIVE bindings matching [predicate] in id order (deterministic for the release-then-refuse path), locked `FOR NO KEY UPDATE`
     * for the rest of the transaction.
     */
    private suspend fun lockedActive(predicate: Op<Boolean>): List<StoredBinding> =
        Bindings.selectAll().where { Bindings.active() and predicate }.orderBy(Bindings.id)
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().map(::StoredBinding)

    /**
     * Soft-deletes binding [id] (the row stays as history). The caller read the binding and its [lastKnownChain] first for the 404 -> 403
     * ordering; here the row is locked, re-read, and [guard] runs again against the chain as last stored (read without any `active()`
     * filter: a binding whose node was deleted is unbound by whoever passes the guard on the chain it had).
     */
    suspend fun unbind(id: UInt, guard: suspend (OwnerChain) -> Unit): JiraUnbindOutcome = suspendTransaction(database) {
        val binding = lockedActive(Bindings.id eq id).singleOrNull() ?: throw NotFoundException("Jira binding not found")
        guard(lastKnownChain(binding.level, binding.nodeId) ?: throw NotFoundException("Jira binding not found"))
        Bindings.update({ (Bindings.id eq id) and Bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        JiraUnbindOutcome(binding.connectionId, binding.level, binding.nodeId, binding.issueId, binding.issueKey)
    }

    /** The ACTIVE chain of a node (the bind route's read-before-guard): null when the node or any ancestor is missing or deleted. */
    suspend fun chainOf(level: JiraLevel, nodeId: UInt): OwnerChain? = suspendTransaction(database) { activeChain(level, nodeId) }

    /** The chain the unbind route guards against before taking any lock: null when the binding is missing or already unbound (404). */
    suspend fun chainForUnbind(id: UInt): OwnerChain? = suspendTransaction(database) {
        val binding = Bindings.selectAll().where { (Bindings.id eq id) and Bindings.active() }.toList().singleOrNull()?.let(::StoredBinding)
        binding?.let { lastKnownChain(it.level, it.nodeId) }
    }

    /** One binding by id: null when it is missing, unbound, or its node (or an ancestor) is gone. */
    suspend fun read(id: UInt): JiraBindingResponse? = suspendTransaction(database) { readOne(Bindings.id eq id) }

    /** The paged list: ACTIVE bindings of LIVE nodes, count and rows on ONE predicate in ONE read transaction. */
    suspend fun list(filter: JiraBindingFilter, paging: PageRequest): JiraBindingListResult = suspendTransaction(database) {
        var predicate: Op<Boolean> = Bindings.active() and liveNode()
        filter.connectionId?.let { predicate = predicate and (Bindings.connectionId eq it) }
        filter.level?.let { predicate = predicate and (Bindings.level eq it.name) }
        filter.q?.takeIf { it.isNotBlank() }?.let { q ->
            predicate = predicate and (
                (Bindings.milestoneId inSubQuery namedMilestoneIds(q)) or
                    (Bindings.projectId inSubQuery namedProjectIds(q)) or
                    (Bindings.programId inSubQuery namedProgramIds(q))
                )
        }
        val total = Bindings.selectAll().where { predicate }.count()
        val rows = Bindings.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        JiraBindingListResult(responsesOf(rows), total)
    }

    private fun liveNode(): Op<Boolean> =
        (Bindings.milestoneId inSubQuery liveMilestoneIds()) or (Bindings.projectId inSubQuery liveProjectIds()) or
            (Bindings.programId inSubQuery liveProgramIds())

    private suspend fun readOne(predicate: Op<Boolean>): JiraBindingResponse? {
        val rows = Bindings.selectAll().where { Bindings.active() and liveNode() and predicate }.toList()
        return responsesOf(rows).singleOrNull()
    }

    /** The wire rows for [rows], in order: the nodes, the sites, the observations and the creators each from one batched read. */
    private suspend fun responsesOf(rows: List<ResultRow>): List<JiraBindingResponse> {
        if (rows.isEmpty()) return emptyList()
        val stored = rows.map(::StoredBinding)
        val nodes = describeNodes(stored.map { it.level to it.nodeId })
        val connections = JiraConnectionService.Connections
        val siteRows = connections.select(connections.id, connections.siteUrl, connections.projectKeys)
            .where { connections.id inList stored.map { it.connectionId }.distinct() }
            .toList().associateBy { it[connections.id].value }
        val connectionOf = stored.associate { it.id to it.connectionId }
        val observations = JiraObservations.selectAll().where { JiraObservations.bindingId inList stored.map { it.id } }.toList()
            .associate { observed ->
                val bindingId = observed[JiraObservations.bindingId].value
                val keys = siteRows[connectionOf[bindingId]]?.let { parseStringArray(it[connections.projectKeys]) }.orEmpty()
                bindingId to observed.toObservationResponse(keys)
            }
        val creators = creatorsOf(rows.mapNotNull { it[Bindings.createdByUserId]?.value })
        return stored.map { binding ->
            val creator = binding.row[Bindings.createdByUserId]?.value?.let(creators::get)
            JiraBindingResponse(
                id = binding.id,
                connectionId = binding.connectionId,
                level = binding.level,
                node = checkNotNull(nodes[binding.level to binding.nodeId]) { "a binding's node row exists (foreign key)" },
                issueId = binding.issueId,
                issueKey = binding.issueKey,
                url = "${siteRows[binding.connectionId]?.get(connections.siteUrl).orEmpty()}/browse/${binding.issueKey}",
                observation = observations[binding.id],
                createdAt = binding.row[Bindings.createdAt],
                createdBy = creator?.let { JiraBindingCreator(it.userId, it.name) },
            )
        }
    }

    private fun nodeColumn(level: JiraLevel): Column<EntityID<UInt>?> = when (level) {
        JiraLevel.PROGRAM -> Bindings.programId
        JiraLevel.PROJECT -> Bindings.projectId
        JiraLevel.MILESTONE -> Bindings.milestoneId
    }
}

/** The connection a bind named is unknown, deleted or disabled (one wording: the registry is ADMIN-only data). */
const val UNKNOWN_CONNECTION = "Unknown or disabled Jira connection"

internal fun JiraLevel.title(): String = label().replaceFirstChar(Char::uppercase)

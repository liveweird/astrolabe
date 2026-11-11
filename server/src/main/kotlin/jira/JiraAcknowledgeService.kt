package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.Op
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraAcknowledgeServiceKey = AttributeKey<JiraAcknowledgeService>("JiraAcknowledgeService")

/** One line a committed acknowledge stamped, for the route's per-row audit line: its kind, severity and STORED (per-line) fingerprint. */
class AcknowledgedLine(val kind: DeviationKind, val severity: DeviationSeverity, val fingerprint: String)

/** One stored row a committed withdrawal deleted, for the audit line: the kind as stored (a retired kind stays a name), its fingerprint. */
class WithdrawnLine(val kind: String, val fingerprint: String)

/**
 * What a committed acknowledge leaves for the route's audit lines (written AFTER the commit): the binding and the lines it stamped.
 * [requestedKind] is the request's kind (null = the kind-less form, which stamps a set of lines and audits a batch line too).
 */
class AcknowledgeOutcome(
    val acknowledgement: Acknowledgement,
    val connectionId: UInt,
    val level: JiraLevel,
    val nodeId: UInt,
    val issueKey: String,
    val requestedKind: DeviationKind?,
    val lines: List<AcknowledgedLine>,
)

/** What a committed withdrawal leaves for the audit lines: the binding and the rows that went (the kind-less form adds a batch line). */
class UnacknowledgeOutcome(
    val connectionId: UInt,
    val level: JiraLevel,
    val nodeId: UInt,
    val issueKey: String,
    val requestedKind: DeviationKind?,
    val rows: List<WithdrawnLine>,
)

/**
 * Who may acknowledge a binding, as the acknowledge reads it from the plan: the [owners] of the node's ACTIVE chain and, for a
 * MILESTONE binding only, the milestone's STORED [teamId] (its team manager may acknowledge too, 1.12; null for a program or project).
 */
class AckAudience(val owners: OwnerChain, val teamId: UInt?)

/** A stored per-line acknowledgement: the LINE's fingerprint it was made on, when, and the acknowledging login's id. */
internal class StoredLineAck(val fingerprint: String, val at: Long, val byUserId: UInt)

/** A binding row as the acknowledge reads it under its lock. */
private class LockedBinding(val connectionId: UInt, val level: JiraLevel, val nodeId: UInt, val issueKey: String)

/**
 * The acknowledgement of a binding's deviations, "until changed", PER LINE since 1.12 (V28 `jira_deviation_acknowledgements`; 1.3's
 * whole-binding `jira_bindings` columns were dropped by V30): the service OWNS the table and reads `planning`'s chains
 * and, through [DeviationViewService], the whole deviations computation. The key is (binding, [DeviationKind]) - the kernel raises
 * each kind at most once per binding. Rows are HARD: a withdrawal deletes, a re-acknowledge rewrites the stamp; the stored per-line
 * fingerprint is compared with the line's on every read, so a changed line reads `current = false` (open again). **No pruning
 * anywhere (the 1.12 ruling):** a line that leaves the list and returns identical is still acknowledged. **No plan lock, no revision
 * bump and no `jira_bindings.updated_at` touch**: an acknowledgement is not plan state.
 *
 * Both writes run in ONE short transaction in this order: the binding row `FOR NO KEY UPDATE` ([lockActiveForWrite]; gone = `404`),
 * the node's audience re-read ACTIVE (dead = `404`; a milestone's STORED team included) and the caller's [guard] run AGAIN against it
 * (the route passes `requireOwnerOrTeamManagerOrAdmin` with the person re-resolved `FOR SHARE` and, for a non-owner on a milestone, the
 * team and its manager's person locked `FOR SHARE` too: a request can be held open between its outer guard and this lock, so only
 * this verdict authorizes the write), and then - for [acknowledge] - the binding's deviations RECOMPUTED here
 * ([DeviationViewService.computeBindingInTransaction]) and compared with the LIST fingerprint the client saw. **Invariant: every write
 * of a binding's acknowledgement rows holds that binding's row lock**, so the delete-then-insert below is exact and the unique index
 * `uq_jira_deviation_acks_key` is only the backstop. The row lock excludes the run's observation write for this binding (it locks the
 * row first), so the Jira side cannot move under the compare; the plan side is read statement by statement (READ COMMITTED), so an
 * edit landing in between can make the compare a `409` (the client reads again) or, at worst, accept a fingerprint of a mixed state -
 * harmless, because a stored fingerprint is re-compared on every read and such a line just reads `current = false`.
 */
class JiraAcknowledgeService(private val database: R2dbcDatabase, private val deviations: DeviationViewService) {
    private val bindings = JiraBindingService.Bindings

    object Acknowledgements : UIntIdTable("jira_deviation_acknowledgements") {
        val bindingId = reference("binding_id", JiraBindingService.Bindings)

        /** A [DeviationKind] name; the table's CHECK pins its SHAPE only, so a stored kind the code no longer knows is ignored on read. */
        val kind = varchar("kind", length = KIND_WIDTH)
        val fingerprint = varchar("fingerprint", length = FINGERPRINT_WIDTH)
        val stampedAt = long("ack_at")

        /** The acknowledging login's id (`users.id` is BIGINT; V28 has the FK). */
        val stampedByUserId = long("ack_by_user_id")

        /**
         * The stored acknowledgements of [bindingIds] in ONE statement, by binding and kind: the view's read, the acknowledge's
         * recompute and the flag fold's, all inside their own transaction. A row whose kind is not a [DeviationKind] is ignored.
         */
        internal suspend fun storedOf(bindingIds: Collection<UInt>): Map<UInt, Map<DeviationKind, StoredLineAck>> {
            if (bindingIds.isEmpty()) return emptyMap()
            val kinds = DeviationKind.entries.associateBy { it.name }
            val found = HashMap<UInt, MutableMap<DeviationKind, StoredLineAck>>()
            select(bindingId, kind, fingerprint, stampedAt, stampedByUserId).where { bindingId inList bindingIds }.toList().forEach { row ->
                val known = kinds[row[kind]] ?: return@forEach
                found.getOrPut(row[bindingId].value) { HashMap() }[known] =
                    StoredLineAck(row[fingerprint], row[stampedAt], row[stampedByUserId].toUInt())
            }
            return found
        }
    }

    /** The ACTIVE audience of [bindingId]'s node (read-before-guard): null when unknown, unbound, or its node or an ancestor is gone. */
    suspend fun audienceOf(bindingId: UInt): AckAudience? = suspendTransaction(database) {
        readBinding(bindingId)?.let { activeAudience(it.level, it.nodeId) }
    }

    /**
     * Stamps acknowledgements on [bindingId] by login [byUserId]. [fingerprint] is the item's LIST fingerprint; `409`
     * [STALE_DEVIATIONS_PROBLEM] when it is not the one of the deviations as recomputed now, when there are none (nothing to
     * acknowledge), or when [kind] names a deviation the list does not hold now. With a [kind] that ONE line is stamped; without
     * one, the lines that have no current acknowledgement - or every line when each has one (the restamp the pre-1.12 call made).
     * Each stamped line stores ITS OWN fingerprint; a second acknowledge of the same state restamps who and when.
     */
    suspend fun acknowledge(
        bindingId: UInt,
        fingerprint: String,
        kind: DeviationKind?,
        byUserId: UInt,
        guard: suspend (AckAudience) -> Unit,
    ): AcknowledgeOutcome = suspendTransaction(database) {
        validateAcknowledge(AcknowledgeRequest(fingerprint, kind))
        val binding = lockedBinding(bindingId, guard)
        val computed = deviations.computeBindingInTransaction(bindingId, binding.connectionId) ?: throw NotFoundException(NOT_FOUND)
        if (computed.lines.isEmpty()) throw ConflictException("The binding has no deviation to acknowledge", STALE_DEVIATIONS_PROBLEM)
        if (computed.item.fingerprint != fingerprint) {
            throw ConflictException("The deviations changed since they were read", STALE_DEVIATIONS_PROBLEM)
        }
        val targets = if (kind == null) {
            computed.lines.filter { it.open }.ifEmpty { computed.lines }
        } else {
            val line = computed.lines.firstOrNull { it.deviation.kind == kind }
            listOf(line ?: throw ConflictException("The binding has no $kind deviation", STALE_DEVIATIONS_PROBLEM))
        }
        val stamped = targets.map { AcknowledgedLine(it.deviation.kind, it.deviation.severity, fingerprintOf(it.deviation)) }
        val stamp = nowMillis()
        deleteKinds(bindingId, stamped.map { it.kind.name })
        Acknowledgements.insertRows(stamped) { line ->
            this[Acknowledgements.bindingId] = bindingId
            this[Acknowledgements.kind] = line.kind.name
            this[Acknowledgements.fingerprint] = line.fingerprint
            this[Acknowledgements.stampedAt] = stamp
            this[Acknowledgements.stampedByUserId] = byUserId.toLong()
        }
        val by = creatorsOf(listOf(byUserId))[byUserId]?.name
        AcknowledgeOutcome(
            Acknowledgement(bindingId, kind, fingerprint, stamp, by),
            binding.connectionId, binding.level, binding.nodeId, binding.issueKey, kind, stamped,
        )
    }

    /**
     * Withdraws acknowledgements of [bindingId], current or stale alike: the row of [kind] (`404` when none is stored), or - without
     * one - EVERY stored row of the binding, a retired kind's too (`404` when there is none). Nothing is recomputed.
     */
    suspend fun unacknowledge(bindingId: UInt, kind: DeviationKind?, guard: suspend (AckAudience) -> Unit): UnacknowledgeOutcome =
        suspendTransaction(database) {
            val binding = lockedBinding(bindingId, guard)
            val rank = DeviationKind.entries.associate { it.name to it.ordinal }
            val stored = Acknowledgements.select(Acknowledgements.kind, Acknowledgements.fingerprint)
                .where { Acknowledgements.bindingId eq bindingId }.toList()
                .map { WithdrawnLine(it[Acknowledgements.kind], it[Acknowledgements.fingerprint]) }
                .sortedBy { rank[it.kind] ?: Int.MAX_VALUE }
            val cleared = if (kind == null) stored else stored.filter { it.kind == kind.name }
            if (cleared.isEmpty()) throw NotFoundException("Acknowledgement not found")
            deleteKinds(bindingId, if (kind == null) null else listOf(kind.name))
            UnacknowledgeOutcome(binding.connectionId, binding.level, binding.nodeId, binding.issueKey, kind, cleared)
        }

    /** Deletes the stored rows of [kinds] (null = every row) of [bindingId]; the caller holds the binding row lock. */
    private suspend fun deleteKinds(bindingId: UInt, kinds: List<String>?) {
        Acknowledgements.deleteWhere {
            (Acknowledgements.bindingId eq bindingId) and (kinds?.let { Acknowledgements.kind inList it } ?: Op.TRUE)
        }
    }

    /** Locks binding [bindingId] (`404` once gone), re-reads its node's ACTIVE audience (`404` when dead) and runs [guard] against it. */
    private suspend fun lockedBinding(bindingId: UInt, guard: suspend (AckAudience) -> Unit): LockedBinding {
        if (!bindings.lockActiveForWrite(bindingId)) throw NotFoundException(NOT_FOUND)
        val binding = readBinding(bindingId) ?: throw NotFoundException(NOT_FOUND)
        guard(activeAudience(binding.level, binding.nodeId) ?: throw NotFoundException(NOT_FOUND))
        return binding
    }

    private suspend fun readBinding(bindingId: UInt): LockedBinding? =
        bindings.selectAll().where { (bindings.id eq bindingId) and bindings.active() }.toList().singleOrNull()?.let { row ->
            LockedBinding(
                connectionId = row[bindings.connectionId].value,
                level = JiraLevel.valueOf(row[bindings.level]),
                nodeId = checkNotNull(nodeIdOf(row)) { "ck_jira_bindings_node: exactly one node column is set" },
                issueKey = row[bindings.jiraIssueKey],
            )
        }

    private companion object {
        const val NOT_FOUND = "Jira binding not found"
        const val KIND_WIDTH = 32
        const val FINGERPRINT_WIDTH = 64
    }
}

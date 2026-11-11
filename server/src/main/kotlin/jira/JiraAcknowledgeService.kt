package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update

val JiraAcknowledgeServiceKey = AttributeKey<JiraAcknowledgeService>("JiraAcknowledgeService")

/** What a committed acknowledge leaves for the route's audit line (written AFTER the commit): the binding and the kinds it covered. */
class AcknowledgeOutcome(
    val acknowledgement: Acknowledgement,
    val connectionId: UInt,
    val level: JiraLevel,
    val nodeId: UInt,
    val issueKey: String,
    val kinds: List<DeviationKind>,
)

/** What a committed un-acknowledge leaves for the audit line: the binding and the fingerprint that was cleared. */
class UnacknowledgeOutcome(
    val connectionId: UInt,
    val level: JiraLevel,
    val nodeId: UInt,
    val issueKey: String,
    val fingerprint: String,
)

/**
 * Who may acknowledge a binding, as the acknowledge reads it from the plan: the [owners] of the node's ACTIVE chain and, for a
 * MILESTONE binding only, the milestone's STORED [teamId] (its team manager may acknowledge too, 1.12; null for a program or project).
 */
class AckAudience(val owners: OwnerChain, val teamId: UInt?)

/** A binding row as the acknowledge reads it under its lock. */
private class LockedBinding(
    val connectionId: UInt,
    val level: JiraLevel,
    val nodeId: UInt,
    val issueKey: String,
    val ackFingerprint: String?,
)

/**
 * The acknowledgement of a binding's deviations, "until changed" (1.3): the service OWNS the three `ack_*` columns of `jira_bindings`
 * (the table is [JiraBindingService.Bindings]'s) and reads `planning`'s chains and, through [DeviationViewService], the whole
 * deviations computation. **No plan lock and no revision bump**: an acknowledgement is not plan state (like a binding).
 *
 * Both writes run in ONE short transaction in this order: the binding row `FOR NO KEY UPDATE` ([lockActiveForWrite]; gone = `404`),
 * the node's audience re-read ACTIVE (dead = `404`; a milestone's STORED team included) and the caller's [guard] run AGAIN against it
 * (the route passes `requireOwnerOrTeamManagerOrAdmin` with the person re-resolved `FOR SHARE` and, for a non-owner on a milestone, the
 * team and its manager's person locked `FOR SHARE` too: a request can be held open between its outer guard and this lock, so only
 * this verdict authorizes the write), and then - for [acknowledge] - the binding's deviations RECOMPUTED here
 * ([DeviationViewService.computeBindingInTransaction]) and compared with the fingerprint the client saw. The row lock excludes the
 * run's observation write for this binding (it locks the row first), so the Jira side cannot move under the compare; the plan side
 * is read statement by statement (READ COMMITTED), so an edit landing in between can make the compare a `409` (the client reads
 * again) or, at worst, accept a fingerprint of a mixed state - harmless, because a stored fingerprint is re-compared on every read and
 * such an acknowledgement just reads `current = false`.
 */
class JiraAcknowledgeService(private val database: R2dbcDatabase, private val deviations: DeviationViewService) {
    private val bindings = JiraBindingService.Bindings

    /** The ACTIVE audience of [bindingId]'s node (read-before-guard): null when unknown, unbound, or its node or an ancestor is gone. */
    suspend fun audienceOf(bindingId: UInt): AckAudience? = suspendTransaction(database) {
        readBinding(bindingId)?.let { activeAudience(it.level, it.nodeId) }
    }

    /**
     * Stamps the acknowledgement of [bindingId] with [fingerprint] by login [byUserId]. `409` [STALE_DEVIATIONS_PROBLEM] when the
     * fingerprint is not the one of the deviations as recomputed now, or when there are none (nothing to acknowledge); a second
     * acknowledge of the same state simply restamps who and when.
     */
    suspend fun acknowledge(
        bindingId: UInt,
        fingerprint: String,
        byUserId: UInt,
        guard: suspend (AckAudience) -> Unit,
    ): AcknowledgeOutcome = suspendTransaction(database) {
        validateAcknowledge(AcknowledgeRequest(fingerprint))
        val binding = lockedBinding(bindingId, guard)
        val computed = deviations.computeBindingInTransaction(bindingId, binding.connectionId) ?: throw NotFoundException(NOT_FOUND)
        if (computed.all.isEmpty()) throw ConflictException("The binding has no deviation to acknowledge", STALE_DEVIATIONS_PROBLEM)
        if (computed.item.fingerprint != fingerprint) {
            throw ConflictException("The deviations changed since they were read", STALE_DEVIATIONS_PROBLEM)
        }
        val stamp = nowMillis()
        bindings.update({ (bindings.id eq bindingId) and bindings.active() }) {
            it[ackFingerprint] = fingerprint
            it[ackAt] = stamp
            it[ackByUserId] = byUserId
            it[updatedAt] = stamp
        }
        val by = creatorsOf(listOf(byUserId))[byUserId]?.name
        AcknowledgeOutcome(
            Acknowledgement(bindingId, fingerprint, stamp, by), binding.connectionId, binding.level, binding.nodeId, binding.issueKey,
            computed.all.map { it.kind },
        )
    }

    /** Clears the acknowledgement of [bindingId] (current or stale alike); `404` when none is stored. */
    suspend fun unacknowledge(bindingId: UInt, guard: suspend (AckAudience) -> Unit): UnacknowledgeOutcome = suspendTransaction(database) {
        val binding = lockedBinding(bindingId, guard)
        val cleared = binding.ackFingerprint ?: throw NotFoundException("Acknowledgement not found")
        bindings.update({ (bindings.id eq bindingId) and bindings.active() }) {
            it[ackFingerprint] = null
            it[ackAt] = null
            it[ackByUserId] = null
            it[updatedAt] = nowMillis()
        }
        UnacknowledgeOutcome(binding.connectionId, binding.level, binding.nodeId, binding.issueKey, cleared)
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
                ackFingerprint = row[bindings.ackFingerprint],
            )
        }

    private companion object {
        const val NOT_FOUND = "Jira binding not found"
    }
}

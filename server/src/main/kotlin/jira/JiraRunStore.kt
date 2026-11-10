package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.db.upsertRows
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

/** The most bindings one run write touches in one transaction (`JiraObserver`'s chunk of 100). */
internal const val RUN_CHUNK = 100

/**
 * The `gone_reason` a sweep writes: absent from the in-scope listing (deleted, moved out and unreadable are indistinguishable). The
 * run's probe (`probeGone`) refines it to `DELETED` or `FORBIDDEN` for the bindings it flagged in that run.
 */
internal const val GONE_OUT_OF_SCOPE = "OUT_OF_SCOPE"

/**
 * One ACTIVE binding of the connection as the run starts: [observed] whether it has an observation row at all, [gone] and [typeId] as that
 * row holds them ([typeId] null when unknown). The run works from this list (≤ 1,200): a binding created after it was
 * read waits for the next run, and one deleted after it is filtered out again by every write.
 */
internal class BoundIssue(
    val bindingId: UInt,
    val level: JiraLevel,
    val issueId: String,
    val issueKey: String,
    val observed: Boolean,
    val gone: Boolean,
    val typeId: String?,
)

/**
 * The run's database side: short transactions, each independent of any HTTP call (`JiraObserver` makes none inside one), none taking the
 * plan lock and none bumping the revision - an observation is not plan state. It writes `jira_observations` (upsert / the gone flag) and
 * `jira_bindings.marked_as_deleted` (the node sweep's release), reads `jira_bindings` and the plan's liveness through
 * `JiraBindingNodes.kt`. **Every read of bindings filters [JiraBindingService.Bindings.active]** (a deleted connection's rows stay in
 * the table), and every write re-checks that the binding is still active under a row lock, so an unbind that raced the run is respected.
 */
internal class JiraRunStore(private val database: R2dbcDatabase) {
    private val bindings = JiraBindingService.Bindings

    suspend fun snapshot(connectionId: UInt): List<BoundIssue> = suspendTransaction(database) {
        bindings.leftJoin(JiraObservations, { bindings.id }, { JiraObservations.bindingId })
            .select(
                bindings.id, bindings.level, bindings.jiraIssueId, bindings.jiraIssueKey,
                JiraObservations.observedAt, JiraObservations.gone, JiraObservations.typeId,
            )
            .where { (bindings.connectionId eq connectionId) and bindings.active() }
            .orderBy(bindings.id).toList().map {
                BoundIssue(
                    bindingId = it[bindings.id].value,
                    level = JiraLevel.valueOf(it[bindings.level]),
                    issueId = it[bindings.jiraIssueId],
                    issueKey = it[bindings.jiraIssueKey],
                    observed = it.getOrNull(JiraObservations.observedAt) != null,
                    gone = it.getOrNull(JiraObservations.gone) == true,
                    typeId = it.getOrNull(JiraObservations.typeId),
                )
            }
    }

    /**
     * The ids in [ids] still active with their current issue key, locked to the end of the transaction (an unbind waits for the write, or
     * has won) IN ID ORDER, so two chunks never lock the same rows in opposite orders. [forWrite] takes `FOR NO KEY UPDATE` straight away
     * (the chunk that may rewrite a key; never upgraded from `FOR SHARE`, which two chunks could deadlock on), else `FOR SHARE`. The lock
     * order of `persistence.md` holds: a run's transaction takes binding rows and nothing before them.
     */
    private suspend fun lockActive(ids: Collection<UInt>, forWrite: Boolean = false): Map<UInt, String> =
        bindings.select(bindings.id, bindings.jiraIssueKey).where { (bindings.id inList ids) and bindings.active() }.orderBy(bindings.id)
            .forUpdate(if (forWrite) ForUpdateOption.PostgreSQL.ForNoKeyUpdate else ForUpdateOption.PostgreSQL.ForShare)
            .toList().associate { it[bindings.id].value to it[bindings.jiraIssueKey] }

    /**
     * Upserts [chunk] (binding id to what this run READ of its issue) in ONE transaction and answers the binding ids written. A binding
     * unbound since the run started is skipped, never resurrected or failed on; a row carries `gone = false`, because an issue the run
     * just read exists. Only what this run read is written: nothing is merged with an older observation. A MOVED issue answers
     * under its new key: the binding's key follows it in the same transaction (the list, the browse URL, the sort, audits and the
     * 409 wording all read `jira_issue_key`), and only those rows get a new `updated_at`.
     */
    suspend fun writeObservations(chunk: List<Pair<UInt, JiraObservation>>): List<UInt> {
        if (chunk.isEmpty()) return emptyList()
        return suspendTransaction(database) {
            val active = lockActive(chunk.map { it.first }, forWrite = true)
            val rows = chunk.filter { it.first in active }
            val stamp = nowMillis()
            rows.filter { (id, o) -> active[id] != o.issueKey }.forEach { (id, o) ->
                bindings.update({ bindings.id eq id }) {
                    it[jiraIssueKey] = o.issueKey
                    it[updatedAt] = stamp
                }
            }
            JiraObservations.upsertRows(rows, keys = listOf(JiraObservations.bindingId)) { (bindingId, o) ->
                this[JiraObservations.bindingId] = bindingId
                this[JiraObservations.observedAt] = o.observedAt
                this[JiraObservations.issueKey] = o.issueKey
                this[JiraObservations.summary] = o.summary
                this[JiraObservations.typeId] = o.typeId
                this[JiraObservations.typeName] = o.typeName
                this[JiraObservations.hierarchyLevel] = o.hierarchyLevel
                this[JiraObservations.statusName] = o.statusName
                this[JiraObservations.statusCategory] = o.statusCategory.name
                this[JiraObservations.parentIssueId] = o.parentIssueId
                this[JiraObservations.parentIssueKey] = o.parentIssueKey
                this[JiraObservations.startDate] = o.startDate
                this[JiraObservations.endDate] = o.endDate
                this[JiraObservations.estimate] = o.estimate
                this[JiraObservations.estimateUnit] = o.estimateUnit?.name
                this[JiraObservations.teamName] = o.teamName
                this[JiraObservations.jiraUpdatedAt] = o.jiraUpdatedAt
                this[JiraObservations.gone] = false
                this[JiraObservations.goneReason] = null
            }
            rows.map { it.first }
        }
    }

    /** Flags the bindings' observations `gone` / [GONE_OUT_OF_SCOPE] (the content last read stays); an unbound binding is left alone. */
    suspend fun markGone(bindingIds: List<UInt>) {
        if (bindingIds.isEmpty()) return
        suspendTransaction(database) {
            val active = lockActive(bindingIds).keys
            if (active.isNotEmpty()) {
                JiraObservations.update({ (JiraObservations.bindingId inList active) and (JiraObservations.gone eq false) }) {
                    it[gone] = true
                    it[goneReason] = GONE_OUT_OF_SCOPE
                }
            }
        }
    }

    /** Sets [reason] on the bindings' observations that are `gone` (the probe's verdict); an unbound binding is left alone. */
    suspend fun setGoneReason(bindingIds: List<UInt>, reason: String) {
        if (bindingIds.isEmpty()) return
        suspendTransaction(database) {
            val active = lockActive(bindingIds).keys
            if (active.isNotEmpty()) {
                JiraObservations.update({ (JiraObservations.bindingId inList active) and (JiraObservations.gone eq true) }) {
                    it[goneReason] = reason
                }
            }
        }
    }

    /** The sweep saw these issues in scope again: clears the flag on observations that carry it (the content is untouched). */
    suspend fun clearGone(bindingIds: List<UInt>) {
        if (bindingIds.isEmpty()) return
        suspendTransaction(database) {
            val active = lockActive(bindingIds).keys
            if (active.isNotEmpty()) {
                JiraObservations.update({ (JiraObservations.bindingId inList active) and (JiraObservations.gone eq true) }) {
                    it[gone] = false
                    it[goneReason] = null
                }
            }
        }
    }

    /**
     * The node sweep: soft-deletes the connection's ACTIVE bindings whose node, or any ancestor, is soft-deleted (a dead-node binding is
     * hidden from the list and reachable only by id, so nothing else would ever clear it) and answers what it released, for the caller to
     * audit after the commit. A binding an unbind or a bind's inline release got to first is not reported twice.
     */
    suspend fun releaseDeadNodeBindings(connectionId: UInt): List<ReleasedBinding> = suspendTransaction(database) {
        val rows = bindings.selectAll().where { (bindings.connectionId eq connectionId) and bindings.active() }
            .orderBy(bindings.id).toList()
        val live = JiraLevel.entries.associateWith { level ->
            liveNodeIds(level, rows.filter { JiraLevel.valueOf(it[bindings.level]) == level }.mapNotNull(::nodeIdOf))
        }
        rows.filter { row -> nodeIdOf(row) !in live.getValue(JiraLevel.valueOf(row[bindings.level])) }.mapNotNull { row ->
            val id = row[bindings.id].value
            val released = bindings.update({ (bindings.id eq id) and bindings.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
            val nodeId = nodeIdOf(row)
            if (released == 1 && nodeId != null) {
                ReleasedBinding(id, connectionId, JiraLevel.valueOf(row[bindings.level]), nodeId, row[bindings.jiraIssueKey])
            } else {
                null
            }
        }
    }
}

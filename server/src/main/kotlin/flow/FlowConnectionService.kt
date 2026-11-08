package ch.nokillswit.flow

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.EncryptedAtRest
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncRunService
import io.ktor.util.AttributeKey
import java.security.GeneralSecurityException
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory

val FlowConnectionServiceKey = AttributeKey<FlowConnectionService>("FlowConnectionService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to FlowConnectionService.Connections.id,
    "name" to FlowConnectionService.Connections.name,
    "createdAt" to FlowConnectionService.Connections.createdAt,
)

/** The ONE sortable whitelist - derived from the column map so the two can never drift. */
val FLOW_CONNECTION_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

private val log = LoggerFactory.getLogger(FlowConnectionService::class.java)

/** The `sync_runs.kind` of a Flow run: stored text until `SyncKind.FLOW` lands (the V21 CHECK already admits it). */
private const val FLOW_RUN_KIND = "FLOW"

/**
 * The Flow connection registry (V24), the Jira registry's template with Flow's own parts: `api_token` holds a [FieldCipher] envelope of
 * Flow's read-only service token, written here and decrypted by exactly two readers - [readForTest] and [readForRun] - never on a read
 * path (no response, audit line or log ever carries it). The service owns the encrypted column, so it registers with the boot backfill
 * ([EncryptedAtRest], `infra/db/Bootstrap.kt`).
 */
class FlowConnectionService(
    private val database: R2dbcDatabase,
    private val cipher: FieldCipher,
    /** Its delete removes the connection's runs; `sync/` knows nothing of `flow/` (the allowed direction). */
    private val runs: SyncRunService,
    /** The operator's origin allow-list (`FlowOrigins.baseUrlAllowed`): a registry write can never widen it. */
    private val baseUrlAllowed: (String) -> Boolean,
) : EncryptedAtRest {
    object Connections : UIntIdTable("flow_connections"), SoftDeletable {
        // Case-folded name uniqueness rides the partial unique index uq_flow_connections_name_active (V24, active rows only).
        val name = varchar("name", length = MAX_FLOW_CONNECTION_NAME_LENGTH)

        /** An exact origin the operator listed: the connection's identity, never changed by a PUT. */
        val baseUrl = varchar("base_url", length = MAX_FLOW_BASE_URL_LENGTH)
        val timeZone = varchar("time_zone", length = MAX_FLOW_TIME_ZONE_LENGTH)

        /** A `FieldCipher` envelope (`enc:v1:...`); write-only end to end. NULL only on a deleted row (V24 CHECKs). */
        val apiToken = text("api_token").nullable()
        val enabled = bool("enabled")

        /** Minutes between scheduled runs (V24, CHECK 5..1440); null = manual only. */
        val pollIntervalMinutes = integer("poll_interval_minutes").nullable()
        val lastTestedAt = long("last_tested_at").nullable()
        val lastTestOk = bool("last_test_ok").nullable()

        /** When a run last replaced the mirror (null = never); [FlowMirrorStore] writes it. */
        val teamsAt = long("teams_at").nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    override val encryptedRowLabel = "Flow service token"

    /** The boot backfill: wraps legacy plaintext tokens once; with a rotation key, re-wraps EVERY row (soft-deleted included). */
    override suspend fun encryptLegacyRows(reencryptAll: Boolean): Int = suspendTransaction(database) {
        cipher.reencryptRows(Connections, listOf(Connections.apiToken), reencryptAll)
    }

    suspend fun list(paging: PageRequest): FlowConnectionListResult = suspendTransaction(database) {
        val predicate = Connections.active()
        val total = Connections.selectAll().where { predicate }.count()
        val rows = Connections.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        FlowConnectionListResult(rows.map { it.toResponse() }, total)
    }

    /** The connection, or null when missing/deleted. */
    suspend fun read(id: UInt): FlowConnectionResponse? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()?.toResponse()
    }

    /** Creates the connection; the token is encrypted before it is bound. A name clash rides the V24 partial index into the central 409. */
    suspend fun create(request: FlowConnectionRequest): UInt = suspendTransaction(database) {
        validateFlowConnection(request, apiTokenRequired = true, baseUrlAllowed) // re-checked service-side so direct callers stay guarded
        val token = checkNotNull(request.apiToken) { "apiToken is validated as required on create" }
        val stamp = nowMillis()
        Connections.insert {
            it[name] = request.name
            it[baseUrl] = request.baseUrl
            it[timeZone] = request.timeZone
            it[apiToken] = cipher.encrypt(token)
            it[enabled] = request.enabled
            it[pollIntervalMinutes] = request.pollIntervalMinutes
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Connections.id].value
    }

    /**
     * Full replace of everything but the origin and the token's presence: an omitted/blank token keeps the stored one, a present one
     * rotates it. The origin is the connection's identity (its mirror and bindings all describe THAT Flow), so a different `baseUrl` is
     * a 409 - create a new connection instead. `affected` 0 -> 404. The interval is part of the replace (an omitted member arrives as
     * the default, 60); every PUT bumps `updated_at`, which makes the connection due at once (the poll rule's `changedAt`).
     */
    suspend fun update(id: UInt, request: FlowConnectionRequest): FlowConnectionUpdateOutcome = suspendTransaction(database) {
        // The origin allow-list is NOT asked here: the origin is the identity and cannot change (a different one is the 409 below), so an
        // unchanged origin an operator has since delisted must not stop an admin from disabling, renaming or re-tokening the connection.
        validateFlowConnection(request, apiTokenRequired = false) { true }
        // NO KEY UPDATE: serializes with other registry writers but not with FK-checking inserts that reference the row (persistence.md
        // "Row locks vs. FK locks").
        val before = Connections.selectAll().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction FlowConnectionUpdateOutcome(0, false, flowHostOf(request.baseUrl))
        if (before[Connections.baseUrl] != request.baseUrl) {
            throw ConflictException("The origin of a Flow connection cannot be changed - create a new connection")
        }
        // The last test judged the old credential and zone: a changed token or zone says nothing about the new ones until the admin tests
        // again (the name, `enabled` and the interval do not change what a test probes).
        val testInvalidated = request.apiToken != null || before[Connections.timeZone] != request.timeZone
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[name] = request.name
            it[timeZone] = request.timeZone
            request.apiToken?.let { token -> it[apiToken] = cipher.encrypt(token) }
            if (testInvalidated) {
                it[lastTestedAt] = null
                it[lastTestOk] = null
            }
            it[enabled] = request.enabled
            it[pollIntervalMinutes] = request.pollIntervalMinutes // a full replace: a PUT without the member resets it to the default
            it[updatedAt] = nowMillis()
        }
        FlowConnectionUpdateOutcome(affected, tokenRotated = request.apiToken != null, host = flowHostOf(request.baseUrl))
    }

    /**
     * Test connection's reader of the stored token (the first of the TWO that decrypt it, with [readForRun]): decrypts it here, in
     * memory, for the caller. A token that cannot be decrypted (`AEADBadTagException` from a wrong or rotated `DATA_ENCRYPTION_KEY`, a
     * corrupt envelope) reads as `apiToken = null` - the caller answers a typed row, never a 500 - and the failure is logged without the
     * envelope or the exception text. Null when the connection is missing or deleted. Its own short transaction: nothing here spans the
     * HTTP call that follows.
     */
    suspend fun readForTest(id: UInt): FlowConnectionTarget? = readDecrypted(id)

    /**
     * The run's reader of the stored token (the second and last decrypting reader): the same target, one short transaction before the
     * Flow call, none across it. The run re-asks [runnableState] before it writes the mirror. Null when the connection is missing or
     * deleted.
     */
    suspend fun readForRun(id: UInt): FlowConnectionTarget? = readDecrypted(id)

    /** The ONE private decrypting reader behind the two named ones (it hands the plaintext to no caller but theirs). */
    private suspend fun readDecrypted(id: UInt): FlowConnectionTarget? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()?.let(::targetOf)
    }

    /**
     * Records a stored-token Test connection: `last_tested_at`/`last_test_ok`. Skipped (false) if the row vanished or was edited since
     * [expectedUpdatedAt] was read (a rotated token, say: the result judged the old one). Does not bump `updated_at`.
     */
    suspend fun recordTest(id: UInt, expectedUpdatedAt: Long, ok: Boolean, at: Long): Boolean = suspendTransaction(database) {
        val row = Connections.select(Connections.id, Connections.updatedAt).where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
        if (row == null || row[Connections.updatedAt] != expectedUpdatedAt) return@suspendTransaction false
        Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[lastTestedAt] = at
            it[lastTestOk] = ok
        }
        true
    }

    /**
     * The scheduler's rows: every ACTIVE connection in id order as the connector-agnostic [ConnectorConnection], selecting SEVEN columns by
     * name - never the encrypted token - so the timer's read can neither decrypt a credential nor carry one into a log line. `ready` is
     * "the last Test connection passed" (a poll of an untested or failing connection could only fail); `changedAt` is the later of the
     * row's last edit and its last test, so a new token or a fresh passing test makes the connection due at once.
     */
    suspend fun pollRows(queryTimeoutSeconds: Int = 0): List<ConnectorConnection> = suspendTransaction(database) {
        queryTimeout = queryTimeoutSeconds
        Connections.select(
            Connections.id, Connections.name, Connections.enabled, Connections.pollIntervalMinutes,
            Connections.lastTestOk, Connections.updatedAt, Connections.lastTestedAt,
        ).where { Connections.active() }.orderBy(Connections.id).toList().map {
            ConnectorConnection(
                id = it[Connections.id].value,
                name = it[Connections.name],
                enabled = it[Connections.enabled],
                pollIntervalMinutes = it[Connections.pollIntervalMinutes],
                ready = it[Connections.lastTestOk] == true,
                changedAt = maxOf(it[Connections.updatedAt], it[Connections.lastTestedAt] ?: 0L),
            )
        }
    }

    /** Whether the connection is active and enabled: what a manual run needs before it claims (no token is read). */
    suspend fun isRunnable(id: UInt): Boolean = runnableState(id) == FlowRunnableState.RUNNABLE

    /**
     * Whether the connection is still there to run against, for a run in flight: `GONE` once it is deleted (its token is destroyed, so a
     * copy held in memory must not authenticate one more read), `DISABLED` once an administrator switched it off. Its own short
     * transaction.
     */
    suspend fun runnableState(id: UInt): FlowRunnableState = suspendTransaction(database) {
        val enabled = Connections.select(Connections.enabled).where { (Connections.id eq id) and Connections.active() }
            .toList().singleOrNull()?.get(Connections.enabled)
        when (enabled) {
            null -> FlowRunnableState.GONE
            false -> FlowRunnableState.DISABLED
            true -> FlowRunnableState.RUNNABLE
        }
    }

    /**
     * Soft delete: frees the name, sets the token NULL, and - in the SAME transaction - soft-deletes the connection's ACTIVE team
     * bindings, hard-deletes its runs and its mirror. `affected` 0 = missing/deleted (404). The mirror rows removed are logged after
     * the commit, never as an audit field.
     */
    suspend fun delete(id: UInt): FlowConnectionDeleteOutcome = deleteInTransaction(id).also {
        if (it.mirrorDeleted > 0) log.info("Flow connection {} deleted: {} mirror rows removed", id, it.mirrorDeleted)
    }

    private suspend fun deleteInTransaction(id: UInt): FlowConnectionDeleteOutcome = suspendTransaction(database) {
        val row = Connections.selectAll().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction FlowConnectionDeleteOutcome(0, "", "", 0)
        val stamp = nowMillis()
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
            // A deleted connection has no use for its credential: the column goes NULL (V24 allows it on a deleted row only), so no secret
            // stays at rest and no envelope is left under a key that a later rotation would have to open (the rotation skips NULLs).
            it[apiToken] = null
        }
        // The runs are operational history of a registry row that no longer shows; a run still in flight ends as a no-op finish.
        val runsDeleted = runs.deleteForConnectionInTransaction(FLOW_RUN_KIND, id)
        // The mirror too; a run's write re-checks the connection is ACTIVE under a row lock (FlowMirrorStore.replace).
        val mirrorDeleted = FlowMirrorStore.deleteForConnectionInTransaction(id)
        // The connection's bindings go with it: an active binding on a deleted connection would block its team (the team has at most one
        // Flow team across connections) for good. The row lock above makes a racing link wait (it locks the connection FOR SHARE).
        val bindings = FlowTeamBindingService.Bindings
        val unbound = bindings.update({ (bindings.connectionId eq id) and bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
        }
        FlowConnectionDeleteOutcome(
            affected, row[Connections.name], flowHostOf(row[Connections.baseUrl]), unbound, runsDeleted, mirrorDeleted,
        )
    }

    private fun targetOf(row: ResultRow): FlowConnectionTarget {
        val id = row[Connections.id].value
        val token = try {
            row[Connections.apiToken]?.let(cipher::decrypt) // null only if a CHECK was bypassed: read as unreadable
        } catch (cause: GeneralSecurityException) {
            logUnreadableToken(id, cause)
        } catch (cause: IllegalArgumentException) {
            logUnreadableToken(id, cause)
        }
        return FlowConnectionTarget(
            id = id,
            name = row[Connections.name],
            baseUrl = row[Connections.baseUrl],
            timeZone = row[Connections.timeZone],
            apiToken = token,
            enabled = row[Connections.enabled],
            expectedUpdatedAt = row[Connections.updatedAt],
        )
    }

    private fun logUnreadableToken(id: UInt, cause: Exception): String? {
        // The exception CLASS only: a decrypt failure's message can name the cipher's internals, never the value, but the rule is the same
        // as for the other secret paths (`security.md` "Log hygiene").
        log.warn("The stored service token of Flow connection {} cannot be decrypted ({})", id, cause.javaClass.simpleName)
        return null
    }

    private fun ResultRow.toResponse(): FlowConnectionResponse = FlowConnectionResponse(
        id = this[Connections.id].value,
        name = this[Connections.name],
        baseUrl = this[Connections.baseUrl],
        timeZone = this[Connections.timeZone],
        hasApiToken = this[Connections.apiToken]?.isNotEmpty() == true, // the envelope itself is never read past this
        enabled = this[Connections.enabled],
        pollIntervalMinutes = this[Connections.pollIntervalMinutes],
        lastTestedAt = this[Connections.lastTestedAt],
        lastTestOk = this[Connections.lastTestOk],
        teamsAt = this[Connections.teamsAt],
        createdAt = this[Connections.createdAt],
        updatedAt = this[Connections.updatedAt],
    )
}

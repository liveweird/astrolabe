package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.EncryptedAtRest
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.decryptOrNull
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.jsonb
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.infra.json.stringArrayJson
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.sync.ConnectionColumns
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.RunnableState
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncStatus
import ch.nokillswit.sync.isRunnable
import ch.nokillswit.sync.lockActiveConnection
import ch.nokillswit.sync.runnableStateOf
import ch.nokillswit.sync.statusesInTransaction
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory

val JiraConnectionServiceKey = AttributeKey<JiraConnectionService>("JiraConnectionService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to JiraConnectionService.Connections.id,
    "name" to JiraConnectionService.Connections.name,
    "createdAt" to JiraConnectionService.Connections.createdAt,
)

/** The ONE sortable whitelist - derived from the column map so the two can never drift. */
val JIRA_CONNECTION_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

private val log = LoggerFactory.getLogger(JiraConnectionService::class.java)

/**
 * The Jira connection registry (V21), the `teams/` template with the application's first stored credential: `api_token` holds a
 * [FieldCipher] envelope, written here and NEVER decrypted on a read path (no response, audit line or log ever carries it; the connector
 * that calls Jira with it is [readForTest]'s and [readForPeek]'s). The service owns the encrypted column, so it registers with the
 * boot backfill ([EncryptedAtRest], `infra/db/Bootstrap.kt`). The Test result and the mapping document are stored by [JiraTestRecorder]
 * and [JiraMappingStore], which never select the token.
 */
class JiraConnectionService(
    private val database: R2dbcDatabase,
    private val cipher: FieldCipher,
    /** Its newest run rides every response and its delete removes the runs; `sync/` knows nothing of `jira/` (the allowed direction). */
    private val runs: SyncRunService,
) : EncryptedAtRest {
    object Connections : UIntIdTable("jira_connections"), ConnectionColumns {
        // Case-folded name uniqueness rides the partial unique index uq_jira_connections_name_active (V21, active rows only).
        override val name = varchar("name", length = MAX_JIRA_CONNECTION_NAME_LENGTH)
        val siteUrl = varchar("site_url", length = MAX_SITE_URL_LENGTH)
        val email = varchar("email", length = MAX_JIRA_EMAIL_LENGTH)

        /** A `FieldCipher` envelope (`enc:v1:...`); write-only end to end. */
        // NULL only on a deleted row (V21 CHECKs): a delete destroys the credential for good.
        val apiToken = text("api_token").nullable()
        val authScheme = varchar("auth_scheme", length = 10)
        val projectKeys = jsonb("project_keys")
        val cloudId = varchar("cloud_id", length = 36).nullable()
        val mapping = jsonb("mapping")

        /** The last field/issue-type snapshot (canonical JSON, up to ~300 KB): never in a registry list or summary read. */
        val discovery = jsonb("discovery").nullable()
        val discoveredAt = long("discovered_at").nullable()

        /** The instant a mapping PUT last CHANGED the canonical document (null = never): a run after it must read in full. */
        val mappingChangedAt = long("mapping_changed_at").nullable()

        /** V23: when the child level was last fully censused (null = never: the next run reads in full); [JiraIssueStore] writes it. */
        val censusAt = long("census_at").nullable()
        val lastTestedAt = long("last_tested_at").nullable()
        val lastTestOk = bool("last_test_ok").nullable()
        override val enabled = bool("enabled")

        /** Minutes between scheduled runs (V22, CHECK 5..1440); null = manual only. Existing rows took the column DEFAULT, 15. */
        override val pollIntervalMinutes = integer("poll_interval_minutes").nullable()
        val createdAt = long("created_at")
        override val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    override val encryptedRowLabel = "Jira API token"

    /** Every column but the discovery blob: the registry's reads and locks never pull the snapshot. */
    private fun summary() = Connections.select(Connections.columns.filter { it != Connections.discovery })

    /** The boot backfill: wraps legacy plaintext tokens once; with a rotation key, re-wraps EVERY row (soft-deleted included). */
    override suspend fun encryptLegacyRows(reencryptAll: Boolean): Int = suspendTransaction(database) {
        cipher.reencryptRows(Connections, listOf(Connections.apiToken), reencryptAll)
    }

    suspend fun list(paging: PageRequest): JiraConnectionListResult = suspendTransaction(database) {
        val predicate = Connections.active()
        val total = Connections.selectAll().where { predicate }.count()
        val rows = summary().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        // One indexed LIMIT query per listed connection (a page holds at most 100), inside this transaction.
        val statuses = runs.statusesInTransaction(SyncKind.JIRA, rows.map { it.toConnectorConnection() })
        JiraConnectionListResult(rows.zip(statuses) { row, status -> row.toResponse(status) }, total)
    }

    /** The connection, or null when missing/deleted. */
    suspend fun read(id: UInt): JiraConnectionResponse? = suspendTransaction(database) {
        summary().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()
            ?.let { row -> row.toResponse(runs.statusesInTransaction(SyncKind.JIRA, listOf(row.toConnectorConnection())).single()) }
    }

    /** Creates the connection; the token is encrypted before it is bound. A name clash rides the V21 partial index into the central 409. */
    suspend fun create(request: JiraConnectionRequest): UInt = suspendTransaction(database) {
        validateJiraConnection(request, apiTokenRequired = true) // re-checked service-side so direct callers stay guarded
        val token = checkNotNull(request.apiToken) { "apiToken is validated as required on create" }
        val stamp = nowMillis()
        Connections.insert {
            it[name] = request.name
            it[siteUrl] = request.siteUrl
            it[email] = request.email
            it[apiToken] = cipher.encrypt(token)
            it[authScheme] = request.authScheme.name
            it[projectKeys] = stringArrayJson(request.projectKeys)
            it[mapping] = EMPTY_MAPPING
            it[enabled] = request.enabled
            it[pollIntervalMinutes] = request.pollIntervalMinutes
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Connections.id].value
    }

    /**
     * Full replace of everything but the site and the token's presence: an omitted/blank token keeps the stored one, a present one
     * rotates it. The site is the connection's identity (its cloud id, discovery, mapping and later its bindings all describe THAT site),
     * so a different `siteUrl` is a 409 - create a new connection instead. `affected` 0 -> 404. The interval is part of the replace
     * (an omitted member arrives as the default, 15); a PUT that changes ONLY the interval still bumps `updated_at`, which makes the next
     * run a full read (the observer's rule, one extra read of the bound items - accepted).
     */
    suspend fun update(id: UInt, request: JiraConnectionRequest): JiraConnectionUpdateOutcome = suspendTransaction(database) {
        validateJiraConnection(request, apiTokenRequired = false)
        // NO KEY UPDATE: serializes with other registry writers but not with FK-checking inserts that reference the row (persistence.md
        // "Row locks vs. FK locks").
        val before = summary().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction JiraConnectionUpdateOutcome(0, false, jiraHostOf(request.siteUrl))
        if (before[Connections.siteUrl] != request.siteUrl) {
            throw ConflictException("The site of a Jira connection cannot be changed - create a new connection")
        }
        // The last test judged the old credentials and scope: a changed token, account, auth scheme or key set says nothing about the new
        // ones until the admin tests again (name and `enabled` do not change what a test probes).
        val testInvalidated = request.apiToken != null || before[Connections.email] != request.email ||
            before[Connections.authScheme] != request.authScheme.name ||
            parseStringArray(before[Connections.projectKeys]) != request.projectKeys
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[name] = request.name
            it[email] = request.email
            request.apiToken?.let { token -> it[apiToken] = cipher.encrypt(token) }
            if (testInvalidated) {
                it[lastTestedAt] = null
                it[lastTestOk] = null
            }
            it[authScheme] = request.authScheme.name
            it[projectKeys] = stringArrayJson(request.projectKeys)
            it[enabled] = request.enabled
            it[pollIntervalMinutes] = request.pollIntervalMinutes // a full replace: a PUT without the member resets it to the default
            it[updatedAt] = nowMillis()
        }
        JiraConnectionUpdateOutcome(affected, tokenRotated = request.apiToken != null, host = jiraHostOf(request.siteUrl))
    }

    /**
     * The Test connection's ONE reader of the stored token: decrypts it here, in memory, for the connector. A token that cannot be
     * decrypted (`AEADBadTagException` from a wrong or rotated `DATA_ENCRYPTION_KEY`, a corrupt envelope) reads as `apiToken = null`
     * - the connector answers a typed row, never a 500 - and the failure is logged without the envelope or the exception text.
     * Null when the connection is missing or deleted. Its own short transaction: nothing here spans the HTTP calls that follow.
     */
    suspend fun readForTest(id: UInt): JiraTestTarget? = suspendTransaction(database) {
        summary().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()?.let(::targetOf)
    }

    /**
     * Peek's reader (the second and last one of the stored token): the target (token decrypted in memory, null when it cannot be) and the
     * mapping state, one transaction, nothing held across the Jira call that follows. Null when the connection is missing or deleted.
     */
    suspend fun readForPeek(id: UInt): JiraPeekContext? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()
            ?.let { JiraPeekContext(targetOf(it), it.toMappingState()) }
    }

    /**
     * The bind's reader of its connection (the third reader of the stored token, with [readForTest] and [readForPeek]; the run and the
     * two import routes are further callers of THIS reader, not new decrypt sites): the
     * target (token decrypted in memory, null when it cannot be), the mapping state and whether the connection is enabled, in ONE short
     * transaction before the Jira call. Null when the connection is missing or deleted.
     */
    suspend fun readForBind(id: UInt): JiraBindContext? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()
            ?.let { JiraBindContext(targetOf(it), it.toMappingState(), it[Connections.enabled], it[Connections.mappingChangedAt]) }
    }

    /** The scheduler's rows (`JiraConnectionPolling.kt`): the active connections' poll facts, never the token or the discovery. */
    suspend fun pollRows(queryTimeoutSeconds: Int = 0): List<ConnectorConnection> = jiraPollRows(database, queryTimeoutSeconds)

    /** Whether the connection is active and enabled: what a run needs before it claims (no token is read). */
    suspend fun isRunnable(id: UInt): Boolean = isRunnable(database, Connections, id)

    /** The claim's guard, INSIDE its open transaction: the ACTIVE row locked `FOR SHARE` against [delete]. */
    suspend fun lockActiveInTransaction(id: UInt): Boolean = lockActiveConnection(Connections, id)

    /** What a run in flight may still do with its connection, checked once per search page (`sync/ConnectionRegistry.kt`). */
    suspend fun runnableState(id: UInt): RunnableState = runnableStateOf(database, Connections, id)

    /** Persists the cloud id a run resolved when none is stored yet (never overwrites; `updated_at` stays, so no Test result is staled). */
    suspend fun storeCloudId(id: UInt, resolved: String) {
        suspendTransaction(database) {
            Connections.update({ (Connections.id eq id) and Connections.active() and Connections.cloudId.isNull() }) {
                it[cloudId] = resolved
            }
        }
    }

    private fun targetOf(row: ResultRow): JiraTestTarget {
        // The search probe narrows by the mapped milestone level; a mapping this build cannot read never fails a Test.
        val mapped = (parseStoredMapping(row[Connections.mapping]) as? StoredMapping.Valid)?.mapping
        val id = row[Connections.id].value
        val token = cipher.decryptOrNull(row[Connections.apiToken], log, "API token of Jira", id)
        return JiraTestTarget(
            siteUrl = row[Connections.siteUrl],
            email = row[Connections.email],
            apiToken = token,
            authScheme = JiraAuthScheme.valueOf(row[Connections.authScheme]),
            projectKeys = parseStringArray(row[Connections.projectKeys]),
            expectedUpdatedAt = row[Connections.updatedAt],
            milestoneLevel = mapped?.levels?.milestone?.hierarchyLevel,
        )
    }

    /** Soft delete: frees the name, `affected` 0 = missing/deleted (404). The census rows removed are logged after the commit. */
    suspend fun delete(id: UInt): JiraConnectionDeleteOutcome = deleteInTransaction(id).also {
        if (it.censusDeleted > 0) log.info("Jira connection {} deleted: {} census rows removed", id, it.censusDeleted)
    }

    private suspend fun deleteInTransaction(id: UInt): JiraConnectionDeleteOutcome = suspendTransaction(database) {
        val row = summary().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction JiraConnectionDeleteOutcome(0, "", "", 0)
        val stamp = nowMillis()
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
            // A deleted connection has no use for its credential: the column goes NULL (V21 allows it on a deleted row only), so no secret
            // stays at rest and no envelope is left under a key that a later rotation would have to open (the rotation skips NULLs).
            it[apiToken] = null
        }
        // The connection's runs are operational history of a registry row that no longer shows, so they go with it (a hard delete: the
        // run list has no connection filter that would hide them). A run still in flight ends as a no-op finish (`SyncRunService.finish`
        // touches a row that is gone: false), and its chunk writes re-select ACTIVE bindings, of which there are none after the next step.
        val runsDeleted = runs.deleteForConnectionInTransaction(SyncKind.JIRA, id)
        // The census mirror too (V23); a run's census write re-checks the connection is ACTIVE under a row lock (JiraIssueStore.upsert).
        val censusDeleted = JiraIssueStore.deleteForConnectionInTransaction(id)
        // D2: the connection's bindings go with it, in this transaction - the node index has no connection column, so a binding left
        // active on a deleted connection would block its node for good. The row lock above made a racing bind wait (it locks the
        // connection `FOR SHARE`) and its committed binding is seen here.
        val bindings = JiraBindingService.Bindings
        val unbound = bindings.update({ (bindings.connectionId eq id) and bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
        }
        val host = jiraHostOf(row[Connections.siteUrl])
        JiraConnectionDeleteOutcome(affected, row[Connections.name], host, unbound, runsDeleted, censusDeleted)
    }

    private fun ResultRow.toResponse(status: SyncStatus): JiraConnectionResponse = JiraConnectionResponse(
        id = this[Connections.id].value,
        name = this[Connections.name],
        siteUrl = this[Connections.siteUrl],
        email = this[Connections.email],
        hasApiToken = this[Connections.apiToken]?.isNotEmpty() == true, // the envelope itself is never read past this
        authScheme = JiraAuthScheme.valueOf(this[Connections.authScheme]),
        projectKeys = parseStringArray(this[Connections.projectKeys]),
        enabled = this[Connections.enabled],
        pollIntervalMinutes = this[Connections.pollIntervalMinutes],
        cloudId = this[Connections.cloudId],
        discoveredAt = this[Connections.discoveredAt],
        lastTestedAt = this[Connections.lastTestedAt],
        lastTestOk = this[Connections.lastTestOk],
        mappingSet = this[Connections.mapping] != EMPTY_MAPPING,
        lastRun = status.lastRun,
        status = status,
        createdAt = this[Connections.createdAt],
        updatedAt = this[Connections.updatedAt],
    )
}

package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.EncryptedAtRest
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.jsonb
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.infra.json.stringArrayJson
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunResponse
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

val JiraConnectionServiceKey = AttributeKey<JiraConnectionService>("JiraConnectionService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to JiraConnectionService.Connections.id,
    "name" to JiraConnectionService.Connections.name,
    "createdAt" to JiraConnectionService.Connections.createdAt,
)

/** The ONE sortable whitelist - derived from the column map so the two can never drift. */
val JIRA_CONNECTION_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

private val log = LoggerFactory.getLogger(JiraConnectionService::class.java)

/** What [JiraConnectionService.recordTest] did: whether the result was stored, and the `discovered_at` now on the row. */
data class TestRecording(val recorded: Boolean, val discoveredAt: Long?)

/** [JiraConnectionService.readDiscovery]'s answer for a connection no passing Test connection has discovered yet. */
const val NO_DISCOVERY = ""

/**
 * The Jira connection registry (V21), the `teams/` template with the application's first stored credential: `api_token` holds a
 * [FieldCipher] envelope, written here and NEVER decrypted on a read path (no response, audit line or log ever carries it; the connector
 * that calls Jira with it is [readForTest]'s and [readForPeek]'s). The service owns the encrypted column, so it registers with the
 * boot backfill ([EncryptedAtRest], `infra/db/Bootstrap.kt`).
 */
class JiraConnectionService(
    private val database: R2dbcDatabase,
    private val cipher: FieldCipher,
    /** Read-only: the connection's newest run rides every response. `sync/` knows nothing of `jira/`; this is the allowed direction. */
    private val runs: SyncRunService,
) : EncryptedAtRest {
    object Connections : UIntIdTable("jira_connections"), SoftDeletable {
        // Case-folded name uniqueness rides the partial unique index uq_jira_connections_name_active (V21, active rows only).
        val name = varchar("name", length = MAX_JIRA_CONNECTION_NAME_LENGTH)
        val siteUrl = varchar("site_url", length = MAX_SITE_URL_LENGTH)
        val email = varchar("email", length = MAX_JIRA_EMAIL_LENGTH)

        /** A `FieldCipher` envelope (`enc:v1:...`); write-only end to end. */
        val apiToken = text("api_token")
        val authScheme = varchar("auth_scheme", length = 10)
        val projectKeys = jsonb("project_keys")
        val cloudId = varchar("cloud_id", length = 36).nullable()
        val mapping = jsonb("mapping")

        /** The last field/issue-type snapshot (canonical JSON, up to ~300 KB): read only by [JiraConnectionService.readDiscovery]. */
        val discovery = jsonb("discovery").nullable()
        val discoveredAt = long("discovered_at").nullable()

        /** The instant a mapping PUT last CHANGED the canonical document (null = never): a run after it must read in full. */
        val mappingChangedAt = long("mapping_changed_at").nullable()
        val lastTestedAt = long("last_tested_at").nullable()
        val lastTestOk = bool("last_test_ok").nullable()
        val enabled = bool("enabled")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
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
        // One indexed LIMIT 1 per listed connection (a page holds at most 100), inside this transaction.
        val latest = runs.latestRunsInTransaction(SyncKind.JIRA, rows.map { it[Connections.id].value })
        JiraConnectionListResult(rows.map { it.toResponse(latest[it[Connections.id].value]) }, total)
    }

    /** The connection, or null when missing/deleted. */
    suspend fun read(id: UInt): JiraConnectionResponse? = suspendTransaction(database) {
        summary().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()
            ?.toResponse(runs.latestRunsInTransaction(SyncKind.JIRA, listOf(id))[id])
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
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Connections.id].value
    }

    /**
     * Full replace of everything but the site and the token's presence: an omitted/blank token keeps the stored one, a present one
     * rotates it. The site is the connection's identity (its cloud id, discovery, mapping and later its bindings all describe THAT site),
     * so a different `siteUrl` is a 409 - create a new connection instead. `affected` 0 -> 404.
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
     * The bind's reader of its connection (the third reader of the stored token, with [readForTest] and [readForPeek]; the run is a
     * fourth caller of THIS reader, not a new decrypt site): the
     * target (token decrypted in memory, null when it cannot be), the mapping state and whether the connection is enabled, in ONE short
     * transaction before the Jira call. Null when the connection is missing or deleted.
     */
    suspend fun readForBind(id: UInt): JiraBindContext? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()
            ?.let { JiraBindContext(targetOf(it), it.toMappingState(), it[Connections.enabled], it[Connections.mappingChangedAt]) }
    }

    /** Whether the connection is active and enabled: what a run needs before it claims (no token is read). */
    suspend fun isRunnable(id: UInt): Boolean = suspendTransaction(database) {
        Connections.select(Connections.id).where { (Connections.id eq id) and Connections.active() and (Connections.enabled eq true) }
            .toList().isNotEmpty()
    }

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
        val token = try {
            cipher.decrypt(row[Connections.apiToken])
        } catch (cause: GeneralSecurityException) {
            logUnreadableToken(id, cause)
        } catch (cause: IllegalArgumentException) {
            logUnreadableToken(id, cause)
        }
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

    private fun logUnreadableToken(id: UInt, cause: Exception): String? {
        // The exception CLASS only: a decrypt failure's message can name the cipher's internals, never the value, but the rule is the same
        // as for the other secret paths (`security.md` "Log hygiene").
        log.warn("The stored API token of Jira connection {} cannot be decrypted ({})", id, cause.javaClass.simpleName)
        return null
    }

    /**
     * Records a stored-token Test connection: `last_tested_at`/`last_test_ok` always (the real verdict), `cloud_id` when the test resolved
     * one, and - when [discovery] is given (both `field` and `issuetype` answered, whatever the other probes said) - the snapshot and
     * `discovered_at`. Skipped (`recorded` false) if the row vanished or was edited since [JiraTestTarget.expectedUpdatedAt] was read (a
     * rotated token, say: the result judged the old one). Does not bump `updated_at`. [TestRecording.discoveredAt] is the instant of the
     * snapshot now stored (this one, or the earlier one a test without a snapshot leaves in place).
     */
    suspend fun recordTest(
        id: UInt,
        expectedUpdatedAt: Long,
        cloudId: String?,
        ok: Boolean,
        discovery: JiraDiscovery?,
        at: Long,
    ): TestRecording =
        suspendTransaction(database) {
            val row = summary().where { (Connections.id eq id) and Connections.active() }
                .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            if (row == null || row[Connections.updatedAt] != expectedUpdatedAt) return@suspendTransaction TestRecording(false, null)
            Connections.update({ (Connections.id eq id) and Connections.active() }) {
                it[lastTestedAt] = at
                it[lastTestOk] = ok
                cloudId?.let { resolved -> it[Connections.cloudId] = resolved }
                if (discovery != null) {
                    it[Connections.discovery] = discovery.toStoredJson()
                    it[discoveredAt] = discovery.discoveredAt
                }
            }
            TestRecording(true, discovery?.discoveredAt ?: row[Connections.discoveredAt])
        }

    /** The stored snapshot: null when the connection is missing, [NO_DISCOVERY] when no passing test stored one yet. */
    suspend fun readDiscovery(id: UInt): String? = suspendTransaction(database) {
        val row = Connections.select(Connections.discovery).where { (Connections.id eq id) and Connections.active() }
            .toList().singleOrNull() ?: return@suspendTransaction null
        row[Connections.discovery] ?: NO_DISCOVERY
    }

    /** Soft delete: the connection stops reading as active and frees its name. `affected` 0 = missing or already deleted (404). */
    suspend fun delete(id: UInt): JiraConnectionDeleteOutcome = suspendTransaction(database) {
        val row = summary().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction JiraConnectionDeleteOutcome(0, "", "", 0)
        val stamp = nowMillis()
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
        }
        // D2: the connection's bindings go with it, in this transaction - the node index has no connection column, so a binding left
        // active on a deleted connection would block its node for good. The row lock above made a racing bind wait (it locks the
        // connection `FOR SHARE`) and its committed binding is seen here.
        val bindings = JiraBindingService.Bindings
        val unbound = bindings.update({ (bindings.connectionId eq id) and bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
        }
        JiraConnectionDeleteOutcome(affected, row[Connections.name], jiraHostOf(row[Connections.siteUrl]), unbound)
    }

    /** The stored mapping document and the discovery snapshot; null when the connection is missing or deleted. */
    suspend fun readMapping(id: UInt): JiraMappingState? = suspendTransaction(database) {
        Connections.select(Connections.mapping, Connections.discovery).where { (Connections.id eq id) and Connections.active() }
            .toList().singleOrNull()?.toMappingState()
    }

    /**
     * Stores the mapping canonical. Under the row lock (`FOR NO KEY UPDATE`, serialized with a Test connection that replaces the snapshot)
     * the rules are checked AGAINST THE SNAPSHOT JUST READ: a connection no test has discovered yet is a 409
     * (`urn:astrolabe:problem:jira-not-discovered`), a violation a 400. Nothing else is rewritten (bindings and observations keep what
     * they hold; the next run re-reads the mapped fields). Null when the connection is missing or deleted (404).
     */
    suspend fun writeMapping(id: UInt, document: JiraMapping): JiraMappingWriteOutcome? = suspendTransaction(database) {
        validateMappingShape(document)
        val row = Connections.select(Connections.mapping, Connections.discovery).where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction null
        val discovery = row[Connections.discovery]?.let(::parseStoredDiscoveryOrNull)
            ?: throw ConflictException("Test the connection first - no discovery has been stored yet", JIRA_NOT_DISCOVERED_PROBLEM)
        validateMapping(document, discovery)
        val stored = canonicalJson(row[Connections.mapping])
        val canonical = document.toStoredJson()
        val changed = stored != canonical
        Connections.update({ (Connections.id eq id) and Connections.active() }) {
            // No `updated_at`: a mapping is not an input of a Test connection, so a PUT landing mid-test must not make recordTest drop it.
            it[mapping] = canonical
            // Only a document that really changed: an identical PUT must not make the next run a full read.
            if (changed) it[mappingChangedAt] = nowMillis()
        }
        JiraMappingWriteOutcome(sha256Hex(stored).takeIf { stored != EMPTY_MAPPING }, sha256Hex(canonical))
    }

    private fun ResultRow.toMappingState() =
        JiraMappingState(parseStoredMapping(this[Connections.mapping]), this[Connections.discovery]?.let(::parseStoredDiscoveryOrNull))

    private fun ResultRow.toResponse(lastRun: SyncRunResponse?): JiraConnectionResponse = JiraConnectionResponse(
        id = this[Connections.id].value,
        name = this[Connections.name],
        siteUrl = this[Connections.siteUrl],
        email = this[Connections.email],
        hasApiToken = this[Connections.apiToken].isNotEmpty(), // the envelope itself is never read past this
        authScheme = JiraAuthScheme.valueOf(this[Connections.authScheme]),
        projectKeys = parseStringArray(this[Connections.projectKeys]),
        enabled = this[Connections.enabled],
        cloudId = this[Connections.cloudId],
        discoveredAt = this[Connections.discoveredAt],
        lastTestedAt = this[Connections.lastTestedAt],
        lastTestOk = this[Connections.lastTestOk],
        mappingSet = this[Connections.mapping] != EMPTY_MAPPING,
        lastRun = lastRun?.toLastRun(running = lastRun.running),
        createdAt = this[Connections.createdAt],
        updatedAt = this[Connections.updatedAt],
    )
}

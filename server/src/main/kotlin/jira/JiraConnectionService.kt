package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.EncryptedAtRest
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.jsonb
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.infra.json.stringArrayJson
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraConnectionServiceKey = AttributeKey<JiraConnectionService>("JiraConnectionService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to JiraConnectionService.Connections.id,
    "name" to JiraConnectionService.Connections.name,
    "createdAt" to JiraConnectionService.Connections.createdAt,
)

/** The ONE sortable whitelist - derived from the column map so the two can never drift. */
val JIRA_CONNECTION_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

/** The stored mapping document of a connection nobody mapped yet (`jira_connections.mapping` default). */
private const val EMPTY_MAPPING = "{}"

/**
 * The Jira connection registry (V21), the `teams/` template with the application's first stored credential: `api_token` holds a
 * [FieldCipher] envelope, written here and NEVER decrypted on a read path (no response, audit line or log ever carries it; the connector
 * that calls Jira with it is a later step's one reader). The service owns the encrypted column, so it registers with the boot
 * backfill ([EncryptedAtRest], `infra/db/Bootstrap.kt`).
 */
class JiraConnectionService(
    private val database: R2dbcDatabase,
    private val cipher: FieldCipher,
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
        val discoveredAt = long("discovered_at").nullable()
        val lastTestedAt = long("last_tested_at").nullable()
        val lastTestOk = bool("last_test_ok").nullable()
        val enabled = bool("enabled")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    override val encryptedRowLabel = "Jira API token"

    /** The boot backfill: wraps legacy plaintext tokens once; with a rotation key, re-wraps EVERY row (soft-deleted included). */
    override suspend fun encryptLegacyRows(reencryptAll: Boolean): Int = suspendTransaction(database) {
        cipher.reencryptRows(Connections, listOf(Connections.apiToken), reencryptAll)
    }

    suspend fun list(paging: PageRequest): JiraConnectionListResult = suspendTransaction(database) {
        val predicate = Connections.active()
        val total = Connections.selectAll().where { predicate }.count()
        val rows = Connections.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        JiraConnectionListResult(rows.map { it.toResponse() }, total)
    }

    /** The connection, or null when missing/deleted. */
    suspend fun read(id: UInt): JiraConnectionResponse? = suspendTransaction(database) {
        Connections.selectAll().where { (Connections.id eq id) and Connections.active() }.toList().singleOrNull()?.toResponse()
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
        val before = Connections.selectAll().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction JiraConnectionUpdateOutcome(0, false, jiraHostOf(request.siteUrl))
        if (before[Connections.siteUrl] != request.siteUrl) {
            throw ConflictException("The site of a Jira connection cannot be changed - create a new connection")
        }
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[name] = request.name
            it[email] = request.email
            request.apiToken?.let { token -> it[apiToken] = cipher.encrypt(token) }
            it[authScheme] = request.authScheme.name
            it[projectKeys] = stringArrayJson(request.projectKeys)
            it[enabled] = request.enabled
            it[updatedAt] = nowMillis()
        }
        JiraConnectionUpdateOutcome(affected, tokenRotated = request.apiToken != null, host = jiraHostOf(request.siteUrl))
    }

    /** Soft delete: the connection stops reading as active and frees its name. `affected` 0 = missing or already deleted (404). */
    suspend fun delete(id: UInt): JiraConnectionDeleteOutcome = suspendTransaction(database) {
        val row = Connections.selectAll().where { (Connections.id eq id) and Connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction JiraConnectionDeleteOutcome(0, "", "")
        val affected = Connections.update({ (Connections.id eq id) and Connections.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        JiraConnectionDeleteOutcome(affected, row[Connections.name], jiraHostOf(row[Connections.siteUrl]))
    }

    private fun ResultRow.toResponse(): JiraConnectionResponse = JiraConnectionResponse(
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
        createdAt = this[Connections.createdAt],
        updatedAt = this[Connections.updatedAt],
    )
}

package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.infra.json.sha256Hex
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraMappingStoreKey = AttributeKey<JiraMappingStore>("JiraMappingStore")

/**
 * The stored mapping document of a Jira connection (`jira_connections.mapping`, with the discovery snapshot it is checked against). Split
 * out of [JiraConnectionService] (the registry, the only code that touches `api_token`): this class selects only `mapping` and
 * `discovery`, never the token.
 */
class JiraMappingStore(private val database: R2dbcDatabase) {
    private val connections = JiraConnectionService.Connections

    /** The stored mapping document and the discovery snapshot; null when the connection is missing or deleted. */
    suspend fun readMapping(id: UInt): JiraMappingState? = suspendTransaction(database) {
        connections.select(connections.mapping, connections.discovery).where { (connections.id eq id) and connections.active() }
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
        val row = connections.select(connections.mapping, connections.discovery)
            .where { (connections.id eq id) and connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction null
        val discovery = row[connections.discovery]?.let(::parseStoredDiscoveryOrNull)
            ?: throw ConflictException("Test the connection first - no discovery has been stored yet", JIRA_NOT_DISCOVERED_PROBLEM)
        validateMapping(document, discovery)
        val stored = canonicalJson(row[connections.mapping])
        val canonical = document.toStoredJson()
        val changed = stored != canonical
        connections.update({ (connections.id eq id) and connections.active() }) {
            // No `updated_at`: a mapping is not an input of a Test connection, so a PUT landing mid-test must not make recordTest drop it.
            it[mapping] = canonical
            // Only a document that really changed: an identical PUT must not make the next run a full read.
            if (changed) it[mappingChangedAt] = nowMillis()
        }
        JiraMappingWriteOutcome(sha256Hex(stored).takeIf { stored != EMPTY_MAPPING }, sha256Hex(canonical))
    }
}

/** The mapping document and snapshot of a row that selected `mapping` and `discovery` (the service's decrypting readers share it). */
internal fun ResultRow.toMappingState() = JiraMappingState(
    parseStoredMapping(this[JiraConnectionService.Connections.mapping]),
    this[JiraConnectionService.Connections.discovery]?.let(::parseStoredDiscoveryOrNull),
)

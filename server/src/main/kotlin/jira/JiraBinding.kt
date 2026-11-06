package ch.nokillswit.jira

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * `409` problem type: the node already carries a binding, or the issue is already bound (to another node, or through another connection
 * of the site).
 */
const val ALREADY_BOUND_PROBLEM = "urn:astrolabe:problem:already-bound"

/** `409` problem type: the connection's stored mapping no longer fits the site's current discovery - an administrator must fix it. */
const val JIRA_MAPPING_INVALID_PROBLEM = "urn:astrolabe:problem:jira-mapping-invalid"

/**
 * `POST /integrations/jira/bindings`: link plan node [nodeId] of [level] (`PROGRAM`, `PROJECT`, `MILESTONE`) to the Jira issue [issueKey]
 * (`ABC-12`) of connection [connectionId]. The node is in the body, so it is decoded before the guard can read the node's chain; an
 * undecodable body is a `400` (no node was addressed), everything that needs the chain or the connection comes after the guard.
 */
@Serializable
data class JiraBindRequest(val connectionId: UInt, val level: JiraLevel, val nodeId: UInt, val issueKey: String)

/** The issue key, trimmed and shape-checked (a `400` on the body field); the one rule the route and the service share. */
fun validateBindRequest(request: JiraBindRequest): JiraBindRequest {
    val key = request.issueKey.trim()
    if (!ISSUE_KEY_PATTERN.matches(key)) throw BadRequestException("issueKey must be a Jira issue key such as ABC-12")
    return request.copy(issueKey = key)
}

/** The bound plan node and where it sits: the names of its ancestors (those above the node's own level are null). */
@Serializable
data class JiraBindingNode(
    val kind: JiraLevel,
    val id: UInt,
    val name: String,
    val projectName: String? = null,
    val programName: String? = null,
    val workStreamName: String? = null,
)

/** The login that made a binding: its ACTIVE person's name, else the login's display name - never its email. */
@Serializable
data class JiraBindingCreator(val userId: UInt, val name: String)

/** The latest observed state of the bound issue (`jira_observations`); dates are ISO `YYYY-MM-DD`, [estimate] is in [estimateUnit]. */
@Serializable
data class JiraObservationResponse(
    val observedAt: Long,
    val issueKey: String?,
    val summary: String?,
    val typeId: String?,
    val typeName: String?,
    val hierarchyLevel: Int?,
    val statusName: String?,
    val statusCategory: JiraStatusCategory,
    val parentIssueId: String?,
    val parentIssueKey: String?,
    val startDate: String?,
    val endDate: String?,
    val estimate: Double?,
    val estimateUnit: JiraEstimateUnit?,
    val teamName: String?,
    val jiraUpdatedAt: Long?,
    val gone: Boolean,
    val goneReason: String?,
)

/** A binding: [url] is `<site>/browse/<key>`; [observation] is null only for a row no run or bind has observed (none exists today). */
@Serializable
data class JiraBindingResponse(
    val id: UInt,
    val connectionId: UInt,
    val level: JiraLevel,
    val node: JiraBindingNode,
    val issueId: String,
    val issueKey: String,
    val url: String,
    val observation: JiraObservationResponse?,
    val createdAt: Long,
    val createdBy: JiraBindingCreator?,
)

/** The list's optional filters: the connection, the level and a case- and accent-insensitive substring of the NODE's name. */
data class JiraBindingFilter(val connectionId: UInt?, val level: JiraLevel?, val q: String?)

data class JiraBindingListResult(val items: List<JiraBindingResponse>, val total: Long)

/** A binding the bind released because its node (or an ancestor) was deleted: the route audits `jira.binding_released` after the commit. */
data class ReleasedBinding(val bindingId: UInt, val connectionId: UInt, val level: JiraLevel, val nodeId: UInt, val issueKey: String)

/** What a bind committed: the new binding and every dead-node binding it released on the way. */
data class JiraBindOutcome(val binding: JiraBindingResponse, val released: List<ReleasedBinding>)

/** What an unbind soft-deleted, for the `jira.binding_deleted` audit. */
data class JiraUnbindOutcome(val connectionId: UInt, val level: JiraLevel, val nodeId: UInt, val issueId: String, val issueKey: String)

/** What a bind needs of its connection, read in ONE short transaction before the Jira call (token decrypted in memory only). */
class JiraBindContext(val target: JiraTestTarget, val state: JiraMappingState, val enabled: Boolean)

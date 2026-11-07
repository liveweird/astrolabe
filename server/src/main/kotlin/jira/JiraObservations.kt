package ch.nokillswit.jira

import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.localDate
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.r2dbc.insert

/**
 * `jira_observations` (V21): the LATEST observed state of a binding, one row per binding, overwritten by every observation (history is
 * not kept, the documented hard-delete exception). Written by the bind (the first row) and, from the run step on, by the observer;
 * [JiraObservation] is the already-fitted value, so no write can fail on a column width or a numeric range.
 */
object JiraObservations : Table("jira_observations") {
    val bindingId = reference("binding_id", JiraBindingService.Bindings)
    val observedAt = long("observed_at")
    val issueKey = varchar("issue_key", length = 50).nullable()
    val summary = varchar("summary", length = 255).nullable()
    val typeId = varchar("type_id", length = 20).nullable()
    val typeName = varchar("type_name", length = 100).nullable()
    val hierarchyLevel = integer("hierarchy_level").nullable()
    val statusName = varchar("status_name", length = 100).nullable()
    val statusCategory = varchar("status_category", length = 16).nullable()
    val parentIssueId = varchar("parent_issue_id", length = 20).nullable()
    val parentIssueKey = varchar("parent_issue_key", length = 50).nullable()
    val startDate = localDate("start_date").nullable()
    val endDate = localDate("end_date").nullable()
    val estimate = decimal("estimate", 12, 2).nullable()
    val estimateUnit = varchar("estimate_unit", length = 8).nullable()
    val teamName = varchar("team_name", length = 100).nullable()
    val jiraUpdatedAt = long("jira_updated_at").nullable()
    val gone = bool("gone").default(false)
    val goneReason = varchar("gone_reason", length = 20).nullable()
    override val primaryKey = PrimaryKey(bindingId)
}

/** Inserts the FIRST observation of a new binding in the caller's transaction (a later one overwrites: the observer's upsert). */
internal suspend fun insertFirstObservation(bindingId: UInt, observation: JiraObservation) {
    JiraObservations.insert {
        it[JiraObservations.bindingId] = bindingId
        it[observedAt] = observation.observedAt
        it[issueKey] = observation.issueKey
        it[summary] = observation.summary
        it[typeId] = observation.typeId
        it[typeName] = observation.typeName
        it[hierarchyLevel] = observation.hierarchyLevel
        it[statusName] = observation.statusName
        it[statusCategory] = observation.statusCategory.name
        it[parentIssueId] = observation.parentIssueId
        it[parentIssueKey] = observation.parentIssueKey
        it[startDate] = observation.startDate
        it[endDate] = observation.endDate
        it[estimate] = observation.estimate
        it[estimateUnit] = observation.estimateUnit?.name
        it[teamName] = observation.teamName
        it[jiraUpdatedAt] = observation.jiraUpdatedAt
        it[gone] = observation.gone
        it[goneReason] = observation.goneReason
    }
}

/**
 * [insertFirstObservation] for many new bindings at once (the Jira import's rows, `(binding id, observation)`): the same columns through
 * [insertRows], so a batch is a few statements instead of one per binding. An empty list writes nothing.
 */
internal suspend fun insertFirstObservations(rows: List<Pair<UInt, JiraObservation>>) {
    JiraObservations.insertRows(rows) { (bindingId, observation) ->
        this[JiraObservations.bindingId] = bindingId
        this[JiraObservations.observedAt] = observation.observedAt
        this[JiraObservations.issueKey] = observation.issueKey
        this[JiraObservations.summary] = observation.summary
        this[JiraObservations.typeId] = observation.typeId
        this[JiraObservations.typeName] = observation.typeName
        this[JiraObservations.hierarchyLevel] = observation.hierarchyLevel
        this[JiraObservations.statusName] = observation.statusName
        this[JiraObservations.statusCategory] = observation.statusCategory.name
        this[JiraObservations.parentIssueId] = observation.parentIssueId
        this[JiraObservations.parentIssueKey] = observation.parentIssueKey
        this[JiraObservations.startDate] = observation.startDate
        this[JiraObservations.endDate] = observation.endDate
        this[JiraObservations.estimate] = observation.estimate
        this[JiraObservations.estimateUnit] = observation.estimateUnit?.name
        this[JiraObservations.teamName] = observation.teamName
        this[JiraObservations.jiraUpdatedAt] = observation.jiraUpdatedAt
        this[JiraObservations.gone] = observation.gone
        this[JiraObservations.goneReason] = observation.goneReason
    }
}

internal fun ResultRow.toObservationResponse() = JiraObservationResponse(
    observedAt = this[JiraObservations.observedAt],
    issueKey = this[JiraObservations.issueKey],
    summary = this[JiraObservations.summary],
    typeId = this[JiraObservations.typeId],
    typeName = this[JiraObservations.typeName],
    hierarchyLevel = this[JiraObservations.hierarchyLevel],
    statusName = this[JiraObservations.statusName],
    statusCategory = this[JiraObservations.statusCategory]?.let { runCatching { JiraStatusCategory.valueOf(it) }.getOrNull() }
        ?: JiraStatusCategory.UNKNOWN,
    parentIssueId = this[JiraObservations.parentIssueId],
    parentIssueKey = this[JiraObservations.parentIssueKey],
    startDate = this[JiraObservations.startDate]?.toString(),
    endDate = this[JiraObservations.endDate]?.toString(),
    estimate = this[JiraObservations.estimate]?.toDouble(),
    estimateUnit = this[JiraObservations.estimateUnit]?.let { runCatching { JiraEstimateUnit.valueOf(it) }.getOrNull() },
    teamName = this[JiraObservations.teamName],
    jiraUpdatedAt = this[JiraObservations.jiraUpdatedAt],
    gone = this[JiraObservations.gone],
    goneReason = this[JiraObservations.goneReason],
)

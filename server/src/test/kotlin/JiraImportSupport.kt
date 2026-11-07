package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.DiscoveryMarkers
import ch.nokillswit.jira.ImportBrowse
import ch.nokillswit.jira.ImportBrowsedIssue
import ch.nokillswit.jira.ImportHolder
import ch.nokillswit.jira.ImportInput
import ch.nokillswit.jira.ImportPlan
import ch.nokillswit.jira.ImportPlanNode
import ch.nokillswit.jira.ImportRow
import ch.nokillswit.jira.ImportSnapshot
import ch.nokillswit.jira.ImportTeam
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportKernels
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraObservation
import ch.nokillswit.jira.JiraStatusCategory
import io.ktor.client.engine.mock.respond
import java.math.BigDecimal
import java.time.LocalDate

// Fixtures for the Jira import kernel's vectors. The site: Epic is Jira level 1 (a milestone), Initiative 2 (a project), Program 3 (a
// program), Story 0 (mapped to nothing). Jira issue ids are small numbers as text; "P" ids are programs, "I" projects, "E" milestones.

const val JIRA_PROGRAM = 3
const val JIRA_PROJECT = 2
const val JIRA_EPIC = 1
const val JIRA_STORY = 0

/** 2027-02-01 is a MONDAY: working week Mon 02-01 .. Fri 02-05, weekend 02-06/07, next Monday 02-08. */
const val MONDAY = "2027-02-01"

val IMPORT_DISCOVERY = JiraDiscovery(
    discoveredAt = 1, fieldCount = 0, issueTypeCount = 4, fieldsTruncated = false, fields = emptyList(),
    issueTypes = listOf(
        DiscoveredIssueType("10001", "Story", JIRA_STORY, false),
        DiscoveredIssueType("10004", "Epic", JIRA_EPIC, false),
        DiscoveredIssueType("10005", "Initiative", JIRA_PROJECT, false),
        DiscoveredIssueType("10006", "Program", JIRA_PROGRAM, false),
    ),
    levels = emptyList(), markers = DiscoveryMarkers(),
)

fun importMapping(
    unit: JiraEstimateUnit = JiraEstimateUnit.POINTS,
    factor: Double? = 0.5,
    dateFields: Boolean = true,
    program: Boolean = true,
    project: Boolean = true,
): JiraMapping {
    val fields = if (dateFields) JiraLevelFields("customfield_1", "customfield_2", "customfield_3") else JiraLevelFields()
    return JiraMapping(
        JiraMappingLevels(
            program = JiraLevelMapping(JIRA_PROGRAM).takeIf { program },
            project = JiraLevelMapping(JIRA_PROJECT).takeIf { project },
            milestone = JiraLevelMapping(JIRA_EPIC, fields),
        ),
        JiraEstimateMapping(unit, factor),
        teamFieldId = "customfield_9",
    )
}

/** An issue as the browse read it. [parentLevel] / [parentType] are the type object of its `parent` member. */
fun issue(
    id: String,
    level: Int?,
    summary: String? = "Item $id",
    parent: String? = null,
    team: String? = null,
    start: String? = null,
    end: String? = null,
    estimate: String? = null,
    parentLevel: Int? = null,
    parentType: String? = null,
): ImportBrowsedIssue = ImportBrowsedIssue(
    JiraObservation(
        observedAt = 1, issueId = id, issueKey = "IMP-$id", summary = summary, typeId = null, typeName = "Type", hierarchyLevel = level,
        statusName = null, statusCategory = JiraStatusCategory.UNKNOWN, parentIssueId = parent, parentIssueKey = parent?.let { "IMP-$it" },
        startDate = start?.let(LocalDate::parse), endDate = end?.let(LocalDate::parse), estimate = estimate?.let(::BigDecimal),
        estimateUnit = null, teamName = team, jiraUpdatedAt = null,
    ),
    parentTypeId = parentType,
    parentTypeHierarchyLevel = parentLevel,
)

fun node(id: UInt, name: String, parentId: UInt? = null, bound: Boolean = false) = ImportPlanNode(id, parentId, name, bound)

fun holder(
    issueId: String,
    level: JiraLevel,
    nodeId: UInt,
    nodeName: String,
    live: Boolean = true,
    connectionId: UInt = 5u,
    bindingId: UInt = 900u + nodeId,
) = ImportHolder(bindingId, connectionId, issueId, level, nodeId, nodeName, live)

val PLATFORM = ImportTeam(10u, "Platform")

/** One import scenario: the preview is [plan] with no ticks, an apply is [plan] with the client's ticks over the SAME snapshot. */
class ImportCase(
    private val issues: List<ImportBrowsedIssue>,
    private val tree: ImportTree = ImportTree(emptyList(), emptyList(), emptyList()),
    private val holders: List<ImportHolder> = emptyList(),
    private val teams: List<ImportTeam> = listOf(PLATFORM),
    private val defaults: JiraImportDefaults = JiraImportDefaults(teamId = PLATFORM.id),
    private val programNames: Collection<String> = tree.programs.map { it.name },
    private val canSchedule: Set<UInt>? = null,
    private val calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
    private val copyDates: Boolean = true,
    private val mapping: JiraMapping = importMapping(),
    private val browseTruncated: Boolean = false,
) {
    fun plan(ticks: List<JiraImportApplyItem>? = null): ImportPlan = JiraImportKernels.plan(
        ImportInput(
            ImportBrowse(issues, browseTruncated), mapping, IMPORT_DISCOVERY,
            ImportSnapshot(tree, programNames, holders, teams, canSchedule, calendar),
            defaults, copyDates, asOf = 42, ticks = ticks,
        ),
    )

    /** Every CREATE/BIND row of the preview ticked, except [leaveOut], each expecting exactly what the preview showed. */
    fun applyAll(vararg leaveOut: String): ImportPlan = plan(tickable(plan(), *leaveOut))
}

fun tickable(preview: ImportPlan, vararg leaveOut: String): List<JiraImportApplyItem> =
    preview.rows.filter { it.item.reason == null && it.item.jiraId !in leaveOut }.map { tick(it) }

fun tick(row: ImportRow, teamOverride: UInt? = null) = JiraImportApplyItem(
    row.item.jiraId,
    JiraImportExpected(row.item.action, row.item.level, row.item.parentJiraId, row.item.target?.nodeId),
    teamOverride?.let { JiraImportOverrides(it) },
)

fun ImportPlan.row(id: String): ImportRow = rows.single { it.item.jiraId == id }

fun ImportPlan.ids(): List<String> = rows.map { it.item.jiraId }

/**
 * A scripted Jira site: a Ktor `MockEngine` under the real `HttpJiraClient` and transport, answering [pages] in order, one per search
 * request. [onSearch] runs (suspending) with the request's index BEFORE its page is answered: a test flips database rows or stalls there.
 * [searches] is every search request that reached the site. Reads no stub, so it may live outside a `*Test.kt` file.
 */
class ScriptedSite(vararg pages: String, onSearch: suspend (Int) -> Unit = {}) {
    private val next = java.util.concurrent.atomic.AtomicInteger()
    val engine = io.ktor.client.engine.mock.MockEngine { request ->
        val headers = io.ktor.http.headersOf(io.ktor.http.HttpHeaders.ContentType, "application/json")
        if (request.url.encodedPath.endsWith("/_edge/tenant_info")) {
            respond("""{"cloudId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}""", io.ktor.http.HttpStatusCode.OK, headers)
        } else {
            val index = next.getAndIncrement()
            onSearch(index)
            respond(pages[index], io.ktor.http.HttpStatusCode.OK, headers)
        }
    }
    val searches get() = engine.requestHistory.filter { it.url.encodedPath.endsWith("/search/jql") }
    val connector: ch.nokillswit.jira.JiraConnector

    init {
        val http = ch.nokillswit.jira.createJiraHttp(
            io.ktor.client.HttpClient(engine) { expectSuccess = false },
            maxRetries = 0, maxResponseBytes = 8_000_000, maxConcurrentRequests = 2, sleeper = { },
        )
        connector = ch.nokillswit.jira.JiraConnector(
            { site, email, apiToken, scheme -> ch.nokillswit.jira.HttpJiraClient(http, site, null, email, apiToken, scheme) }, 2, 10,
        )
    }
}

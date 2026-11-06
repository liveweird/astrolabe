package ch.nokillswit

import ch.nokillswit.jira.DiscoveredField
import ch.nokillswit.jira.DiscoveredFields
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraMappingDefaults
import ch.nokillswit.jira.buildDiscovery
import ch.nokillswit.jira.hasLevel
import ch.nokillswit.jira.hierarchyLevelOf
import ch.nokillswit.jira.levelAt
import ch.nokillswit.jira.mappedFieldIds
import ch.nokillswit.jira.mappedLevels
import ch.nokillswit.jira.parseFields
import ch.nokillswit.jira.parseIssueTypes
import ch.nokillswit.jira.typeIdsAtLevel
import ch.nokillswit.jira.validateMapping
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The pure default-mapping rules (`jira/JiraMappingDefaults.kt`) and level helpers (`JiraLevels.kt`) over the discovery markers. */
class JiraMappingDefaultsTest {
    private fun field(id: String, name: String, type: String, custom: String? = null) = DiscoveredField(id, name, type, custom)

    private fun type(id: String, name: String, level: Int?, subtask: Boolean = false) = DiscoveredIssueType(id, name, level, subtask)

    private fun discovery(fields: List<DiscoveredField>, types: List<DiscoveredIssueType>): JiraDiscovery =
        buildDiscovery(DiscoveredFields(fields.size, fields), types, 1L)

    private val datePicker = "com.atlassian.jira.plugin.system.customfieldtypes:datepicker"
    private val float = "com.atlassian.jira.plugin.system.customfieldtypes:float"
    private val allLevels = listOf(
        type("1", "Sub-task", -1, subtask = true), type("2", "Story", 0), type("3", "Bug", 0), type("4", "Epic", 1),
        type("5", "Initiative", 2), type("6", "Program", 3),
    )
    private val plans = listOf(
        field("duedate", "Due date", "date"),
        field("customfield_10015", "Start date", "date", datePicker),
        field("customfield_10022", "Target start", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
        field("customfield_10023", "Target end", "date", "com.atlassian.jpo:jpo-custom-field-baseline-end"),
        field("customfield_10026", "Story Points", "number", float),
        field("customfield_10016", "Story point estimate", "number", float),
        field("customfield_10001", "Team", "team", "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team"),
    )

    @Test
    fun `a Plans site defaults to Target start and end, the story points, the Team field and the three levels`() {
        val d = discovery(plans, allLevels)
        val mapping = JiraMappingDefaults.resolve(d)
        val milestone = mapping.levels.milestone
        assertEquals(1, milestone.hierarchyLevel)
        assertEquals(
            Triple("customfield_10022", "customfield_10023", "customfield_10026"),
            milestone.fields.let { Triple(it.start, it.end, it.estimate) },
        )
        assertEquals(2, mapping.levels.project?.hierarchyLevel)
        assertEquals(3, mapping.levels.program?.hierarchyLevel)
        for (upper in listOfNotNull(mapping.levels.project, mapping.levels.program)) {
            assertEquals("customfield_10022" to "customfield_10023", upper.fields.start to upper.fields.end)
            assertNull(upper.fields.estimate, "a program or project figure is derived from its milestones")
        }
        assertEquals(JiraEstimateUnit.POINTS, mapping.estimate.unit)
        assertNull(mapping.estimate.manDaysPerUnit, "nothing assumes points convert")
        assertEquals("customfield_10001", mapping.teamFieldId)
        validateMapping(mapping, d) // a default is always savable
    }

    @Test
    fun `story points - the first number field named like it wins, whichever spelling the site lists first`() {
        val classicFirst = JiraMappingDefaults.resolve(discovery(plans, allLevels)).levels.milestone.fields.estimate
        assertEquals("customfield_10026", classicFirst, "Story Points listed before Story point estimate")
        val estimateFirst = plans.filterNot { it.id == "customfield_10026" } + field("customfield_10028", "Story Points", "number", float)
        assertEquals(
            "customfield_10016",
            JiraMappingDefaults.resolve(discovery(estimateFirst, allLevels)).levels.milestone.fields.estimate,
            "Story point estimate listed first",
        )
        val textual = listOf(
            field("customfield_10040", "Story Points", "string"),
            field("customfield_10041", "Story point estimate", "number", float),
        )
        assertEquals(
            "customfield_10041",
            JiraMappingDefaults.resolve(discovery(textual, allLevels)).levels.milestone.fields.estimate,
            "a text field named like story points is not a number field",
        )
    }

    @Test
    fun `without Plans fields the dates fall back to Start date and duedate`() {
        val classic = plans.filter { it.id in setOf("duedate", "customfield_10015", "customfield_10026") }
        val fields = discovery(classic, allLevels).let(JiraMappingDefaults::resolve).levels.milestone.fields
        assertEquals("customfield_10015" to "duedate", fields.start to fields.end)
        val dueOnly = discovery(classic.filter { it.id == "duedate" }, allLevels).let(JiraMappingDefaults::resolve).levels.milestone.fields
        assertEquals(null to "duedate", dueOnly.start to dueOnly.end)
        assertNull(dueOnly.estimate)
        val nothing = discovery(emptyList(), allLevels).let(JiraMappingDefaults::resolve)
        assertEquals(Triple(null, null, null), nothing.levels.milestone.fields.let { Triple(it.start, it.end, it.estimate) })
        assertNull(nothing.teamFieldId)
    }

    @Test
    fun `a Plans date field that is not a date is skipped for the next candidate`() {
        val odd = listOf(
            field("customfield_1", "Start date", "date", datePicker),
            field("customfield_2", "Target start", "datetime", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
            field("duedate", "Due date", "date"),
            field("customfield_3", "Target end", "datetime", "com.atlassian.jpo:jpo-custom-field-baseline-end"),
        )
        val fields = JiraMappingDefaults.resolve(discovery(odd, allLevels)).levels.milestone.fields
        assertEquals("customfield_1" to "duedate", fields.start to fields.end, "a datetime Target field is refused by the validator (A5)")
    }

    @Test
    fun `the levels follow the issue types the site has`() {
        fun levels(vararg types: DiscoveredIssueType) = JiraMappingDefaults.resolve(discovery(plans, types.toList())).levels
        val epicOnly = levels(type("1", "Story", 0), type("2", "Epic", 1))
        assertEquals(Triple(null, null, 1), Triple(epicOnly.program, epicOnly.project, epicOnly.milestone.hierarchyLevel))
        val noEpic = levels(type("1", "Story", 0), type("2", "Task", 0))
        assertEquals(0, noEpic.milestone.hierarchyLevel, "no Epic level: the milestone falls back to the work-item level")
        val skipped = levels(type("1", "Story", 0), type("2", "Epic", 1), type("3", "Program", 3))
        assertEquals(Triple(3, null, 1), Triple(skipped.program?.hierarchyLevel, skipped.project, skipped.milestone.hierarchyLevel))
        val subtasksOnly = levels(type("1", "Sub-task", -1, subtask = true), type("2", "Epic", 2, subtask = true), type("3", "Story", 0))
        assertEquals(Triple(null, null, 0), Triple(subtasksOnly.program, subtasksOnly.project, subtasksOnly.milestone.hierarchyLevel))
    }

    @Test
    fun `the stub's field and issue-type lists resolve exactly as the discovery report documents`() {
        val root = listOf(File("sample-data/jira-stub/__files"), File("../sample-data/jira-stub/__files")).first { it.isDirectory }
        val fields = Json.parseToJsonElement(File(root, "field.json").readText()) as JsonArray
        val types = Json.parseToJsonElement(File(root, "issuetype.json").readText()) as JsonArray
        val d = buildDiscovery(parseFields(fields), parseIssueTypes(types), 1L)
        val mapping = JiraMappingDefaults.resolve(d)
        assertEquals(
            Triple("customfield_10022", "customfield_10023", "customfield_10026"),
            mapping.levels.milestone.fields.let { Triple(it.start, it.end, it.estimate) },
        )
        assertEquals(listOf(1, 2, 3), mapping.mappedLevels().map { it.second.hierarchyLevel }.reversed())
        assertEquals("customfield_10001", mapping.teamFieldId)
        assertEquals(
            listOf("customfield_10022", "customfield_10023", "customfield_10026", "customfield_10001"),
            mapping.mappedFieldIds(),
            "each id once, the dates and estimate of the levels, then the Team field",
        )
        validateMapping(mapping, d)
    }

    @Test
    fun `the level helpers read the issue types`() {
        val d = discovery(plans, allLevels + type("7", "Odd", null))
        assertEquals(listOf("4"), d.typeIdsAtLevel(1))
        assertEquals(listOf("2", "3"), d.typeIdsAtLevel(0))
        assertTrue(d.typeIdsAtLevel(-1).isEmpty(), "sub-tasks are never a mapped level")
        assertTrue(d.hasLevel(2) && !d.hasLevel(-1) && !d.hasLevel(9))
        assertEquals(1, d.hierarchyLevelOf("4", 1))
        assertEquals(1, d.hierarchyLevelOf("4", null), "the discovery answers when the issue did not carry its level")
        assertEquals(2, d.hierarchyLevelOf("4", 2), "the issue's own level is authoritative")
        assertNull(d.hierarchyLevelOf("7", null))
        assertNull(d.hierarchyLevelOf(null, null))
        val mapping = JiraMappingDefaults.resolve(d)
        assertEquals(JiraLevel.PROJECT, mapping.levelAt(2))
        assertNull(mapping.levelAt(0))
        assertNull(mapping.levelAt(null))
    }
}

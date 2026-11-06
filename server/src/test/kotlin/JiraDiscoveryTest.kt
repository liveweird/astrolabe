package ch.nokillswit

import ch.nokillswit.jira.MAX_DISCOVERED_FIELDS
import ch.nokillswit.jira.buildDiscovery
import ch.nokillswit.jira.parseFields
import ch.nokillswit.jira.parseIssueTypes
import ch.nokillswit.jira.parseStoredDiscovery
import ch.nokillswit.jira.toStoredJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The pure discovery snapshot builder (`jira/JiraDiscovery.kt`): the field-kept rule, the marker rules (A1, A2) and the levels. */
class JiraDiscoveryTest {
    private fun array(text: String): JsonArray = Json.parseToJsonElement(text) as JsonArray

    private fun field(id: String, name: String, type: String? = null, custom: String? = null): String {
        val schema = if (type == null && custom == null) "" else """,
            "schema":{"type":${type?.let { "\"$it\"" }},"custom":${custom?.let { "\"$it\"" }}}""".replace("\n", "")
        return """{"id":"$id","name":"$name"$schema}"""
    }

    private fun discover(fields: JsonArray, types: JsonArray, at: Long = 7L) =
        buildDiscovery(parseFields(fields), parseIssueTypes(types), at)

    private val sampleFields = array(
        listOf(
            field("summary", "Summary", "string"),
            field("duedate", "Due date", "date"),
            field("created", "Created", "datetime"),
            field("customfield_10015", "Start date", "date", "com.atlassian.jira.plugin.system.customfieldtypes:datepicker"),
            field("customfield_10022", "  Target START ", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
            field("customfield_10023", "Target end", "date", "com.atlassian.jpo:jpo-custom-field-baseline-end"),
            field("customfield_10026", "Story Points", "number", "com.atlassian.jira.plugin.system.customfieldtypes:float"),
            field("customfield_10016", "Story point estimate", "number", "x:float"),
            field("customfield_10001", "Team", "team", "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team"),
            field("customfield_10014", "Epic Link", "any", "com.pyxis.greenhopper.jira:gh-epic-link"),
            field("customfield_10018", "Parent Link", "any", "com.atlassian.jpo:jpo-custom-field-parent"),
            field("customfield_10040", "Sprint", "array", "com.pyxis.greenhopper.jira:gh-sprint"),
            field("customfield_10041", "Notes", "string", "x:textfield"),
        ).joinToString(prefix = "[", postfix = "]"),
    )

    private val sampleTypes = array(
        """[
        {"id":"10000","name":"Sub-task","subtask":true,"hierarchyLevel":-1},
        {"id":"10001","name":"Story","subtask":false,"hierarchyLevel":0},
        {"id":"10002","name":"Task","subtask":false,"hierarchyLevel":0},
        {"id":"10004","name":"Epic","subtask":false,"hierarchyLevel":1},
        {"id":"10005","name":"Initiative","subtask":false,"hierarchyLevel":2},
        {"id":"10009","name":"Odd","subtask":false}
        ]""",
    )

    @Test
    fun `the marker rules resolve the Plans pair, Start date, duedate, story points, the Team field and the legacy links`() {
        val markers = discover(sampleFields, sampleTypes, 7L).markers
        assertEquals("customfield_10022", markers.targetStart?.id, "case-insensitive, trimmed name")
        assertEquals("customfield_10023", markers.targetEnd?.id)
        assertEquals("com.atlassian.jpo:jpo-custom-field-baseline-start", markers.targetStart?.custom)
        assertEquals("customfield_10015", markers.startDate?.id)
        assertEquals("duedate", markers.dueDate?.id)
        assertEquals("customfield_10026", markers.storyPoints?.id, "the FIRST number field named like story points")
        assertEquals("customfield_10001", markers.team?.id)
        assertEquals("customfield_10014", markers.legacyEpicLink?.id)
        assertEquals("customfield_10018", markers.legacyParentLink?.id)
    }

    @Test
    fun `a site without Plans fields reports each marker as not found`() {
        val plain = array("[" + listOf(field("duedate", "Due date", "date"), field("summary", "Summary", "string")).joinToString() + "]")
        val markers = discover(plain, sampleTypes, 7L).markers
        assertNull(markers.targetStart)
        assertNull(markers.targetEnd)
        assertNull(markers.startDate)
        assertNull(markers.storyPoints)
        assertNull(markers.team)
        assertNull(markers.legacyEpicLink)
        assertNull(markers.legacyParentLink)
        assertEquals("duedate", markers.dueDate?.id)
    }

    @Test
    fun `only dates, numbers and the recognised customs are kept, the marker matches first`() {
        val discovery = discover(sampleFields, sampleTypes, 7L)
        assertEquals(13, discovery.fieldCount)
        assertFalse(discovery.fieldsTruncated)
        val kept = discovery.fields.map { it.id }
        assertTrue(
            "summary" !in kept && "customfield_10041" !in kept && "customfield_10040" !in kept,
            "strings, arrays and unmarked customs are dropped: $kept",
        )
        assertTrue("created" in kept, "a datetime is kept (the report shows it; the mapping validator refuses it, A5)")
        assertEquals("customfield_10022", kept.first(), "the markers come first")
    }

    @Test
    fun `levels group the non-sub-task types by hierarchy level and skip a type with no level`() {
        val discovery = discover(sampleFields, sampleTypes, 7L)
        assertEquals(listOf(0, 1, 2), discovery.levels.map { it.level })
        assertEquals(listOf("Story", "Task"), discovery.levels.first().typeNames)
        assertEquals(6, discovery.issueTypeCount)
        assertEquals(7L, discovery.discoveredAt)
    }

    @Test
    fun `a malformed entry is skipped, never a failure`() {
        val fields = array(
            """[1, "x", {"id":5,"name":"n"}, {"id":"a"}, {"id":"b","name":"B","schema":"nope"},
               {"id":"duedate","name":"Due","schema":{"type":"date"}}]""",
        )
        val types = array("""[null, {"id":"1"}, {"id":"2","name":"T","hierarchyLevel":"x","subtask":"y"}]""")
        val discovery = discover(fields, types, 0L)
        assertEquals(listOf("duedate"), discovery.fields.map { it.id })
        assertEquals(listOf("2"), discovery.issueTypes.map { it.id })
        assertTrue(discovery.levels.isEmpty())
    }

    @Test
    fun `the field list is capped and the count of what the site reported rides along`() {
        val rows = (1..MAX_DISCOVERED_FIELDS + 50).joinToString(prefix = "[", postfix = "]") {
            field("customfield_$it", "Date $it", "date")
        }
        val many = array(rows)
        val discovery = discover(many, JsonArray(emptyList()), 0L)
        assertEquals(MAX_DISCOVERED_FIELDS, discovery.fields.size)
        assertEquals(MAX_DISCOVERED_FIELDS + 50, discovery.fieldCount)
        assertTrue(discovery.fieldsTruncated)
    }

    @Test
    fun `a named date marker needs a date-typed field - a text Start date listed first does not win`() {
        val fields = array(
            "[" + listOf(
                field("customfield_1", "Start date", "string"),
                field("customfield_2", "Start date", "date"),
                field("customfield_3", "Target start", "string"),
                field("customfield_4", "Target end", "datetime"),
            ).joinToString() + "]",
        )
        val markers = discover(fields, sampleTypes).markers
        assertEquals("customfield_2", markers.startDate?.id)
        assertNull(markers.targetStart, "a text field named like the marker is not a date field")
        assertNull(markers.targetEnd, "nor is a datetime one (A5)")
        assertNull(discover(array("[" + field("customfield_1", "Start date", "string") + "]"), sampleTypes).markers.startDate)
    }

    @Test
    fun `Plans target dates fall back to their custom type when no date field carries the name - a localised site`() {
        val fields = array(
            "[" + listOf(
                field("customfield_10", "Początek docelowy", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
                field("customfield_11", "Koniec docelowy", "date", "com.atlassian.jpo:jpo-custom-field-baseline-end"),
            ).joinToString() + "]",
        )
        val markers = discover(fields, sampleTypes).markers
        assertEquals("customfield_10", markers.targetStart?.id)
        assertEquals("customfield_11", markers.targetEnd?.id)
        val both = array(
            "[" + listOf(
                field("customfield_10", "Początek docelowy", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
                field("customfield_12", "Target start", "date", "x:datepicker"),
            ).joinToString() + "]",
        )
        assertEquals("customfield_12", discover(both, sampleTypes).markers.targetStart?.id, "the name match comes first")
    }

    @Test
    fun `site-supplied strings are clamped`() {
        val long = "x".repeat(400)
        val fields = array("[" + field("c".repeat(100), long, "date", "k".repeat(100)) + "]")
        val types = array("""[{"id":"${"1".repeat(100)}","name":"$long","subtask":false,"hierarchyLevel":1}]""")
        val discovery = discover(fields, types)
        with(discovery.fields.single()) { assertEquals(listOf(64, 255, 64), listOf(id.length, name.length, custom?.length)) }
        with(discovery.issueTypes.single()) { assertEquals(listOf(64, 255), listOf(id.length, name.length)) }
    }

    @Test
    fun `the stored form is canonical JSON that round-trips`() {
        val discovery = discover(sampleFields, sampleTypes, 7L)
        val json = discovery.toStoredJson()
        assertEquals(discovery, parseStoredDiscovery(json))
        assertEquals(json, parseStoredDiscovery(json).toStoredJson(), "canonical: the same bytes again")
    }
}

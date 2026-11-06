package ch.nokillswit

import ch.nokillswit.jira.DiscoveredField
import ch.nokillswit.jira.DiscoveredFields
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraObservation
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.buildDiscovery
import ch.nokillswit.jira.observationFields
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The pure read of an issue document through the mapping (`jira/JiraObservation.kt`), over the shapes a real tenant sends. */
class JiraObservationTest {
    private val discovery: JiraDiscovery = buildDiscovery(
        DiscoveredFields(1, listOf(DiscoveredField("customfield_10022", "Target start", "date", null))),
        listOf(DiscoveredIssueType("10000", "Epic", 1, false), DiscoveredIssueType("10001", "Story", 0, false)),
        1L,
    )

    private val mapping = JiraMapping(
        JiraMappingLevels(
            program = null,
            project = JiraLevelMapping(2, JiraLevelFields("customfield_20001", "customfield_20002", null)),
            milestone = JiraLevelMapping(1, JiraLevelFields("customfield_10022", "customfield_10023", "customfield_10026")),
        ),
        JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.5),
        "customfield_10001",
    )

    private fun issue(fields: String, id: String = "\"90005\"", key: String = "\"E2E-5\"") =
        Json.parseToJsonElement("""{"id":$id,"key":$key,"fields":$fields}""").jsonObject

    private fun observe(issue: JsonObject, level: JiraLevel = JiraLevel.MILESTONE) =
        JiraObservation.of(issue, mapping, discovery, level, 7L)

    private val full = """{"summary":"E2E Epic Two","issuetype":{"id":"10000","name":"Epic","hierarchyLevel":1},
        "status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},"parent":{"id":"90002","key":"E2E-2"},
        "customfield_10022":"2044-02-01","customfield_10023":"2044-02-10","customfield_10026":8,
        "customfield_10001":{"name":"E2E Team"},"updated":"2026-10-26T10:11:12.000+0000"}"""

    @Test
    fun `a full issue reads every column through the fields mapped for the binding's level`() {
        val o = assertNotNull(observe(issue(full)))
        assertEquals(7L, o.observedAt)
        assertEquals("90005" to "E2E-5", o.issueId to o.issueKey)
        assertEquals("E2E Epic Two", o.summary)
        assertEquals("10000" to "Epic", o.typeId to o.typeName)
        assertEquals(1, o.hierarchyLevel)
        assertEquals("In Progress" to JiraStatusCategory.IN_PROGRESS, o.statusName to o.statusCategory)
        assertEquals("90002" to "E2E-2", o.parentIssueId to o.parentIssueKey)
        assertEquals(LocalDate.of(2044, 2, 1) to LocalDate.of(2044, 2, 10), o.startDate to o.endDate)
        assertEquals(BigDecimal("8.00") to JiraEstimateUnit.POINTS, o.estimate to o.estimateUnit)
        assertEquals("E2E Team", o.teamName)
        assertEquals(java.time.Instant.parse("2026-10-26T10:11:12Z").toEpochMilli(), o.jiraUpdatedAt, "the colonless +0000 spelling")
        assertEquals(false, o.gone)
        assertNull(o.goneReason)
    }

    @Test
    fun `the dates come from the BINDING's level, whatever level the issue is at`() {
        val doc = issue(
            """{"summary":"x","issuetype":{"id":"10000","name":"Epic","hierarchyLevel":1},"customfield_10022":"2044-02-01",
            "customfield_20001":"2045-03-03","customfield_20002":"2045-04-04"}""",
        )
        val asProject = assertNotNull(observe(doc, JiraLevel.PROJECT))
        assertEquals(LocalDate.of(2045, 3, 3) to LocalDate.of(2045, 4, 4), asProject.startDate to asProject.endDate)
        assertEquals(1, asProject.hierarchyLevel, "the observed level is the issue's own: a mismatch is a deviation to show")
        assertNull(asProject.estimate, "the project level maps no estimate")
        val asProgram = assertNotNull(observe(doc, JiraLevel.PROGRAM))
        assertEquals(null to null, asProgram.startDate to asProgram.endDate, "an unmapped level reads no dates")
    }

    @Test
    fun `absent and odd members read as null, never a failure`() {
        val odd = """{"customfield_10001":null,"customfield_10022":"2044-02-30","customfield_10023":"2044-02-10T00:00:00.000+0000",
            "customfield_10026":"eight","updated":"yesterday","parent":null,"status":null,"summary":null,"issuetype":null}"""
        val o = assertNotNull(observe(issue(odd)))
        assertNull(o.summary)
        assertNull(o.typeId)
        assertNull(o.hierarchyLevel)
        assertNull(o.statusName)
        assertEquals(JiraStatusCategory.UNKNOWN, o.statusCategory)
        assertNull(o.parentIssueId)
        assertEquals(null to null, o.startDate to o.endDate, "a non-calendar day and a datetime are not dates")
        assertEquals(null to null, o.estimate to o.estimateUnit, "a string is not a figure")
        assertNull(o.teamName, "a null Team")
        assertNull(o.jiraUpdatedAt)
        val minimal = JsonObject(mapOf("id" to Json.parseToJsonElement("\"1\""), "key" to Json.parseToJsonElement("\"E2E-1\"")))
        val bare = assertNotNull(JiraObservation.of(minimal, mapping, discovery, JiraLevel.MILESTONE, 1L))
        assertNull(bare.summary)
    }

    @Test
    fun `an issue with no usable id or key is no observation`() {
        val unusable = listOf(
            "\"abc\"" to "\"E2E-5\"", "5" to "\"E2E-5\"", "\"90005\"" to "\"e2e-5\"", "\"90005\"" to "null",
            "\"123456789012345678901\"" to "\"E2E-5\"",
        )
        for ((id, key) in unusable) {
            assertNull(observe(issue("{}", id, key)), "$id $key")
        }
        assertNull(observe(JsonObject(emptyMap())))
    }

    @Test
    fun `the hierarchy level comes from the issue's own type, else from the discovery's index`() {
        val own = observe(issue("""{"issuetype":{"id":"10001","name":"Story","hierarchyLevel":1}}"""))
        assertEquals(1, own?.hierarchyLevel, "the issue's own is authoritative")
        assertEquals(0, observe(issue("""{"issuetype":{"id":"10001","name":"Story"}}"""))?.hierarchyLevel)
        assertNull(observe(issue("""{"issuetype":{"id":"99","name":"Odd"}}"""))?.hierarchyLevel)
    }

    @Test
    fun `the status category is read from the category object`() {
        val categories = mapOf(
            "new" to JiraStatusCategory.TODO, "indeterminate" to JiraStatusCategory.IN_PROGRESS, "done" to JiraStatusCategory.DONE,
            "odd" to JiraStatusCategory.UNKNOWN,
        )
        for ((key, expected) in categories) {
            assertEquals(expected, observe(issue("""{"status":{"name":"s","statusCategory":{"key":"$key"}}}"""))?.statusCategory, key)
        }
        assertEquals(JiraStatusCategory.UNKNOWN, observe(issue("""{"status":{"name":"s","statusCategory":"done"}}"""))?.statusCategory)
    }

    @Test
    fun `every value is fitted to its column - a long string is cut, a NUL replaced, a figure out of range dropped`() {
        val long = "x".repeat(400)
        val o = assertNotNull(
            observe(
                issue(
                    """{"summary":"$long","issuetype":{"id":"${"9".repeat(40)}","name":"$long","hierarchyLevel":1},
                    "status":{"name":"$long"},"customfield_10001":{"name":"$long"},"customfield_10026":1e10}""",
                ),
            ),
        )
        assertEquals(255, o.summary?.length)
        assertEquals(20, o.typeId?.length)
        assertEquals(100, o.typeName?.length)
        assertEquals(100, o.statusName?.length)
        assertEquals(100, o.teamName?.length)
        assertNull(o.estimate, "1E10 is the first figure NUMERIC(12,2) cannot hold")
        assertEquals(BigDecimal("9999999999.99"), observe(issue("""{"customfield_10026":9999999999.994}"""))?.estimate)
        assertEquals(BigDecimal("0.13"), observe(issue("""{"customfield_10026":0.125}"""))?.estimate, "half up at two decimals")
        assertEquals(BigDecimal("-3.00"), observe(issue("""{"customfield_10026":-3}"""))?.estimate)
        assertNull(observe(issue("""{"customfield_10026":-1e10}"""))?.estimate)
        // A NUL cannot be stored by PostgreSQL; a cut must not split a surrogate pair.
        assertEquals("a�b", observe(issue("""{"summary":"a\u0000b"}"""))?.summary)
        val emoji = "x".repeat(254) + "😀"
        val cut = assertNotNull(observe(issue("""{"summary":"$emoji"}"""))?.summary)
        assertTrue(cut.length <= 255 && !cut.last().isHighSurrogate(), "no lone surrogate")
    }

    @Test
    fun `the request names every field the observation reads`() {
        val fields = observationFields(mapping).split(',')
        assertEquals(listOf("summary", "issuetype", "status", "parent", "updated"), fields.take(5))
        val mapped = listOf(
            "customfield_20001", "customfield_20002", "customfield_10022", "customfield_10023", "customfield_10026", "customfield_10001",
        )
        for (field in mapped) {
            assertTrue(field in fields, field)
        }
        assertEquals(fields.size, fields.distinct().size)
    }

    @Test
    fun `numbers and instants that would throw or burn CPU in the arithmetic read as null`() {
        // Each of these used to be an ArithmeticException (a 500 from a bind) or seconds of CPU building the expansion.
        val hostiles = listOf("1e999999999", "1e-999999999", "1e2147483647", "1e-2147483647", "1e30000000", "1e65", "1E-65", "9".repeat(41))
        for (hostile in hostiles) {
            val started = System.nanoTime()
            assertNull(observe(issue("""{"customfield_10026":$hostile}"""))?.estimate, hostile)
            assertTrue((System.nanoTime() - started) < 1_000_000_000L, "$hostile is refused without arithmetic")
        }
        val ordinary = observe(issue("""{"customfield_10026":1e6}"""))?.estimate
        assertEquals(BigDecimal("1000000.00"), ordinary, "an ordinary exponent still reads")
        assertEquals(BigDecimal("0.00"), observe(issue("""{"customfield_10026":1e-64}"""))?.estimate)
        val instants = listOf("+999999999-12-31T23:59:59.000+0000", "-999999999-01-01T00:00:00.000+0000", "+999999999-12-31T23:59:59.000Z")
        for (instant in instants) {
            val o = assertNotNull(observe(issue("""{"summary":"x","updated":"$instant"}""")), instant)
            assertNull(o.jiraUpdatedAt, instant)
            assertEquals("x", o.summary, "the rest of the issue is still observed")
        }
    }
}

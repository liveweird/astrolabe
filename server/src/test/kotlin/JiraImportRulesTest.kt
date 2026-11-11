package ch.nokillswit

import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportApplyRequest
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportExpectedParent
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportKernels
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.MAX_IMPORT_ITEMS
import ch.nokillswit.jira.MAX_IMPORT_PROJECT_KEYS
import ch.nokillswit.jira.validateApplyItems
import ch.nokillswit.jira.validateImportScope
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.json.Json
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The import's small pure rules: the plan name, the team fold, the estimate conversion, and the request validators. */
class JiraImportRulesTest {
    private fun name(summary: String?) = JiraImportKernels.importName(summary, "IMP-1")

    // ---- importName -------------------------------------------------------------------------------------------------------------

    @Test
    fun `a blank, missing or invisible summary is named by the issue key`() {
        for (summary in listOf(null, "", "   ", " \t\n ", "​​", "\u0000\u0007")) {
            val named = name(summary)
            assertEquals("IMP-1", named.text, "$summary")
            assertFalse(named.truncated)
        }
    }

    @Test
    fun `control characters become spaces, whitespace is collapsed and the name trimmed`() {
        assertEquals("a b c d e", name("a\u0000b\tc\nd\u0007e").text)
        assertEquals("a b", name("  a   b  ").text)
        assertEquals("a b", name("a" + " ".repeat(200) + "b").text)
        assertFalse(name("a" + " ".repeat(200) + "b").truncated, "collapsing is not cutting")
        assertEquals("Plain name", name("Plain name").text)
    }

    @Test
    fun `a name is cut at 100 characters and says so only when it was`() {
        assertEquals(100, name("n".repeat(100)).text.length)
        assertFalse(name("n".repeat(100)).truncated)
        val cut = name("n".repeat(101))
        assertEquals("n".repeat(100), cut.text)
        assertTrue(cut.truncated)
        assertEquals("x".repeat(99), name("x".repeat(99) + " yyy").text, "a cut never leaves a trailing space")
        assertTrue(name("x".repeat(99) + " yyy").truncated)
    }

    @Test
    fun `a cut never splits a surrogate pair`() {
        val emoji = "😀"
        val cut = name("x".repeat(99) + emoji + "tail")
        assertEquals("x".repeat(99), cut.text, "the pair straddles the cut, so it goes whole")
        assertTrue(cut.truncated)
        val fits = name("x".repeat(98) + emoji)
        assertEquals("x".repeat(98) + emoji, fits.text, "a pair that ends exactly at 100 stays")
        assertFalse(fits.truncated)
        assertEquals("x".repeat(98) + emoji, name("x".repeat(98) + emoji + "tail").text)
    }

    // ---- foldName ---------------------------------------------------------------------------------------------------------------

    @Test
    fun `the team fold ignores case, accents and surrounding space, ł included`() {
        assertEquals("zespol platnosci", JiraImportKernels.foldName("Zespół Płatności"))
        assertEquals(JiraImportKernels.foldName("Zespół Płatności"), JiraImportKernels.foldName("  zespol PLATNOSCI "))
        assertEquals("zolw", JiraImportKernels.foldName("Żółw"))
        assertEquals("aei", JiraImportKernels.foldName("  ÀÉÎ  "))
        assertEquals("strasse ore da ae oe", JiraImportKernels.foldName("Straße Øre Đa Æ œ"))
        assertEquals("a b", JiraImportKernels.foldName("A B"))
    }

    // ---- convertEstimate --------------------------------------------------------------------------------------------------------

    private fun convert(figure: String?, unit: JiraEstimateUnit, factor: Double? = null) =
        JiraImportKernels.convertEstimate(figure?.let(::BigDecimal), JiraEstimateMapping(unit, factor))

    @Test
    fun `DAYS convert as they are, a factor multiplies, and no factor converts nothing`() {
        assertEquals("7.00", convert("7", JiraEstimateUnit.DAYS).manDays.toPlainString())
        assertEquals("7.00", convert("7", JiraEstimateUnit.DAYS, 8.0).manDays.toPlainString(), "DAYS ignores a leftover factor")
        assertEquals("2.50", convert("5", JiraEstimateUnit.POINTS, 0.5).manDays.toPlainString())
        assertEquals("1.50", convert("12", JiraEstimateUnit.HOURS, 0.125).manDays.toPlainString())
        assertFalse(convert("5", JiraEstimateUnit.POINTS, 0.5).notConverted)
        for (unit in listOf(JiraEstimateUnit.POINTS, JiraEstimateUnit.HOURS)) {
            val none = convert("5", unit)
            assertEquals("0.00", none.manDays.toPlainString())
            assertTrue(none.notConverted)
        }
    }

    @Test
    fun `no estimate at all is zero and nothing to report`() {
        for (unit in JiraEstimateUnit.entries) {
            val none = convert(null, unit, 2.0)
            assertEquals("0.00", none.manDays.toPlainString())
            assertFalse(none.notConverted)
        }
        assertFalse(convert("0", JiraEstimateUnit.POINTS, 3.0).notConverted)
        assertEquals("0.00", convert("0", JiraEstimateUnit.POINTS, 3.0).manDays.toPlainString())
    }

    @Test
    fun `the result is rounded half up at two decimals`() {
        assertEquals("1.01", convert("1.005", JiraEstimateUnit.DAYS).manDays.toPlainString())
        assertEquals("2.68", convert("2.675", JiraEstimateUnit.DAYS).manDays.toPlainString())
        assertEquals("0.33", convert("1", JiraEstimateUnit.POINTS, 0.333).manDays.toPlainString())
        assertEquals("0.34", convert("1", JiraEstimateUnit.POINTS, 0.335).manDays.toPlainString())
        assertEquals("0.00", convert("0.0049", JiraEstimateUnit.DAYS).manDays.toPlainString())
        assertEquals("0.01", convert("0.005", JiraEstimateUnit.DAYS).manDays.toPlainString())
    }

    @Test
    fun `a result outside the milestone range is zero and not converted`() {
        assertEquals("999999.99", convert("999999.99", JiraEstimateUnit.DAYS).manDays.toPlainString())
        for (figure in listOf("1000000", "999999.995", "-1", "-0.001")) {
            val out = convert(figure, JiraEstimateUnit.DAYS)
            assertEquals("0.00", out.manDays.toPlainString(), figure)
            assertTrue(out.notConverted, figure)
        }
        assertTrue(convert("2000000", JiraEstimateUnit.POINTS, 0.5).notConverted, "the product is what is range-checked")
        assertFalse(convert("2000000", JiraEstimateUnit.POINTS, 0.25).notConverted)
    }

    // ---- validateImportScope ----------------------------------------------------------------------------------------------------

    private val keys = listOf("AAA", "BBB", "CCC")
    private fun scope(projectKeys: List<String>?) = JiraImportScope(1u, 2u, projectKeys)

    @Test
    fun `no project keys means all of the connection's, and a subset is kept in the order sent`() {
        assertEquals(keys, validateImportScope(scope(null), keys))
        assertEquals(listOf("CCC", "AAA"), validateImportScope(scope(listOf("CCC", "AAA")), keys))
    }

    @Test
    fun `project keys must be 1 to 50, distinct and the connection's own`() {
        assertFailsWith<BadRequestException> { validateImportScope(scope(emptyList()), keys) }
        assertFailsWith<BadRequestException> { validateImportScope(scope(listOf("AAA", "AAA")), keys) }
        assertFailsWith<BadRequestException> { validateImportScope(scope(listOf("AAA", "ZZZ")), keys) }
        val many = (1..MAX_IMPORT_PROJECT_KEYS + 1).map { "K$it" }
        assertFailsWith<BadRequestException> { validateImportScope(scope(many), many) }
        assertEquals(50, validateImportScope(scope(many.take(MAX_IMPORT_PROJECT_KEYS)), many).size)
    }

    @Test
    fun `the filter's day count is 1 to 3650 or absent, and anything else is a 400`() {
        fun scoped(filter: JiraImportFilter?) = JiraImportScope(1u, 2u, null, null, true, filter)
        for (days in listOf(0, -1, 3_651, Int.MIN_VALUE, Int.MAX_VALUE)) {
            val refused = assertFailsWith<BadRequestException>("$days") {
                validateImportScope(scoped(JiraImportFilter(excludeDone = true, updatedWithinDays = days)), keys)
            }
            assertEquals("filter.updatedWithinDays must be between 1 and 3650", refused.message)
        }
        val passing = listOf(null, JiraImportFilter(), JiraImportFilter(true, 1), JiraImportFilter(false, 3_650), JiraImportFilter(true))
        for (filter in passing) assertEquals(keys, validateImportScope(scoped(filter), keys), "$filter")
        // The keys' own refusals come first; the day count is the last check.
        val badKeys = JiraImportScope(1u, 2u, listOf("ZZZ"), null, true, JiraImportFilter())
        assertFailsWith<BadRequestException> { validateImportScope(badKeys, keys) }
    }

    // ---- validateApplyItems -----------------------------------------------------------------------------------------------------

    private fun create(id: String, parent: String? = null) =
        JiraImportApplyItem(
            id,
            JiraImportExpected(
                JiraImportAction.CREATE, JiraLevel.MILESTONE, parent, parent = JiraImportExpectedParent(JiraImportParentKind.NEW_ROW),
            ),
        )

    private fun bind(id: String, nodeId: UInt?) =
        JiraImportApplyItem(id, JiraImportExpected(JiraImportAction.BIND, JiraLevel.PROJECT, nodeId = nodeId))

    private fun refused(vararg items: JiraImportApplyItem): String =
        assertFailsWith<BadRequestException> { validateApplyItems(items.toList()) }.message.orEmpty()

    @Test
    fun `well-formed apply items pass, up to the cap`() {
        validateApplyItems(listOf(create("1"), create("2", parent = "1"), bind("3", 7u)))
        validateApplyItems((1..MAX_IMPORT_ITEMS).map { create("$it") })
    }

    @Test
    fun `apply items are refused when empty, over the cap or repeated`() {
        assertTrue(refused().contains("at least one"))
        val tooMany = (1..MAX_IMPORT_ITEMS + 1).map { create("$it") }
        assertTrue(refused(*tooMany.toTypedArray()).contains("at most"))
        assertTrue(refused(create("1"), create("1")).contains("once"))
    }

    @Test
    fun `an apply item must name a numeric Jira id and an expectation that can be written`() {
        assertEquals("items[1]: jiraId must be a numeric Jira issue id", refused(create("1"), create("IMP-2")))
        val skip = JiraImportApplyItem("1", JiraImportExpected(JiraImportAction.SKIP, JiraLevel.MILESTONE))
        assertTrue(refused(skip).contains("CREATE or BIND"))
        assertTrue(refused(bind("1", null)).contains("required for a BIND"))
        val createWithNode = JiraImportApplyItem("1", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.MILESTONE, nodeId = 3u))
        assertTrue(refused(createWithNode).contains("absent for a CREATE"))
        assertTrue(refused(create("1", parent = "IMP-9")).contains("expected.parentJiraId"))
        val orphan = JiraImportApplyItem("1", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.MILESTONE, "2"))
        assertTrue(refused(orphan).contains("expected.parent is required"))
        validateApplyItems(listOf(JiraImportApplyItem("1", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.PROGRAM))))
    }

    @Test
    fun `the apply request carries the scope flat, with the defaults the preview has`() {
        val request = Json.decodeFromString<JiraImportApplyRequest>(
            """{"workStreamId":3,"ownerPersonId":4,"defaults":{"teamId":9},""" +
                """"items":[{"jiraId":"1","expected":{"action":"CREATE","level":"PROGRAM"}}]}""",
        )
        val scope = request.scope()
        assertEquals(3u, scope.workStreamId)
        assertEquals(4u, scope.ownerPersonId)
        assertEquals(9u, scope.defaults!!.teamId)
        assertNull(scope.projectKeys)
        assertTrue(scope.copyDates, "dates are copied unless the caller says not")
        assertNull(scope.filter, "no filter member is no filter")
        assertEquals(JiraLevel.PROGRAM, request.items.single().expected.level)
    }

    @Test
    fun `the apply request carries its filter into the scope`() {
        val request = Json.decodeFromString<JiraImportApplyRequest>(
            """{"workStreamId":3,"ownerPersonId":4,"filter":{"excludeDone":true,"updatedWithinDays":90},""" +
                """"items":[{"jiraId":"1","expected":{"action":"CREATE","level":"PROGRAM"}}]}""",
        )
        assertEquals(JiraImportFilter(excludeDone = true, updatedWithinDays = 90), request.scope().filter)
    }
}

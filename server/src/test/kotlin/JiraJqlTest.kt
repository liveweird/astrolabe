package ch.nokillswit

import ch.nokillswit.jira.JiraJql
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** JQL construction: project keys arrive pre-validated (`PROJECT_KEY_PATTERN`), issue-type ids are digits, so no quoting is ever needed. */
class JiraJqlTest {

    @Test
    fun `scope renders a quoted project-in list`() {
        assertEquals("project in (\"ENG\")", JiraJql.scope(listOf("ENG")))
        assertEquals("project in (\"ENG\",\"OPS\")", JiraJql.scope(listOf("ENG", "OPS")))
    }

    @Test
    fun `scope rejects an empty list or a key outside the validated shape`() {
        assertFailsWith<IllegalArgumentException> { JiraJql.scope(emptyList()) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scope(listOf("lowercase")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scope(listOf("HAS SPACE")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scope(listOf("HAS\"QUOTE")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scope(listOf("1STARTSWITHDIGIT")) }
    }

    @Test
    fun `scopeAndTypes narrows the scope to issue-type ids (assumption A3 - the text the search probe sends)`() {
        assertEquals("project in (\"ENG\") AND issuetype in (10001)", JiraJql.scopeAndTypes(listOf("ENG"), listOf("10001")))
        assertEquals(
            "project in (\"ENG\",\"OPS\") AND issuetype in (10001,10002)",
            JiraJql.scopeAndTypes(listOf("ENG", "OPS"), listOf("10001", "10002")),
        )
    }

    @Test
    fun `scopeAndTypes rejects no ids, a non-numeric id and an invalid key`() {
        assertFailsWith<IllegalArgumentException> { JiraJql.scopeAndTypes(listOf("ENG"), emptyList()) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scopeAndTypes(listOf("ENG"), listOf("Epic")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scopeAndTypes(listOf("ENG"), listOf("1) OR project = X")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.scopeAndTypes(listOf("bad"), listOf("10001")) }
    }

    @Test
    fun `incremental adds a relative updated bound ordered ascending`() {
        assertEquals(
            "project in (\"ENG\") AND updated >= \"-15m\" ORDER BY updated ASC",
            JiraJql.incremental(listOf("ENG"), 15),
        )
        assertEquals("project in (\"ENG\") AND updated >= \"-0m\" ORDER BY updated ASC", JiraJql.incremental(listOf("ENG"), 0))
    }

    @Test
    fun `importBrowse narrows the typed full read by the done clause and a window in minutes, to the character`() {
        val keys = listOf("IMF")
        val types = listOf("10006", "10005", "10004")
        assertEquals(
            """project in ("IMF") AND issuetype in (10006,10005,10004) AND statusCategory != Done """ +
                """AND updated >= "-525600m" ORDER BY id ASC""",
            JiraJql.importBrowse(keys, types, excludeDone = true, updatedWithinDays = 365),
        )
        assertEquals(
            """project in ("IMF") AND issuetype in (10006,10005,10004) AND statusCategory != Done ORDER BY id ASC""",
            JiraJql.importBrowse(keys, types, excludeDone = true, updatedWithinDays = null),
        )
        assertEquals(
            """project in ("IMF","IMP") AND issuetype in (10006,10005,10004) AND updated >= "-1440m" ORDER BY id ASC""",
            JiraJql.importBrowse(listOf("IMF", "IMP"), types, excludeDone = false, updatedWithinDays = 1),
        )
        assertEquals(
            """project in ("IMF") AND issuetype in (10006,10005,10004) AND updated >= "-5256000m" ORDER BY id ASC""",
            JiraJql.importBrowse(keys, types, excludeDone = false, updatedWithinDays = 3_650),
        )
    }

    @Test
    fun `importBrowse refuses a window outside 1 to 3650 days, no type, a bad type id, a bad key and neither narrowing`() {
        val keys = listOf("IMF")
        val types = listOf("10004")
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, types, true, 0) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, types, true, 3_651) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, types, true, -1) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, emptyList(), true, 30) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, listOf("1) OR project = X"), true, 30) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(listOf("bad"), types, true, 30) }
        assertFailsWith<IllegalArgumentException> { JiraJql.importBrowse(keys, types, excludeDone = false, updatedWithinDays = null) }
    }

    @Test
    fun `children names the parent ids between the type clause and the order, to the character`() {
        val keys = listOf("IMC")
        assertEquals(
            """project in ("IMC") AND issuetype in (10005,10004) AND parent in (99001) ORDER BY id ASC""",
            JiraJql.children(keys, listOf("10005", "10004"), listOf("99001")),
        )
        assertEquals(
            """project in ("IMC") AND issuetype in (10004) AND parent in (99002,99003,99004) AND statusCategory != Done """ +
                """AND updated >= "-525600m" ORDER BY id ASC""",
            JiraJql.children(keys, listOf("10004"), listOf("99002", "99003", "99004"), excludeDone = true, updatedWithinDays = 365),
        )
        assertEquals(
            """project in ("IMC") AND issuetype in (10004) AND parent in (99002) AND statusCategory != Done ORDER BY id ASC""",
            JiraJql.children(keys, listOf("10004"), listOf("99002"), excludeDone = true),
        )
        assertEquals(
            """project in ("IMC","IMP") AND issuetype in (10004) AND parent in (99002) AND updated >= "-1440m" ORDER BY id ASC""",
            JiraJql.children(listOf("IMC", "IMP"), listOf("10004"), listOf("99002"), updatedWithinDays = 1),
        )
    }

    @Test
    fun `children and importBrowse spell their done and window clauses the same way`() {
        val keys = listOf("IMC")
        val types = listOf("10004")
        for ((done, days) in listOf(true to 365, true to null, false to 30, false to 3_650)) {
            // importBrowse is "<scope and types><clauses> ORDER BY id ASC": the rooted read is the same clauses behind its parent clause.
            val clauses = JiraJql.importBrowse(keys, types, done, days).substringAfter(JiraJql.scopeAndTypes(keys, types))
            assertEquals(
                "${JiraJql.scopeAndTypes(keys, types)} AND parent in (7)$clauses",
                JiraJql.children(keys, types, listOf("7"), done, days),
                "$done/$days",
            )
        }
    }

    @Test
    fun `children refuses no parent, more than fifty, a non-numeric or oversized id, a bad window and a bad key or type`() {
        val keys = listOf("IMC")
        val types = listOf("10004")
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, types, emptyList()) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, types, (1..51).map { "$it" }) }
        val fifty = JiraJql.children(keys, types, (1..50).map { "$it" })
        assertEquals(50, fifty.substringAfter("parent in (").substringBefore(")").split(",").size)
        for (hostile in listOf("IMC-1", "1) OR project = X", "", " 7", "7 ", "-1", "1.5", "9".repeat(21), "1,2")) {
            assertFailsWith<IllegalArgumentException>(hostile) { JiraJql.children(keys, types, listOf(hostile)) }
        }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, types, listOf("1"), true, 0) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, types, listOf("1"), true, 3_651) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, emptyList(), listOf("1")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(keys, listOf("Epic"), listOf("1")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(listOf("bad"), types, listOf("1")) }
        assertFailsWith<IllegalArgumentException> { JiraJql.children(emptyList(), types, listOf("1")) }
    }

    @Test
    fun `incremental rejects a negative minute window`() {
        assertFailsWith<IllegalArgumentException> { JiraJql.incremental(listOf("ENG"), -1) }
    }
}

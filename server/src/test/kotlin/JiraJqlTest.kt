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
    fun `incremental rejects a negative minute window`() {
        assertFailsWith<IllegalArgumentException> { JiraJql.incremental(listOf("ENG"), -1) }
    }
}

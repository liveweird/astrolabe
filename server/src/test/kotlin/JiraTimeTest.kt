package ch.nokillswit

import ch.nokillswit.jira.minutesBetween
import ch.nokillswit.jira.parseJiraInstant
import ch.nokillswit.jira.parseJiraInstantEpochMillis
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * `parseJiraInstant`/`parseJiraInstantEpochMillis` (Flow's real-tenant blocker, `jira-integration.md` "Timestamps"):
 * `java.time.Instant.parse`
 * rejects the REST API v3 form (`+0000`, no colon) Jira Cloud actually returns.
 */
class JiraTimeTest {

    @Test
    fun `accepts the REST API v3 form with millis and a colonless offset`() {
        assertEquals(Instant.parse("2024-01-15T10:20:30.123Z"), parseJiraInstant("2024-01-15T10:20:30.123+0000"))
    }

    @Test
    fun `accepts the ordinary Z form`() {
        assertEquals(Instant.parse("2024-01-15T10:20:30.123Z"), parseJiraInstant("2024-01-15T10:20:30.123Z"))
    }

    @Test
    fun `accepts a colon offset ahead of UTC`() {
        assertEquals(Instant.parse("2024-01-15T08:20:30.123Z"), parseJiraInstant("2024-01-15T10:20:30.123+02:00"))
    }

    @Test
    fun `accepts a colonless offset behind UTC`() {
        assertEquals(Instant.parse("2024-01-15T15:20:30.123Z"), parseJiraInstant("2024-01-15T10:20:30.123-0500"))
    }

    @Test
    fun `accepts a form with no fractional seconds`() {
        assertEquals(Instant.parse("2024-01-15T10:20:30Z"), parseJiraInstant("2024-01-15T10:20:30+0000"))
    }

    @Test
    fun `the epoch millis convenience matches the instant form`() {
        assertEquals(
            Instant.parse("2024-01-15T10:20:30.123Z").toEpochMilli(),
            parseJiraInstantEpochMillis("2024-01-15T10:20:30.123+0000"),
        )
    }

    @Test
    fun `accepts epoch millis as text`() {
        assertEquals(Instant.ofEpochMilli(1_790_330_188_061), parseJiraInstant("1790330188061"))
        assertEquals(1_790_330_188_061, parseJiraInstantEpochMillis("1790330188061"))
    }

    @Test
    fun `a malformed value throws the same unchecked exception Instant-parse itself would have`() {
        assertFailsWith<DateTimeParseException> { parseJiraInstant("not-a-timestamp") }
        assertFailsWith<DateTimeParseException> { parseJiraInstant("12345") }
    }

    @Test
    fun `minutesBetween rounds up and floors at zero`() {
        assertEquals(0, minutesBetween(1_000, 1_000))
        assertEquals(0, minutesBetween(2_000, 1_000))
        assertEquals(1, minutesBetween(0, 1))
        assertEquals(1, minutesBetween(0, 60_000))
        assertEquals(2, minutesBetween(0, 60_001))
    }
}

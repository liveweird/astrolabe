package ch.nokillswit.jira

import ch.nokillswit.infra.time.MILLIS_PER_MINUTE
import ch.nokillswit.infra.time.parseIsoOffsetInstant
import java.time.Instant

/**
 * The ONE shared timestamp parser for every Jira-sourced instant string (Flow's real-tenant blocker, `jira-integration.md` "Timestamps").
 * `java.time.Instant.parse` only accepts strict ISO-8601 (a `Z` or colon-delimited `+HH:MM` offset) - it REJECTS the form Jira Cloud's
 * REST API v3 actually returns for `created`/`updated`/`resolutiondate` on an issue: `yyyy-MM-dd'T'HH:mm:ss.SSSZ`, i.e. an offset with
 * NO colon (`+0000`). `ISO_OFFSET_INSTANT` (`infra/time/IsoOffsetInstant.kt`) accepts every spelling, and this function adds the
 * epoch-millis form a bulk endpoint can send. A malformed value throws `java.time.format.DateTimeParseException`, the same unchecked
 * exception `Instant.parse` itself throws. Never call `Instant.parse` on Jira-sourced text.
 */
fun parseJiraInstant(text: String): Instant =
    if (EPOCH_MILLIS.matches(text)) Instant.ofEpochMilli(text.toLong()) else parseIsoOffsetInstant(text)

/** No Jira timestamp text is all digits. 12 digits (from 2001) keep a short number failing loudly, 18 keep `toLong` from overflowing. */
private val EPOCH_MILLIS = Regex("^[0-9]{12,18}$")

/** Convenience for the overwhelmingly common `parseJiraInstant(text).toEpochMilli()` call shape. */
fun parseJiraInstantEpochMillis(text: String): Long = parseJiraInstant(text).toEpochMilli()

/**
 * Minutes between two epoch-millis instants, rounded UP (never under-covers a partial minute) and floored at zero - the `N` of a
 * relative `updated >= "-Nm"` JQL bound.
 */
internal fun minutesBetween(fromMillis: Long, toMillis: Long): Long {
    val millis = toMillis - fromMillis
    if (millis <= 0) return 0
    return (millis + MILLIS_PER_MINUTE - 1) / MILLIS_PER_MINUTE
}

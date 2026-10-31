package ch.nokillswit.infra.validation

import io.ktor.server.plugins.BadRequestException
import java.time.LocalDate
import java.time.format.DateTimeParseException

private val ISO_DATE_SHAPE = Regex("""\d{4}-\d{2}-\d{2}""")

/** The planning calendar: far inside what `DATE` and every zone's rules handle exactly, wide enough for any real plan. */
private const val MIN_YEAR = 1900
private const val MAX_YEAR = 2999

/**
 * Parses a wire date (`type: string, format: date`): exactly `YYYY-MM-DD` with ASCII digits, a real calendar day
 * (`2026-02-30` is not one) in the years 1900-2999. Anything else is a 400 naming [field]; the wire is day precision
 * end to end, so a timestamp or a zone offset is refused rather than truncated. The shape check comes first because
 * `LocalDate.parse` alone accepts signed and extended years.
 */
fun parseIsoDate(value: String, field: String): LocalDate {
    if (!ISO_DATE_SHAPE.matches(value)) throw invalidDate(field)
    val date = try {
        LocalDate.parse(value)
    } catch (_: DateTimeParseException) {
        throw invalidDate(field)
    }
    if (date.year !in MIN_YEAR..MAX_YEAR) throw BadRequestException("$field year must be between $MIN_YEAR and $MAX_YEAR")
    return date
}

private fun invalidDate(field: String) = BadRequestException("$field must be a YYYY-MM-DD date")

/** The span rule every dated record shares: [end] may equal [start] (a one-day span) but not precede it. */
fun requireDateOrder(start: LocalDate, end: LocalDate) {
    if (end.isBefore(start)) throw BadRequestException("End must not be before start")
}

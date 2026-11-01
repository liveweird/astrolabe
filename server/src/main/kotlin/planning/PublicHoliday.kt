package ch.nokillswit.planning

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.infra.validation.sanitizeSingleLine
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.time.LocalDate

const val MAX_PUBLIC_HOLIDAY_NAME_LENGTH = 100

/** The years a preset may be applied to: the wire-date range of `parseIsoDate` (`infra/validation/Dates.kt`). */
const val MIN_PRESET_YEAR = 1900
const val MAX_PRESET_YEAR = 2999

/**
 * One entry of the global, ADMIN-curated public-holiday dictionary (`public_holidays`, V19; ported from Flow): on this date nobody
 * works. It is plan state (every write runs under the plan lock) and feeds the one working calendar of the views and the schedule write.
 */
@Serializable
data class PublicHolidayResponse(
    val id: UInt,
    val date: String,
    val name: String,
)

/** The unpaged dictionary read — bounded, ADMIN-curated, about 14 rows a year (`list-endpoints.md` "Sub-collections and facets"). */
@Serializable
data class PublicHolidayList(
    val items: List<PublicHolidayResponse>,
)

@Serializable
data class PublicHolidayCreateRequest(
    val date: String,
    val name: String,
)

/** The named holiday sets `POST /public-holidays/apply-preset` knows. */
@Serializable
enum class HolidayPreset { POLISH }

@Serializable
data class HolidayPresetRequest(
    val preset: HolidayPreset,
    val year: Int,
)

/**
 * What a preset application did: the rows it [added] and the ISO dates it [skipped] because the dictionary already held a holiday
 * there (the existing row, and its name, are kept — the preset never renames).
 */
@Serializable
data class HolidayPresetResponse(
    val added: List<PublicHolidayResponse>,
    val skipped: List<String>,
)

/** A validated holiday: the date parsed, the name trimmed and bounded. */
data class PublicHolidayValues(val date: LocalDate, val name: String)

/** Trims the name (a control character is a 400); idempotent. */
fun sanitizedPublicHoliday(request: PublicHolidayCreateRequest): PublicHolidayCreateRequest =
    request.copy(name = sanitizeSingleLine(request.name, "name"))

/**
 * A holiday's shape: a strict ISO date (1900-2999, [parseIsoDate]) and a non-blank bounded name. Uniqueness of the date is the
 * database's `uq_public_holidays_date` (23505 -> the central 409 mapping), deliberately no pre-check. Enforced by the route AND the
 * service.
 */
fun validatePublicHoliday(request: PublicHolidayCreateRequest): PublicHolidayValues {
    val date = parseIsoDate(request.date, "date")
    if (request.name.isBlank()) throw BadRequestException("Holiday name must not be blank")
    if (request.name.length > MAX_PUBLIC_HOLIDAY_NAME_LENGTH) {
        throw BadRequestException("Holiday name must be at most $MAX_PUBLIC_HOLIDAY_NAME_LENGTH characters")
    }
    return PublicHolidayValues(date, request.name)
}

/** The year of a preset request: `1900..2999`, a 400 otherwise (an unknown preset name is the enum decode's 400). */
fun validatePresetYear(year: Int) {
    if (year !in MIN_PRESET_YEAR..MAX_PRESET_YEAR) {
        throw BadRequestException("year must be between $MIN_PRESET_YEAR and $MAX_PRESET_YEAR")
    }
}

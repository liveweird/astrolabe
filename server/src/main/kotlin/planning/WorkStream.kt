package ch.nokillswit.planning

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.infra.validation.requireDateOrder
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import kotlinx.serialization.Serializable
import java.time.LocalDate

/**
 * Work streams (V12), the top of the plan hierarchy (`planning-model.md`): a name, an optional description, a REQUIRED owner (an
 * ACTIVE person of the people directory) and a start date; the end date is set only when the stream is closed (an end equal to the
 * start is a one-day span). Dates are ISO `YYYY-MM-DD` strings on the wire (`infra/validation/Dates.kt`).
 */
const val MAX_PLAN_NAME_LENGTH = 100
const val MAX_PLAN_DESCRIPTION_LENGTH = 500

@Serializable
data class WorkStreamCreateRequest(
    val name: String,
    val description: String? = null,
    /** The owner — an ACTIVE person (400 otherwise). Required: ownership-scoped rights need an owner on every node. */
    val ownerPersonId: UInt,
    val startDate: String,
    /** Set only when the stream is closed; not before [startDate]. */
    val endDate: String? = null,
)

/** PUT is a full replace: an omitted description or end date is unset (an unset end date reopens the stream). */
typealias WorkStreamUpdateRequest = WorkStreamCreateRequest

@Serializable
data class WorkStreamResponse(
    val id: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val startDate: String,
    val endDate: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

/** The parsed dates of a validated work stream request. */
data class WorkStreamDates(val start: LocalDate, val end: LocalDate?)

/** What the update replaced, for the audit deltas: the STORED owner and end date before the write. */
data class WorkStreamUpdateOutcome(val ownerFrom: UInt, val endFrom: LocalDate?)

/** Trims the scalars (the sanitizer convention — control characters are a 400). */
fun WorkStreamCreateRequest.sanitized(): WorkStreamCreateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description))

/** The work stream rules — enforced by the route AND re-checked by the service; returns the parsed dates. */
fun validateWorkStream(request: WorkStreamCreateRequest): WorkStreamDates {
    requireNameAndDescription(request.name, request.description, MAX_PLAN_NAME_LENGTH, MAX_PLAN_DESCRIPTION_LENGTH)
    val start = parseIsoDate(request.startDate, "Start date")
    val end = request.endDate?.let { parseIsoDate(it, "End date") }
    if (end != null) requireDateOrder(start, end)
    return WorkStreamDates(start, end)
}

package ch.nokillswit.teams

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.planning.validateManDays
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.time.LocalDate

const val MIN_WIP_LIMIT = 1
const val MAX_WIP_LIMIT = 99

/**
 * Team capacity periods (V16), the body of both the create and the full-replace PUT: a team's man-days per week and an optional
 * work-in-progress limit from an effective-from date. A period is in force from [effectiveFrom] — ANY calendar day, a weekend date
 * simply counting from the next working day — until the next ACTIVE period of the same team. Team data, not plan state: written by
 * the team's manager or ADMIN in a transaction of its own (no plan lock, no plan revision); `planning-model.md` "Team capacity periods".
 */
@Serializable
data class CapacityPeriodRequest(
    /** The first day the capacity applies: `YYYY-MM-DD`, years 1900-2999, any weekday. */
    val effectiveFrom: String,
    /** Man-days per week: finite, `0 <= x < 1_000_000`, at most two decimals ([validateManDays]); zero = on hold. */
    val mdPerWeek: Double,
    /** The most milestones in progress on one working day, `1..99`; absent or null = no limit (a PUT without it clears the limit). */
    val wipLimit: Int? = null,
)

/**
 * Who wrote a capacity period (V24): [MANUAL] = a person (every period before 1.5.0 and every hand-entered one), [FLOW] = the
 * capacity import for a Flow sprint. A manual edit of a [FLOW] period makes it [MANUAL]; the import never changes a [MANUAL] one.
 */
enum class CapacitySource { MANUAL, FLOW }

@Serializable
data class CapacityPeriodResponse(
    val id: UInt,
    val teamId: UInt,
    val effectiveFrom: String,
    val mdPerWeek: Double,
    val wipLimit: Int?,
    val createdAt: Long,
    val updatedAt: Long,
    /** Always present (no default): who wrote the period. */
    val source: CapacitySource,
    /** The Flow sprint a [CapacitySource.FLOW] period was imported for; null for a manual one. */
    val flowSprintName: String?,
)

/**
 * A stored ACTIVE period with the provenance the capacity import reads ([TeamCapacityService.importRowsOf]): the wire response carries
 * the sprint's name only, the import also needs the sprint id to tell a period whose sprint left Flow's document from a live one.
 */
data class CapacityPeriodRow(
    val id: UInt,
    val effectiveFrom: LocalDate,
    val mdPerWeek: BigDecimal,
    val wipLimit: Int?,
    val source: CapacitySource,
    val flowSprintId: Long?,
    val flowSprintName: String?,
)

/** The bounded `{items}` wrapper (a handful of periods per team per year), in `effectiveFrom` order. */
@Serializable
data class CapacityPeriodList(val items: List<CapacityPeriodResponse>)

/** A validated period: the date parsed and the figure as the exact stored decimal (`NUMERIC(8,2)`). */
data class CapacityPeriodValues(val effectiveFrom: LocalDate, val mdPerWeek: BigDecimal, val wipLimit: Int?)

/**
 * What a period update replaced: the team it belongs to, the STORED values before and after, and the source the period had before (a PUT
 * always leaves it [CapacitySource.MANUAL]). Equal values on a manual period = a no-op PUT; a PUT on a [CapacitySource.FLOW] period always
 * counts as a change, because it takes the period over.
 */
data class CapacityUpdateOutcome(
    val teamId: UInt,
    val before: CapacityPeriodValues,
    val after: CapacityPeriodValues,
    val sourceBefore: CapacitySource,
) {
    val changed: Boolean
        get() = before.effectiveFrom != after.effectiveFrom || before.mdPerWeek.compareTo(after.mdPerWeek) != 0 ||
            before.wipLimit != after.wipLimit || sourceBefore != CapacitySource.MANUAL
}

/**
 * The period rules — enforced by the route AND re-checked by the service ([requireValidCapacity]). The date is [parseIsoDate]'s alone
 * (no weekday rule), the figure [validateManDays]'s, the limit null or `1..99` (the V16 CHECK is the backstop).
 */
fun validateCapacityPeriod(request: CapacityPeriodRequest): CapacityPeriodValues {
    val values = CapacityPeriodValues(
        effectiveFrom = parseIsoDate(request.effectiveFrom, "effectiveFrom"),
        mdPerWeek = validateManDays(request.mdPerWeek, "mdPerWeek"),
        wipLimit = request.wipLimit,
    )
    requireValidCapacity(values)
    return values
}

/**
 * The typed half of the rules, for the service (a direct caller gets a 400, never a CHECK violation's 500): the figure finite-decimal
 * in `0 <= x < 1_000_000` with at most two decimals, the limit null or `1..99`.
 */
fun requireValidCapacity(values: CapacityPeriodValues) {
    validateManDays(values.mdPerWeek.toDouble(), "mdPerWeek")
    val wipLimit = values.wipLimit
    if (wipLimit != null && wipLimit !in MIN_WIP_LIMIT..MAX_WIP_LIMIT) {
        throw BadRequestException("wipLimit must be between $MIN_WIP_LIMIT and $MAX_WIP_LIMIT")
    }
}

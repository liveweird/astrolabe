package ch.nokillswit.flow

import java.math.BigDecimal
import java.math.RoundingMode

// The widths of the V24 mirror columns: a row is FITTED to them before it is written (a string too long or a figure out of its NUMERIC
// would fail the whole statement, and one odd team would then fail every later run - the reasoning of the Jira observation rows).
internal const val FLOW_TEAM_NAME_WIDTH = 100
internal const val FLOW_SPRINT_NAME_WIDTH = 255
internal const val FLOW_SPRINT_STATE_WIDTH = 10
internal const val FLOW_CAPACITY_SOURCE_WIDTH = 20
internal const val FLOW_ACCOUNT_ID_WIDTH = 128
internal const val FLOW_DISPLAY_NAME_WIDTH = 255

/** `NUMERIC(8,2)` and `NUMERIC(10,2)`: the digits before the point (`flow_teams.default_capacity_md`, `flow_sprints.capacity_md`). */
private const val TEAM_DEFAULT_INTEGER_DIGITS = 6
private const val SPRINT_CAPACITY_INTEGER_DIGITS = 8
private const val MD_SCALE = 2

/**
 * One team of Flow's document as the mirror keeps it (`flow_teams` with its `flow_sprints` and `flow_members`). The run builds these from
 * the decoded document; [FlowMirrorStore.replace] FITS them (so the observer cannot forget to) and writes them wholesale. Instants are
 * Flow's raw epoch millis - the connection's time zone is applied at read time, never stored.
 */
data class FlowMirrorTeam(
    val flowTeamId: Int,
    val name: String,
    /** The team's default sprint capacity in man-days; null when Flow has none. */
    val defaultCapacityMd: BigDecimal?,
    val sprints: List<FlowMirrorSprint>,
    val members: List<FlowMirrorMember>,
)

/** A sprint of a Flow team. [capacityMd] is a TOTAL for the sprint whatever its [capacitySource]; null = no capacity at all. */
data class FlowMirrorSprint(
    val sprintId: Long,
    /** Flow's own data-source connection the sprint came from (`connectionId` in the document). */
    val sourceConnectionId: Int,
    val name: String,
    /** Flow's state text, kept as sent (cut to the column): an unknown state is not an error. */
    val state: String,
    val startAt: Long?,
    val endAt: Long?,
    val completeAt: Long?,
    val hasCalendar: Boolean,
    val capacityMd: BigDecimal?,
    val capacitySource: String?,
)

/** A dated membership interval of a Jira account in a Flow team; [validTo] null = still a member. The account id stays server-side. */
data class FlowMirrorMember(
    val accountId: String,
    val displayName: String?,
    val validFrom: Long,
    val validTo: Long?,
)

/** A stored team with the counts the connection page shows ([FlowMirrorStore.teamsOf]). */
data class FlowMirrorTeamRow(
    val flowTeamId: Int,
    val name: String,
    val defaultCapacityMd: BigDecimal?,
    val observedAt: Long,
    val sprintCount: Int,
    val memberCount: Int,
)

/**
 * Control characters become spaces (U+0000 cannot be stored in `text` at all), then the value is cut to [width]; a cut never leaves half
 * a surrogate pair (an unpaired surrogate is no valid UTF-8, so it would fail the statement).
 */
internal fun String.fittedTo(width: Int): String =
    map { if (it.isISOControl()) ' ' else it }.joinToString("").take(width)
        .let { if (it.isNotEmpty() && it.last().isHighSurrogate()) it.dropLast(1) else it }

/** A man-day figure on `NUMERIC(p,2)`: two decimals, half up; null when it is negative or has more than [integerDigits] integer digits. */
private fun BigDecimal?.fittedMd(integerDigits: Int): BigDecimal? {
    val scaled = this?.setScale(MD_SCALE, RoundingMode.HALF_UP) ?: return null
    val limit = BigDecimal.TEN.pow(integerDigits)
    return scaled.takeIf { it.signum() >= 0 && it < limit }
}

/**
 * The team as the columns will hold it. Rows that would collide on a primary key are collapsed to the FIRST one (a document that repeats a
 * sprint or a membership interval is Flow's bug, not a reason to fail the run), and the sprints and members of the team keep their order.
 */
internal fun FlowMirrorTeam.fitted(): FlowMirrorTeam = FlowMirrorTeam(
    flowTeamId = flowTeamId,
    name = name.fittedTo(FLOW_TEAM_NAME_WIDTH),
    defaultCapacityMd = defaultCapacityMd.fittedMd(TEAM_DEFAULT_INTEGER_DIGITS),
    sprints = sprints.distinctBy { it.sprintId }.map {
        it.copy(
            name = it.name.fittedTo(FLOW_SPRINT_NAME_WIDTH),
            state = it.state.fittedTo(FLOW_SPRINT_STATE_WIDTH),
            capacityMd = it.capacityMd.fittedMd(SPRINT_CAPACITY_INTEGER_DIGITS),
            capacitySource = it.capacitySource?.fittedTo(FLOW_CAPACITY_SOURCE_WIDTH),
        )
    },
    members = members.map {
        it.copy(
            accountId = it.accountId.fittedTo(FLOW_ACCOUNT_ID_WIDTH),
            displayName = it.displayName?.fittedTo(FLOW_DISPLAY_NAME_WIDTH),
        )
    }.distinctBy { it.accountId to it.validFrom },
)

/** The mirror's input from the decoded document (the run's mapping; [FlowMirrorStore.replace] fits it to the columns). */
internal fun FlowTeam.toMirrorTeam(): FlowMirrorTeam = FlowMirrorTeam(
    flowTeamId = id,
    name = name,
    defaultCapacityMd = defaultCapacityMd?.let(BigDecimal::valueOf),
    sprints = sprints.map {
        FlowMirrorSprint(
            sprintId = it.sprintId,
            sourceConnectionId = it.connectionId,
            name = it.name,
            state = it.state,
            startAt = it.startAt,
            endAt = it.endAt,
            completeAt = it.completeAt,
            hasCalendar = it.hasCalendar,
            capacityMd = it.capacityMd?.let(BigDecimal::valueOf),
            capacitySource = it.capacitySource,
        )
    },
    members = members.map { FlowMirrorMember(it.accountId, it.displayName, it.validFrom, it.validTo) },
)

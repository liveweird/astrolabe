package ch.nokillswit.flow

import ch.nokillswit.sync.SyncStatus
import kotlinx.serialization.Serializable
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** What the roster shows for a membership whose Flow display name is null (Flow keeps the account's name only while it knows it). */
const val UNKNOWN_ACCOUNT = "Unknown account"

/** `GET /teams/{id}/flow`: the team the document describes (a deleted team is a `404`, never a document). */
@Serializable
data class FlowPanelTeam(val id: UInt, val name: String)

/**
 * What the caller may do with the team's Flow link: ADMIN or the team's ACTIVE manager, the same verdict for all three (they are separate
 * flags so a later version can split the rights without a wire change). The writes still decide for themselves.
 */
@Serializable
data class FlowPanelCan(val link: Boolean, val unlink: Boolean, val importCapacity: Boolean)

/**
 * The team's ACTIVE binding with its connection. [gone] is derived at read time: the connection has mirrored a document and the bound Flow
 * team is not in it (never stored). [observedAt] is when the mirror last saw the team, else when the connection last replaced it.
 * [connectionName] is shown to every login; the connection's base URL, token and zone never are.
 */
@Serializable
data class FlowPanelBinding(
    val id: UInt,
    val connectionId: UInt,
    val connectionName: String,
    val flowTeamId: Int,
    val flowTeamName: String,
    val connectionEnabled: Boolean,
    val status: SyncStatus,
    val observedAt: Long?,
    val gone: Boolean,
)

/** A member now: [displayName] is [UNKNOWN_ACCOUNT] when Flow sent none; [since] is an ISO date in the connection's zone. */
@Serializable
data class FlowRosterCurrent(val displayName: String, val since: String)

/** A membership that ended: ISO dates in the connection's zone, [to] the first day the person was no longer a member. */
@Serializable
data class FlowRosterFormer(val displayName: String, val from: String, val to: String)

@Serializable
data class FlowRoster(val current: List<FlowRosterCurrent>, val former: List<FlowRosterFormer>)

/** The mirrored sprints: how many, and the date (connection zone) of the first one starting today or later. */
@Serializable
data class FlowSprintSummary(val count: Int, val nextStart: String?)

/** `roster`, `sprints` are null for an unbound team and for a bound team that is [FlowPanelBinding.gone]. No account id, email or token. */
@Serializable
data class FlowTeamPanel(
    val team: FlowPanelTeam,
    val can: FlowPanelCan,
    val binding: FlowPanelBinding?,
    val roster: FlowRoster?,
    val sprints: FlowSprintSummary?,
)

/** Who sees the roster's names. Q2a (decided 2026-11-08): [EVERY_LOGIN]; [MANAGER_OR_ADMIN] is the one-line flip to Q2b. */
internal enum class RosterAudience { EVERY_LOGIN, MANAGER_OR_ADMIN }

/** The ONE audience predicate of the panel: [manages] says whether the caller is ADMIN or the team's active manager. */
internal fun rosterVisibleTo(audience: RosterAudience, manages: Boolean): Boolean = audience == RosterAudience.EVERY_LOGIN || manages

/**
 * The roster from the mirrored membership intervals (pure). An interval is half-open in INSTANTS, `[validFrom, validTo)`: it is current
 * when `validFrom <= now < validTo` (an open `validTo` never ends), former when `validTo <= now`, and a future one (`validFrom > now`) is
 * neither - the person is not a member yet. Dates are the instants in the connection's [zone]. A person with two intervals appears once
 * per interval. Current members are sorted by name then date, former ones by the end date (newest first) then name.
 */
internal fun rosterOf(members: List<FlowMirrorMember>, zone: ZoneId, now: Long): FlowRoster {
    fun date(instant: Long): LocalDate = Instant.ofEpochMilli(instant).atZone(zone).toLocalDate()

    fun name(member: FlowMirrorMember): String = member.displayName?.takeIf { it.isNotBlank() } ?: UNKNOWN_ACCOUNT
    val current = members.filter { it.validFrom <= now && (it.validTo == null || now < it.validTo) }
        .map { FlowRosterCurrent(name(it), date(it.validFrom).toString()) }
        .sortedWith(compareBy<FlowRosterCurrent> { it.displayName.lowercase() }.thenBy { it.since })
    val former = members.filter { it.validTo != null && it.validTo <= now }
        .map { FlowRosterFormer(name(it), date(it.validFrom).toString(), date(checkNotNull(it.validTo)).toString()) }
        .sortedWith(compareByDescending<FlowRosterFormer> { it.to }.thenBy { it.displayName.lowercase() }.thenBy { it.from })
    return FlowRoster(current, former)
}

/** The first sprint start (a date in [zone]) that is [today] or later, or null; a sprint without a start does not count. */
internal fun nextSprintStart(sprints: List<FlowMirrorSprint>, zone: ZoneId, today: LocalDate): LocalDate? =
    sprints.mapNotNull { sprint -> sprint.startAt?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() } }
        .filter { it >= today }.minOrNull()

/** The connection's zone; a zone this JVM no longer knows reads as UTC rather than failing a read (the run reports it). */
internal fun zoneOrUtc(id: String): ZoneId = try {
    ZoneId.of(id)
} catch (_: DateTimeException) {
    ZoneId.of("UTC")
}

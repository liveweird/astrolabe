package ch.nokillswit.planning

import java.time.LocalDate

/**
 * What the effective order of a team's milestones reads about one milestone (the pure input of [effectiveOrder]): its stored position
 * in the team's own order ([customPosition], null = unlisted), its project's position in the global project rank ([projectRank], null =
 * unranked) and the plain fields of the final tiebreak.
 */
data class OrderKey(
    val customPosition: Int?,
    val projectRank: Int?,
    val projectName: String,
    val projectId: UInt,
    val start: LocalDate?,
    val end: LocalDate?,
    val name: String,
    val id: UInt,
)

/**
 * The team's milestone order as a comparator (the pure kernel; no I/O): the stored custom position first (an unlisted milestone after
 * every listed one), then the project's global rank (an unranked project after every ranked one), then project name (case-insensitive),
 * project id, and finally the project view's tuple (start, end, name case-insensitive, id), except that an unscheduled milestone's
 * missing dates sort LAST: undated work follows the dated work of its project in an execution order.
 *
 * The stored positions are the TEAM's and absolute: they never read the project rank, so a rank change cannot reorder them; only the
 * unlisted tail follows the rank.
 */
private val EFFECTIVE_ORDER: Comparator<OrderKey> = compareBy<OrderKey>(
    { it.customPosition ?: Int.MAX_VALUE },
    { it.projectRank ?: Int.MAX_VALUE },
    { it.projectName.lowercase() },
    { it.projectId },
).thenBy(nullsLast()) { it.start?.toEpochDay() }
    .thenBy(nullsLast()) { it.end?.toEpochDay() }
    .thenBy { it.name.lowercase() }
    .thenBy { it.id }

/** [items] in the team's effective order, each ordered by the [OrderKey] [keyOf] reads off it. */
fun <T> effectiveOrder(items: Iterable<T>, keyOf: (T) -> OrderKey): List<T> =
    items.sortedWith { a, b -> EFFECTIVE_ORDER.compare(keyOf(a), keyOf(b)) }

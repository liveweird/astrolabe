package ch.nokillswit.planning

/*
 * The comparison of a baseline's FROZEN links with the links now, as pure functions (no I/O, no clock), the idiom of
 * `BaselineKernels.kt`. A link is identified by its dependency id: the same id on both sides with the same type and lag is unchanged,
 * with a different type or lag CHANGED; an id on one side only is ADDED (now) or REMOVED (then). A link's ends never change (the PUT
 * edits type and lag only), so a link deleted and made again - same ends, a new id - reads as one REMOVED and one ADDED.
 */

/** What happened to one link since the baseline. */
enum class LinkChangeKind { ADDED, REMOVED, CHANGED }

/** One changed link: [then] is null for an ADDED one, [now] for a REMOVED one; the ends are the one side's that exists (equal on both). */
data class LinkChange(val kind: LinkChangeKind, val then: PlanLinkFact?, val now: PlanLinkFact?) {
    val dependencyId: UInt get() = checkNotNull(now ?: then).id
}

/** The counts over EVERY link of either side (changed or not). */
data class LinkTotals(val added: Int, val removed: Int, val changed: Int, val unchanged: Int)

/** The changed links by dependency id ([changes]) and the counts over all of them ([totals]). */
data class LinkComparison(val changes: List<LinkChange>, val totals: LinkTotals)

object BaselineLinkKernels {
    /** [then] is the baseline's frozen links, [now] those it is compared with (the live ACTIVE ones, or a second baseline's). */
    fun compare(then: List<PlanLinkFact>, now: List<PlanLinkFact>): LinkComparison {
        val thenById = then.associateBy { it.id }
        val nowById = now.associateBy { it.id }
        var unchanged = 0
        val changes = (thenById.keys + nowById.keys).sorted().mapNotNull { id ->
            val before = thenById[id]
            val after = nowById[id]
            when {
                before == null -> LinkChange(LinkChangeKind.ADDED, null, after)
                after == null -> LinkChange(LinkChangeKind.REMOVED, before, null)
                before.type != after.type || before.lagDays != after.lagDays -> LinkChange(LinkChangeKind.CHANGED, before, after)
                else -> null.also { unchanged++ }
            }
        }
        fun count(kind: LinkChangeKind) = changes.count { it.kind == kind }
        return LinkComparison(
            changes,
            LinkTotals(
                added = count(LinkChangeKind.ADDED),
                removed = count(LinkChangeKind.REMOVED),
                changed = count(LinkChangeKind.CHANGED),
                unchanged = unchanged,
            ),
        )
    }
}

package ch.nokillswit.planning

/** A program's stored place: the work stream whose list it was written into and its 1-based [position] there. */
data class ProgramSlot(val workStreamId: UInt, val position: Int)

/**
 * The stored positions of the shared plan order (V34, `plan-tree.md`), keyed by node id: [workStreams] (the one global list) and
 * [programs] (one list per work stream, so a slot also names its stream). Nothing here is read FROM the tables' side: the kernels
 * look positions up from the ACTIVE nodes, so a row of a deleted or moved node is never consulted. [NONE] is "nothing stored".
 */
class PlanOrder(val workStreams: Map<UInt, Int> = emptyMap(), val programs: Map<UInt, ProgramSlot> = emptyMap()) {
    companion object {
        val NONE = PlanOrder()
    }
}

/**
 * The effective order of the work streams and of a work stream's programs as pure functions (no I/O; `plan-tree.md` "The effective
 * order"). With nothing stored they sort exactly as before V34 (by name, then id; closed streams last); a stored position puts a node
 * ahead of every unlisted one, and unlisted nodes follow, by name.
 */
object PlanOrderKernels {
    /**
     * [items] in the order of the work stream list: closed streams (`closed`) after every open one WHATEVER their stored position, then
     * the listed streams by position, then the unlisted ones by lowercase name, then id.
     */
    fun <T> orderWorkStreams(
        items: Collection<T>,
        order: PlanOrder,
        id: (T) -> UInt,
        name: (T) -> String,
        closed: (T) -> Boolean,
    ): List<T> = items.sortedWith(
        compareBy<T>({ closed(it) }, { order.workStreams[id(it)] ?: Int.MAX_VALUE }, { name(it).lowercase() }, { id(it) }),
    )

    /**
     * [items] in the order of THEIR work stream's program list (the callers hand one stream's programs): the listed programs by
     * position, then the unlisted by lowercase name, then id. A position counts only while the row's stream is the program's CURRENT
     * one (a program moved to another stream is unlisted there, whatever a stale row says).
     */
    fun <T> orderPrograms(
        items: Collection<T>,
        order: PlanOrder,
        id: (T) -> UInt,
        workStreamId: (T) -> UInt,
        name: (T) -> String,
    ): List<T> =
        items.sortedWith(
            compareBy<T>(
                { item -> order.programs[id(item)]?.takeIf { it.workStreamId == workStreamId(item) }?.position ?: Int.MAX_VALUE },
                { name(it).lowercase() },
                { id(it) },
            ),
        )
}

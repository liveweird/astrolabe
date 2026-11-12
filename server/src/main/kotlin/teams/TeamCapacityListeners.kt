package ch.nokillswit.teams

import ch.nokillswit.infra.catchingFailures
import io.ktor.util.AttributeKey
import org.slf4j.LoggerFactory
import java.util.concurrent.CopyOnWriteArrayList

private val log = LoggerFactory.getLogger(CapacityWriteTrail::class.java)

/**
 * A connector's part in a team's capacity write (1.13.3). `teams/` names no connector: a connector registers itself (`configureFlow`
 * does, to keep its acknowledgements honest about the capacity rows the write brought in line). Both calls run INSIDE the write's
 * transaction, so the connector's locks and its writes commit or roll back with the capacity write itself.
 */
interface CapacityWriteListener {
    /**
     * Called BEFORE the team row is locked: take the connector's own row locks for [teamId] here, so every capacity write meets them
     * in the order the connector's own paths use (its rows first, then the team row). Writes nothing. Answers the ids of the rows it
     * locked, which the service hands back to [settle]: the connector may touch ONLY those (a row that appeared after this call was
     * never locked by this write).
     */
    suspend fun lockBeforeTeam(teamId: UInt): List<UInt>

    /**
     * Called after the write's last statement, still inside its transaction, only for a write that changed a period: the team row and
     * the locks of [lockBeforeTeam] ([locked] are their ids) are held and the new periods are visible to this transaction. Must not take
     * further connector locks. What must happen only once the write COMMITTED (an audit line) goes to [trail].
     */
    suspend fun settle(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail)
}

/**
 * What the listeners left for after the commit of ONE capacity write: the write's caller creates it, hands it to the service call and,
 * once the write committed and its own audit line was written, calls [told] (before the response). A write that was refused or rolled
 * back leaves nothing to tell; a direct service call that passes no trail drops what the listeners deposited.
 */
class CapacityWriteTrail {
    private val actions = CopyOnWriteArrayList<suspend (byUserId: UInt) -> Unit>()

    /** Queues [action] for [told]; called by a listener's [CapacityWriteListener.settle]. */
    fun afterCommit(action: suspend (byUserId: UInt) -> Unit) {
        actions += action
    }

    /**
     * Runs the queued actions for login [byUserId], outside any transaction. Never throws (cancellation aside): an action's failure is
     * one WARN naming the exception class; the write stands.
     */
    suspend fun told(byUserId: UInt) {
        for (action in actions) {
            catchingFailures({ action(byUserId) }) { failure ->
                log.warn("Capacity write follow-up failed ({})", failure.javaClass.simpleName)
            }
        }
    }
}

/**
 * The listeners of a team's capacity writes, empty from the composition root until a connector's module fills it. [TeamCapacityService]
 * calls [lockBeforeTeam] and [settle] INSIDE each write's transaction (a failure there aborts the write: the lock order and the
 * connector's rows are part of the write, not a notification).
 */
class CapacityWriteListeners {
    private val listeners = CopyOnWriteArrayList<CapacityWriteListener>()

    fun register(listener: CapacityWriteListener) {
        listeners += listener
    }

    /** Runs every listener's lock step; the result goes to [settle] unchanged (one entry per listener, in registration order). */
    suspend fun lockBeforeTeam(teamId: UInt): CapacityWriteLocks = CapacityWriteLocks(listeners.map { it.lockBeforeTeam(teamId) })

    suspend fun settle(teamId: UInt, locks: CapacityWriteLocks, trail: CapacityWriteTrail) {
        // A listener registered between the lock step and the settle has no entry: it locked nothing, so it is handed nothing.
        listeners.forEachIndexed { index, listener -> listener.settle(teamId, locks.byListener.getOrElse(index) { emptyList() }, trail) }
    }
}

/** What each listener locked in [CapacityWriteListeners.lockBeforeTeam] (its row ids), carried through one write's transaction. */
class CapacityWriteLocks(internal val byListener: List<List<UInt>>)

val CapacityWriteListenersKey = AttributeKey<CapacityWriteListeners>("CapacityWriteListeners")

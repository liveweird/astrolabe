package ch.nokillswit.teams

import ch.nokillswit.infra.catchingFailures
import io.ktor.util.AttributeKey
import org.slf4j.LoggerFactory
import java.util.concurrent.CopyOnWriteArrayList

private val log = LoggerFactory.getLogger(CapacityWriteListeners::class.java)

/**
 * Told after a capacity write of [teamId] COMMITTED, by login [byUserId], outside any transaction. `teams/` names no connector: a
 * connector registers itself (`configureFlow` does, to clear the acknowledgements of capacity rows the write brought in line).
 */
fun interface CapacityWriteListener {
    suspend fun capacityWritten(teamId: UInt, byUserId: UInt)
}

/**
 * The listeners of a team's capacity writes, empty from the composition root until a connector's module fills it. The ROUTES call
 * [written] after the write's commit and its audit line and BEFORE the response; nothing inside [TeamCapacityService] does, because a
 * listener that ran inside the write's transaction would hold the team row lock while it takes its own (the deadlock the seam avoids).
 */
class CapacityWriteListeners {
    private val listeners = CopyOnWriteArrayList<CapacityWriteListener>()

    fun register(listener: CapacityWriteListener) {
        listeners += listener
    }

    /** Never throws (cancellation aside): a listener's failure is one WARN naming the team id and the exception class; the write stands. */
    suspend fun written(teamId: UInt, byUserId: UInt) {
        for (listener in listeners) {
            catchingFailures({ listener.capacityWritten(teamId, byUserId) }) { failure ->
                log.warn("Capacity write listener of team {} failed ({})", teamId, failure.javaClass.simpleName)
            }
        }
    }
}

val CapacityWriteListenersKey = AttributeKey<CapacityWriteListeners>("CapacityWriteListeners")

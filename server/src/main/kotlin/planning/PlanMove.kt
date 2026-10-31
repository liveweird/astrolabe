package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * The reparent bodies (`POST /projects/{id}/move`, `POST /programs/{id}/move`, v0.3.0): the ONE field is the new parent. The caller
 * must own something ABOVE the node on the SOURCE chain (the node's own owner alone may not move it) AND something on the TARGET chain
 * (or be ADMIN) — a parent's owner takes a node out of where it is, and the caller must be able to create one where it
 * is going. No `expectedRevision`: a move is an idempotent set of the parent, not a read-modify-write of a client's view.
 */
@Serializable
data class ProjectMoveRequest(val programId: UInt)

@Serializable
data class ProgramMoveRequest(val workStreamId: UInt)

/** The parent a node had under the plan lock ([from]) and the one the request named ([to]); equal = a no-op (nothing written, no audit). */
data class MoveOutcome(val from: UInt, val to: UInt) {
    val changed: Boolean get() = from != to
}

/**
 * The two guards of a move, re-run INSIDE the plan lock ([source] on the node's own chain re-read there, [target] on the candidate
 * parent's): [source] is `requireAncestorOwnerOrAdmin`, [target] `requireOwnerOrAdmin`. Both share ONE `FOR SHARE` lookup of the caller's
 * person (built by [PlanRouteDeps.moveGuards]).
 */
class MoveGuards(val source: PlanGuard, val target: PlanGuard)

/** A target parent that is missing or deleted (or whose own ancestor is) is a 400 on the body field, never a 404 on the path. */
internal fun unknownMoveTarget(kind: String, id: UInt): Nothing = throw BadRequestException("Unknown or deleted $kind ids: $id")

package ch.nokillswit.authz

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

class UnauthorizedException(message: String = "Authentication required") : RuntimeException(message)

class ForbiddenException(message: String = "Forbidden") : RuntimeException(message)

/**
 * Addressed resource does not exist (or is soft-deleted / lives under a different parent path)
 * → 404 with the given detail. Routes throw it from read preambles and zero-row mutation
 * results instead of hand-rolling a respondProblem + return.
 */
class NotFoundException(message: String = "Resource not found") : RuntimeException(message)

/** The route 404 convention as a helper: a null read → `"<resource> not found"`. */
fun <T : Any> T?.orNotFound(resource: String): T = this ?: throw NotFoundException("$resource not found")

/** The zero-row-mutation half of the same convention. */
fun Int.orNotFound(resource: String): Int =
    if (this == 0) throw NotFoundException("$resource not found") else this

/**
 * Requested action conflicts with the resource's current state (e.g. an invalid status
 * transition, or the last-admin protections) → 409 with the given detail. A conflict a client
 * must tell apart from the rest names its RFC 7807 [problemType] (a `urn:astrolabe:problem:…` URI) and,
 * optionally, the [instance] it collides with; both default to the plain `about:blank` problem.
 * Open so a feature can subclass it with its own typed payload (`ingest/DataSourceScope.kt`). A conflict that is data, not just text,
 * carries it as an RFC 7807 extension member: [cycle] (the dependency-cycle problem names the entities it would close).
 */
open class ConflictException(
    message: String = "Conflict",
    val problemType: String = "about:blank",
    val instance: String? = null,
    val cycle: List<ProblemCycleNode>? = null,
) : RuntimeException(message)

/**
 * A `400` a client must tell apart from a malformed request: it names its RFC 7807 [problemType] (a `urn:astrolabe:problem:…` URI), e.g.
 * the id of a baseline the client still holds that is gone (`?baseline=`). Still a [BadRequestException], so a generic catch keeps
 * answering 400; `ErrorHandling` copies [problemType] into the body's `type`.
 */
class TypedBadRequestException(message: String, val problemType: String) : BadRequestException(message)

/**
 * One entity on the cycle a refused dependency would close — the element of `ProblemDetail.cycle`. [kind] is the wire enum name
 * (`MILESTONE` or `PROJECT`); the cycle lists the entities in order with the first one repeated last.
 */
@Serializable
data class ProblemCycleNode(val kind: String, val id: UInt, val name: String)

/**
 * Caller-specific throttling (e.g. the per-account login lockout) → 429 with the given detail.
 * Distinct from the per-IP RateLimit plugin's bodiless 429, which the StatusPages
 * `status(TooManyRequests)` handler completes with a generic problem body.
 */
class TooManyRequestsException(message: String = "Too many requests") : RuntimeException(message)

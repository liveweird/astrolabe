package ch.nokillswit.plugins

import ch.nokillswit.authz.ProblemCycleNode
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.withCharset
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.path
import io.ktor.server.response.respond
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * RFC 7807 problem detail. Serialized as `application/problem+json`.
 *
 * `type` defaults to `about:blank`, in which case `title` is the standard reason phrase for
 * `status` (per the RFC). `detail` is the occurrence-specific message. [cycle] is an RFC 7807 extension member, present only on
 * `urn:astrolabe:problem:dependency-cycle` (omitted otherwise, `explicitNulls = false`): the entities the refused link would close.
 */
@Serializable
data class ProblemDetail(
    val type: String = "about:blank",
    val title: String,
    val status: Int,
    val detail: String? = null,
    val instance: String? = null,
    val cycle: List<ProblemCycleNode>? = null,
)

/** RFC 7807 media type for error bodies. */
val ProblemJson: ContentType = ContentType("application", "problem+json")

private val problemSerializer = Json { encodeDefaults = true; explicitNulls = false }

/**
 * Respond with an RFC 7807 `application/problem+json` body. Goes through [TextContent] explicitly
 * so ContentNegotiation does not relabel it as `application/json`. Usable from anywhere — including
 * the JWT `challenge`, which runs outside [StatusPages].
 */
suspend fun ApplicationCall.respondProblem(
    status: HttpStatusCode,
    detail: String? = null,
    title: String = status.description,
    instance: String? = null,
    type: String = "about:blank",
    cycle: List<ProblemCycleNode>? = null,
) {
    // The occurrence path is useful without reflecting query parameters that may contain secrets.
    val problem = ProblemDetail(
        type = type,
        title = title,
        status = status.value,
        detail = detail ?: status.description,
        instance = instance ?: request.path(),
        cycle = cycle,
    )
    respond(
        TextContent(
            problemSerializer.encodeToString(ProblemDetail.serializer(), problem),
            ProblemJson.withCharset(Charsets.UTF_8),
            status,
        )
    )
}

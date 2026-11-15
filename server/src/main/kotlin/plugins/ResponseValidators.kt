package ch.nokillswit.plugins

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.content.TextContent
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseBodyReadyForSend
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.util.AttributeKey
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.encodeToString

private val ValidatorKey = AttributeKey<String>("ResponseValidator")

/**
 * A route that answers through cache validators (the ten view GETs since 1.22, through [respondRevalidated]; Flow's report GETs were
 * the donor's first consumer) OFFERS its ETag here
 * instead of writing headers: [ResponseValidators] turns the offer into `ETag` + `Cache-Control: no-store` (the owner's decision,
 * `.claude/docs/security.md` "Caching": nothing lands in a browser or proxy cache) only when the call really ends as a `200` or
 * `304`, and only once the body is rendered. A problem response (a `400` from the route, a `500` after the offer, a body that fails
 * to serialize) therefore never carries a validator and stays `no-store`, by construction - response headers cannot be taken back.
 */
fun ApplicationCall.offerValidator(etag: String) {
    attributes.put(ValidatorKey, etag)
}

/**
 * The validator to write on THIS outgoing answer, or null: the offered tag ([offerValidator]) when [content] is not a problem
 * document and the call really ends `200`/`304`. The ONE expression for both decisions that must agree - [ResponseValidators] writes
 * the tag and its `no-store` only when this is non-null, and `Http.kt` leaves out the blanket `no-store` exactly then (otherwise the
 * `200` would carry two `Cache-Control` headers, or - the other way round - none). The status is the CONTENT's own when it has one
 * (it is what goes on the wire), else the call's, else `200`; both callers pass the content they were handed, so a route that offers
 * a tag with content carrying its own non-200 status can never lose its `Cache-Control`.
 */
internal fun ApplicationCall.validatorFor(content: OutgoingContent): String? {
    val etag = attributes.getOrNull(ValidatorKey) ?: return null
    val status = content.status ?: response.status() ?: HttpStatusCode.OK
    val problem = content.contentType?.withoutParameters() == ProblemJson
    return etag.takeIf { !problem && (status == HttpStatusCode.OK || status == HttpStatusCode.NotModified) }
}

/** Writes an offered validator (see [offerValidator]) onto a `200`/`304` after the body is rendered, right before it is sent. */
internal val ResponseValidators = createApplicationPlugin("ResponseValidators") {
    // ResponseBodyReadyForSend: the content is final (a serialization failure has already become the problem response), so the
    // status and the content type seen here are what goes on the wire. `Http.kt` installs this BEFORE ContentNegotiation, which is why
    // the earlier `onCallRespond` hook (it ran before the body was rendered) leaked a tag onto a body that then failed to serialize.
    on(ResponseBodyReadyForSend) { call, content ->
        call.validatorFor(content)?.let { etag ->
            call.response.header(HttpHeaders.ETag, etag)
            call.response.header(HttpHeaders.CacheControl, "no-store")
        }
    }
}

private val ENTITY_TAG = Regex("(?:W/)?\"[^\"]*\"")

/** The comma-separated members of an `If-None-Match` line, split only OUTSIDE quotes (an entity-tag may hold a comma), trimmed. */
private fun fieldMembers(line: String): List<String> {
    val members = mutableListOf<String>()
    val current = StringBuilder()
    var quoted = false
    for (ch in line) {
        if (ch == '"') quoted = !quoted
        if (ch == ',' && !quoted) {
            members += current.toString().trim()
            current.clear()
        } else {
            current.append(ch)
        }
    }
    members += current.toString().trim()
    return members
}

/** What a request's `If-None-Match` says about the current ETag. */
internal enum class IfNoneMatch {
    /** No header, or none of the listed entity-tags matches. */
    NO_MATCH,

    /** A listed entity-tag matches WEAKLY (the opaque tags are equal, the `W/` prefix ignored): RFC 9110 section 13.1.2. */
    TAG_MATCH,

    /** The `*` wildcard: true only if a current representation exists, i.e. only once the view itself has succeeded. */
    ANY,
}

/**
 * Flow's `ifNoneMatch` (ported, parsed more strictly): RFC 9110 weak comparison over every header line, lists and `*`; a listed tag
 * wins over `*`. A member counts only as a whole: `W/"x"` or `"x"` (the `W/` is case-sensitive: `w/"x"` is no entity-tag) or exactly
 * `*`, so a `*` or a comma inside a quoted tag (`"a,*,b"`) is never a wildcard.
 */
internal fun ifNoneMatch(headerLines: List<String>?, etag: String): IfNoneMatch {
    val ours = etag.removePrefix("W/")
    val members = headerLines.orEmpty().flatMap(::fieldMembers)
    return when {
        members.any { ENTITY_TAG.matches(it) && it.removePrefix("W/") == ours } -> IfNoneMatch.TAG_MATCH
        members.any { it == "*" } -> IfNoneMatch.ANY
        else -> IfNoneMatch.NO_MATCH
    }
}

/**
 * A view's ETag: a WEAK validator (`W/"<base64url sha256, 43 characters>"`; weak because the same document may travel compressed or
 * not) over the caller's [userId], a line feed and the document's [json] text exactly as it is sent. The tag is a hash of the ANSWER,
 * so it changes whenever the document does (a renamed team, a grant, a login link, a clock) with no list of inputs to keep complete;
 * the user id keeps one login's tag from ever matching another's.
 */
internal fun bodyEtag(userId: UInt, json: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update("$userId\n".toByteArray(Charsets.UTF_8))
    digest.update(json.toByteArray(Charsets.UTF_8))
    return "W/\"${Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest())}\""
}

/**
 * Answers a view: renders [body] with the application's own [ApiJson] (the very instance `ContentNegotiation` uses, so the document's
 * text is what `call.respond(body)` renders), offers the tag of that text ([bodyEtag]) and answers `304` with no body when the
 * request's `If-None-Match` lists it (or is `*`: the view has succeeded, so a representation exists); otherwise `200` with the text
 * that was hashed. Deliberately NOT content-negotiated: the answer is always `application/json` in UTF-8 (RFC 8259), whatever
 * `Accept-Charset` says (the plain path would have honoured `iso-8859-1`; the tag must hash the bytes that travel, so there is one
 * encoding). The view's work has already run: the `304` saves the transfer, not the computation. Authentication, the parameters
 * and the view's own `404`/`400` all come BEFORE this call, so a refused request is never a `304`; the headers are written by
 * [ResponseValidators] onto a call that really ends `200`/`304`. Reified so a generic document keeps its type arguments.
 */
internal suspend inline fun <reified T : Any> ApplicationCall.respondRevalidated(userId: UInt, body: T) {
    val text = ApiJson.encodeToString(body)
    val etag = bodyEtag(userId, text)
    offerValidator(etag)
    if (ifNoneMatch(request.headers.getAll(HttpHeaders.IfNoneMatch), etag) == IfNoneMatch.NO_MATCH) {
        respond(HttpStatusCode.OK, TextContent(text, ContentType.Application.Json))
    } else {
        respond(HttpStatusCode.NotModified)
    }
}

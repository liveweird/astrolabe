package ch.nokillswit.infra.fetch

import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.utils.io.readAvailable
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromStream
import org.slf4j.LoggerFactory

// Reading and parsing one response body for `SourceHttp` (split out of `SourceHttp.kt` to keep it under the source-file size cap).

// Named explicitly: the lines logged here keep the logger of `SourceHttp` (the transport this was split from).
private val log = LoggerFactory.getLogger("ch.nokillswit.infra.fetch.SourceHttp")

private const val READ_BUFFER_SIZE = 8_192

/** The failure code of a status the transport does not otherwise interpret (a caller's `statusCodeOverrides` win over it). */
internal fun codeForStatus(status: Int): String = when (status) {
    401 -> "AUTHENTICATION_FAILED"
    403 -> "FORBIDDEN_SCOPE"
    404 -> "NOT_FOUND"
    in 300..399 -> "REDIRECT"
    else -> "INVALID_RESPONSE"
}

/** Reads the body of [response] into memory, failing `LIMIT_EXCEEDED` the moment it passes [maxResponseBytes]. */
internal suspend fun readBoundedBody(response: HttpResponse, source: FetchSource, maxResponseBytes: Long): ByteArray {
    val channel = response.bodyAsChannel()
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(READ_BUFFER_SIZE)
    var total = 0L
    while (true) {
        val count = channel.readAvailable(buffer)
        if (count == -1) break
        total += count
        if (total > maxResponseBytes) throw FetchException(source, "LIMIT_EXCEEDED", response.status.value, null)
        output.write(buffer, 0, count)
    }
    // A one-shot answer (GET /field) cannot be halved: one past half the cap is the operator's early warning to raise it.
    if (total > maxResponseBytes / 2) {
        log.warn(
            "A {} response passed half of {}: {} of {} bytes", source.label, source.maxResponseBytesSetting, total, maxResponseBytes,
        )
    }
    return output.toByteArray()
}

// Parsed straight from the bytes: no decoded String (8-16 MiB of UTF-16 for a big body) is ever held beside the tree. A malformed or
// truncated body, or text after the document, throws a SerializationException (an IOException would be caught the same way).
@OptIn(ExperimentalSerializationApi::class)
internal fun parseJsonBody(bytes: ByteArray, source: FetchSource, status: Int, url: String): JsonElement = try {
    Json.decodeFromStream<JsonElement>(ByteArrayInputStream(bytes))
} catch (cause: Exception) {
    throw FetchException(source, "INVALID_RESPONSE", status, url).also { it.initCause(cause) }
}

package ch.nokillswit.plugins

import io.ktor.server.application.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import kotlinx.serialization.json.Json

/**
 * The application's one `Json` (Ktor's default configuration). `ContentNegotiation` renders with it and so does
 * `respondRevalidated` (`ResponseValidators.kt`), which must hash the very text it sends - change it here, nowhere else.
 */
internal val ApiJson: Json = DefaultJson

fun Application.configureSerialization() {
    install(ContentNegotiation) {
        json(ApiJson)
    }
}

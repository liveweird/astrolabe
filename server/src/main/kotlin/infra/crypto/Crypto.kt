package ch.nokillswit.infra.crypto

import io.ktor.server.application.*
import io.ktor.util.AttributeKey

val FieldCipherKey = AttributeKey<FieldCipher>("FieldCipher")

/**
 * The committed dev-only default for `security.encryption.key` (must match the literal in
 * application.yaml). Public, thus burned: production startup refuses it.
 */
internal const val DEV_DATA_ENCRYPTION_KEY =
    "ef9b766b3b3dc805220826e796b1b907d7b7fb55048940e1b730af61b7f17aa4"

/** The docker-compose.yaml demo value — likewise committed, likewise burned. */
internal const val COMPOSE_DATA_ENCRYPTION_KEY =
    "d68246b14fd596319e5f3ee40be4d3ded6f53cd873a1285df6a53950de4c5126"

/**
 * The donor Flow's committed docker-compose.yaml demo key — public in that repository, so burned here too: an
 * operator who reuses Flow's `.env` or k8s secret must not boot Astrolabe in production with it.
 */
internal const val DONOR_COMPOSE_DATA_ENCRYPTION_KEY =
    "384d2d8bbba13a255d5de897de4fa2d7c3029d0563b7a3a1a3a76437861adfca"

/**
 * Builds the [FieldCipher] used for application-level encryption of sensitive columns at rest
 * (e.g. a future stored integration credential) and publishes it as [FieldCipherKey]. Registered in
 * application.yaml right after configureMail and BEFORE configureDatabase, so the composition
 * root can hand it to any service owning encrypted columns.
 *
 * Mirrors the JWT-secret fail-closed check in plugins/Security.kt (one check per concern file):
 * a blank or publicly known (repo-committed) key is allowed with a loud warning in development
 * and refuses to start in production. A malformed key (wrong length / not hex) fails startup
 * in ANY mode — it cannot encrypt at all — which is also what the k8s template placeholder
 * `CHANGE-ME-openssl-rand-hex-32` does by construction (it is not 64 hex characters).
 */
fun Application.configureCrypto() {
    val keyHex = environment.config.property("security.encryption.key").getString()
    val previousKeyHex = environment.config
        .propertyOrNull("security.encryption.previousKey")?.getString()?.takeIf { it.isNotBlank() }

    val burnedKeys = setOf(DEV_DATA_ENCRYPTION_KEY, COMPOSE_DATA_ENCRYPTION_KEY, DONOR_COMPOSE_DATA_ENCRYPTION_KEY)
    if (keyHex.isBlank() || keyHex in burnedKeys) {
        val message =
            "Data encryption key is unset or a publicly known value — stored credentials are not " +
                "confidential against a database-level attacker. Set a strong, private " +
                "DATA_ENCRYPTION_KEY (openssl rand -hex 32)."
        if (developmentMode) log.warn("$message (permitted in development only)")
        else error(message)
    }
    // Rotating away from a burned key may leave it as previousKey — decrypt-only, so acceptable
    // in any mode (a re-encrypt backfill, ported later from Flow, rewrites rows under the current key).
    attributes.put(FieldCipherKey, FieldCipher(keyHex, previousKeyHex))
}

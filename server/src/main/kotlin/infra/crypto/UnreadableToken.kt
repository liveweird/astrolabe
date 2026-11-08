package ch.nokillswit.infra.crypto

import java.security.GeneralSecurityException
import org.slf4j.Logger

/**
 * The ONE unreadable-token rule (`security.md` "Encryption at rest"): a stored credential envelope that cannot be opened (a changed
 * `DATA_ENCRYPTION_KEY`, a corrupt or truncated envelope) reads as `null`, never as an exception, so every caller answers its own typed
 * "re-enter the token" outcome instead of a 500. A `null` envelope (a CHECK-bypassed row) reads as unreadable too.
 *
 * The WARN names the connection id and the exception CLASS only: a decrypt failure's message can name the cipher's internals, and the
 * envelope is never logged (`security.md` "Log hygiene"). `label` completes "The stored {label} connection {id} cannot be decrypted",
 * e.g. "API token of Jira" (the sentence `security.md`'s recovery steps quote; `JiraImportDecryptOrderTest` pins "connection {id} cannot
 * be decrypted").
 */
fun FieldCipher.decryptOrNull(envelope: String?, log: Logger, label: String, connectionId: UInt): String? = try {
    envelope?.let(::decrypt)
} catch (cause: GeneralSecurityException) {
    logUnreadable(log, label, connectionId, cause)
} catch (cause: IllegalArgumentException) {
    logUnreadable(log, label, connectionId, cause)
}

private fun logUnreadable(log: Logger, label: String, connectionId: UInt, cause: Exception): String? {
    log.warn("The stored {} connection {} cannot be decrypted ({})", label, connectionId, cause.javaClass.simpleName)
    return null
}

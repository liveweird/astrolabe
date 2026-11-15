package ch.nokillswit.users

import ch.nokillswit.auth.MAX_PASSWORD_BYTES
import ch.nokillswit.auth.exceedsBcryptLimit
import io.ktor.server.plugins.BadRequestException

internal const val MAX_NAME_LENGTH = 50
internal const val MAX_EMAIL_LENGTH = 254

internal fun validateEmail(email: String) {
    if (email.isBlank()) throw BadRequestException("Email must not be blank")
    if (email.length > MAX_EMAIL_LENGTH) {
        throw BadRequestException("Email must be at most $MAX_EMAIL_LENGTH characters")
    }
    if ('@' !in email) throw BadRequestException("Email must contain '@'")
    if (email.any { it.isISOControl() }) {
        throw BadRequestException("Email must not contain control characters")
    }
}

/** The user language (V1) when provided: must be a supported code. Null = default. */
internal fun validateLanguage(language: String?) {
    if (language != null && language !in SUPPORTED_LANGUAGES) {
        throw BadRequestException("Unsupported language (supported: ${SUPPORTED_LANGUAGES.joinToString()})")
    }
}

internal fun validateNameAndEmail(name: String, email: String) {
    if (name.isBlank()) throw BadRequestException("Name must not be blank")
    if (name.length > MAX_NAME_LENGTH) {
        throw BadRequestException("Name must be at most $MAX_NAME_LENGTH characters")
    }
    validateEmail(email)
}

/** Shared password rule for create, change, reset and bootstrap: the minimum plus bcrypt's byte ceiling. */
internal fun validatePassword(password: String) {
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw BadRequestException("Password must be at least $MIN_PASSWORD_LENGTH characters")
    }
    // Longer input would make bcrypt throw (a 500) — see MAX_PASSWORD_BYTES in auth/Passwords.kt.
    if (exceedsBcryptLimit(password)) {
        throw BadRequestException("Password must be at most $MAX_PASSWORD_BYTES bytes in UTF-8")
    }
}

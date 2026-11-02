package ch.nokillswit.infra.validation

import io.ktor.server.plugins.BadRequestException

/** Hangul/halfwidth fillers and the blank Braille pattern: not FORMAT characters, yet they render as nothing. */
private val INVISIBLE_FILLERS = setOf('\u115F', '\u1160', '\u3164', '\uFFA0', '\u2800')

/** Whitespace, a Unicode format character (zero-width space/joiners, BOM, bidi marks) or an invisible filler. */
private fun Char.isInvisible(): Boolean = isWhitespace() || category == CharCategory.FORMAT || this in INVISIBLE_FILLERS

/**
 * Canonical single-line identity fields (names and the like): trimmed, and control characters
 * are a clean 400 instead of stored garbage. Ported from Lettuce. A value made only of invisible
 * characters (e.g. U+200B) comes back empty, so every caller's blank check refuses it.
 */
fun sanitizeSingleLine(value: String, field: String): String {
    val trimmed = value.trim()
    if (trimmed.any { it.isISOControl() }) {
        throw BadRequestException("$field must not contain control characters")
    }
    return if (trimmed.all { it.isInvisible() }) "" else trimmed
}

/** The optional description every registry carries: trimmed, control characters a 400, blank = absent. */
fun sanitizedDescription(raw: String?): String? = raw?.let { sanitizeSingleLine(it, "Description") }?.takeIf { it.isNotBlank() }

/** The name/description length rule every registry enforces — one wording, so the SPA's messages never drift per area. */
fun requireNameAndDescription(name: String, description: String?, maxName: Int, maxDescription: Int) {
    if (name.isBlank() || name.length > maxName) throw BadRequestException("Name must be 1-$maxName characters")
    if (description != null && description.length > maxDescription) {
        throw BadRequestException("Description must be at most $maxDescription characters")
    }
}

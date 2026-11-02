package ch.nokillswit

import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import io.ktor.server.plugins.BadRequestException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class TextSanitizeTest {
    @Test
    fun `invisible-only values collapse to empty`() {
        for (raw in listOf("​", "‌‍", "﻿", "⁠", "‮", " ㅤ ", "ᅟᅠ", "ﾠ", "⠀", " ")) {
            assertEquals("", sanitizeSingleLine(raw, "Name"), "expected empty for ${raw.map { "U+%04X".format(it.code) }}")
        }
        assertNull(sanitizedDescription("​"))
    }

    @Test
    fun `visible text keeps its inner invisible characters and is trimmed`() {
        assertEquals("a‍b", sanitizeSingleLine("  a‍b  ", "Name"))
        assertEquals("Zespół", sanitizeSingleLine("Zespół", "Name"))
    }

    @Test
    fun `control characters stay a 400`() {
        assertFailsWith<BadRequestException> { sanitizeSingleLine("a\tb", "Name") }
    }
}

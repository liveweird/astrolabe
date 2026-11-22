package ch.nokillswit

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Kover excludes `@Serializable` classes because their generated serializers and default-argument masks add synthetic branches that
 * application tests cannot meaningfully exercise. Handwritten behavior must therefore live in a measured top-level function or plain
 * class. Secret-masking `toString` overrides are the one exception: they must stay on the data class and [SecretToStringTest] pins them.
 */
class SerializableDtoBehaviorTest {
    @Test
    fun `serializable declarations contain no coverage-hidden behavior except secret masking`() {
        val root = Path.of(System.getProperty("repo.root"), "server/src/main/kotlin")
        val findings = Files.walk(root).use { paths ->
            paths.filter { Files.isRegularFile(it) && it.extension == "kt" }
                .flatMap { file -> serializableBehavior(file.readText()).map { "${root.relativize(file)}:$it" }.stream() }
                .sorted()
                .toList()
        }
        assertEquals(emptyList(), findings)
    }

    @Test
    fun `the source guard distinguishes DTO shape, hidden behavior, nested declarations and the masking exception`() {
        val source = """
            @Serializable
            data class Plain(
                val value: String,
            )

            @Serializable
            data class Hidden(val value: String) {
                fun normalized() = value.trim()
                val present: Boolean get() = value.isNotEmpty()
                val enabled: Boolean
                    get() = present
            }

            @Serializable
            data class Masked(val secret: String) {
                override fun toString(): String = "Masked(secret=***)"
            }

            @Serializable
            class Routes {
                @Serializable
                class Id(val parent: Routes = Routes(), val id: UInt)
            }

            fun Plain.normalized() = value.trim()
        """.trimIndent()

        assertEquals(
            listOf("Hidden:8 fun normalized", "Hidden:9 val present", "Hidden:10 val enabled"),
            serializableBehavior(source),
        )
    }
}

/**
 * The deliberately small parser recognizes this repository's declaration style instead of pretending to parse arbitrary Kotlin. It
 * ignores comments and quoted text, follows multiline primary constructors, and inspects only the serializable class's own body (not a
 * nested route class or companion). [SerializableDtoBehaviorTest] pins representative accepted and refused shapes above.
 */
private fun serializableBehavior(source: String): List<String> {
    val clean = kotlinStructureLines(source.lines())
    val findings = mutableListOf<String>()
    var serializablePending = false
    var index = 0
    while (index < clean.size) {
        val line = clean[index].trim()
        if (line == "@Serializable" || line == "@kotlinx.serialization.Serializable") {
            serializablePending = true
            index++
            continue
        }
        val declaration = if (serializablePending) CLASS_DECLARATION.find(line) else null
        if (declaration == null) {
            if (serializablePending && line.isNotEmpty() && !line.startsWith('@')) serializablePending = false
            index++
            continue
        }
        serializablePending = false
        val name = declaration.groupValues[1]
        val body = findSerializableBody(clean, index, name)
        if (body == null) {
            index++
            continue
        }
        findings += scanSerializableBody(clean, body)
        index = body.endLine
    }
    return findings
}

private data class SerializableBody(val name: String, val firstLine: Int, val endLine: Int, val initialDepth: Int)

private fun findSerializableBody(clean: List<String>, declarationLine: Int, name: String): SerializableBody? {
    var line = declarationLine
    var parentheses = clean[line].count { it == '(' } - clean[line].count { it == ')' }
    var opening = clean[line].indexOf('{')
    while (opening < 0 && parentheses > 0 && line + 1 < clean.size) {
        line++
        parentheses += clean[line].count { it == '(' } - clean[line].count { it == ')' }
        if (parentheses == 0) opening = clean[line].indexOf('{')
    }
    if (opening < 0) return null
    val remainder = clean[line].substring(opening + 1)
    val initialDepth = 1 + remainder.count { it == '{' } - remainder.count { it == '}' }
    var endLine = line + 1
    var depth = initialDepth
    while (endLine < clean.size && depth > 0) {
        depth += clean[endLine].count { it == '{' } - clean[endLine].count { it == '}' }
        endLine++
    }
    return SerializableBody(name, line + 1, endLine, initialDepth)
}

private fun scanSerializableBody(clean: List<String>, serializable: SerializableBody): List<String> {
    val findings = mutableListOf<String>()
    var depth = serializable.initialDepth
    var bodyLine = serializable.firstLine
    while (bodyLine < serializable.endLine && depth > 0) {
        val body = clean[bodyLine]
        val trimmed = body.trim()
        if (depth == 1) {
            val function = FUNCTION.find(trimmed)
            if (function != null && !(function.groupValues[1] == "override " && function.groupValues[2] == "toString")) {
                findings += "${serializable.name}:${bodyLine + 1} fun ${function.groupValues[2]}"
            }
            val property = PROPERTY.find(trimmed)
            if (property != null) {
                findings += "${serializable.name}:${bodyLine + 1} ${property.groupValues[1]} ${property.groupValues[2]}"
            }
            if (INIT.matches(trimmed)) findings += "${serializable.name}:${bodyLine + 1} init"
        }
        depth += body.count { it == '{' } - body.count { it == '}' }
        bodyLine++
    }
    return findings
}

private fun kotlinStructureLines(lines: List<String>): List<String> {
    var inBlockComment = false
    return lines.map { source ->
        val out = StringBuilder()
        var index = 0
        var quote: Char? = null
        while (index < source.length) {
            val current = source[index]
            val next = source.getOrNull(index + 1)
            when {
                inBlockComment && current == '*' && next == '/' -> {
                    inBlockComment = false
                    index += 2
                }
                inBlockComment -> index++
                quote != null && current == '\\' -> index += 2
                quote != null && current == quote -> {
                    quote = null
                    index++
                }
                quote != null -> index++
                current == '/' && next == '*' -> {
                    inBlockComment = true
                    index += 2
                }
                current == '/' && next == '/' -> index = source.length
                current == '"' || current == '\'' -> {
                    quote = current
                    out.append("''")
                    index++
                }
                else -> {
                    out.append(current)
                    index++
                }
            }
        }
        out.toString()
    }
}

private val CLASS_DECLARATION = Regex("(?:data\\s+)?(?:enum\\s+)?class\\s+(\\w+)")
private val FUNCTION = Regex("^(override\\s+)?(?:suspend\\s+)?fun\\s+(\\w+)")
private val PROPERTY = Regex("^(val|var)\\s+(\\w+)")
private val INIT = Regex("^init\\s*\\{")

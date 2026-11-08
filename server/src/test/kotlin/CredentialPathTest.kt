package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The credential path of an encrypted token column (`security.md` "Encryption at rest"), pinned by a plain source scan of
 * `server/src/main/kotlin` (no Docker, the `PackageBoundaryTest` idiom: non-comment lines, `file:line` offenders):
 *
 * 1. a raw `FieldCipher.decrypt` is called only by the unreadable-token rule and the re-encrypt backfill (plus its own definition);
 * 2. `decryptOrNull` is called only by the two connection services, whose few decrypting methods are the promise's subject;
 * 3. the scheduler's poll-row selections and everything under `sync/` never name the token column.
 *
 * Each rule first proves the scan can see what it guards (the allowed callers really contain the call), so an empty offender list
 * cannot mean a pattern that matches nothing.
 */
class CredentialPathTest {
    private val root: File by lazy {
        File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
            .also { assertTrue(it.isDirectory, "${it.absolutePath} not found") }
    }

    private val sources: Map<String, List<String>> by lazy {
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readLines() }
            .also { assertTrue(it.size > 100, "the scan saw only ${it.size} sources") }
    }

    private fun isComment(line: String): Boolean = line.trimStart().let { it.startsWith("//") || it.startsWith("*") || it.startsWith("/*") }

    /** `path:line: code` of every non-comment line of the sources selected by [inFile] that matches [pattern]. */
    private fun hits(pattern: Regex, inFile: (String) -> Boolean = { true }, includeComments: Boolean = false): List<String> =
        sources.filterKeys(inFile).flatMap { (path, lines) ->
            lines.withIndex()
                .filter { (_, line) -> (includeComments || !isComment(line)) && pattern.containsMatchIn(line) }
                .map { (index, line) -> "$path:${index + 1}: ${line.trim()}" }
        }

    private fun assertNone(offenders: List<String>, promise: String) =
        assertTrue(offenders.isEmpty(), "$promise - offending file:line:\n${offenders.joinToString("\n")}")

    private fun files(offenders: List<String>): Set<String> = offenders.map { it.substringBefore(':') }.toSet()

    private val token = Regex("""apiToken|api_token""", RegexOption.IGNORE_CASE)

    // `decrypt(` as a bare or qualified call or definition (not `decryptOrNull(` / `decryptWith(`, which the `\(` right after rules out)
    // and the `::decrypt` method reference (`\b` rules out `::decryptOrNull`).
    private val rawDecrypt = Regex("""(?<![A-Za-z0-9_])decrypt\(|::decrypt\b""")

    @Test
    fun `a raw FieldCipher decrypt is called only by UnreadableToken and Reencrypt`() {
        val offenders = hits(rawDecrypt)
        val allowed = setOf("infra/crypto/UnreadableToken.kt", "infra/crypto/Reencrypt.kt", "infra/crypto/FieldCipher.kt")
        assertTrue(files(offenders).containsAll(allowed), "the scan must see the definition and both sanctioned callers")
        assertNone(
            offenders.filter { it.substringBefore(':') !in allowed },
            "security.md 'Encryption at rest': a credential is decrypted only via decryptOrNull (UnreadableToken.kt) or the boot backfill",
        )
    }

    @Test
    fun `decryptOrNull is called only by the Jira and Flow connection services`() {
        val use = Regex("""\bdecryptOrNull\b""")
        // The import and the definition are not calls.
        val calls = hits(use).filterNot { it.substringAfter(": ").let { code -> code.startsWith("import ") || code.startsWith("fun ") } }
        val allowed = setOf("jira/JiraConnectionService.kt", "flow/FlowConnectionService.kt")
        assertTrue(files(calls).containsAll(allowed), "the scan must see both sanctioned callers")
        assertNone(
            calls.filter { it.substringBefore(':') !in allowed },
            "security.md 'Encryption at rest': only the connection services' decrypting methods (readForTest/Peek/Bind/Run) open a token",
        )
    }

    @Test
    fun `the scheduler poll-row selections never name the token`() {
        val polling = setOf("jira/JiraConnectionPolling.kt", "flow/FlowConnectionPolling.kt")
        assertTrue(polling.all { it in sources }, "a poll-row file moved: $polling")
        assertNone(
            hits(token, inFile = { it in polling }, includeComments = true),
            "security.md 'Encryption at rest': the scheduler's poll-row selection never names the token column",
        )
    }

    @Test
    fun `sync never names the token`() {
        val syncFiles = sources.keys.filter { it.startsWith("sync/") }
        assertTrue(syncFiles.size > 3, "the scan saw only ${syncFiles.size} sources of sync/")
        assertNone(
            hits(token, inFile = { it.startsWith("sync/") }, includeComments = true),
            "security.md 'Encryption at rest': sync/ (runnableStateOf, pollRowsOf) never names the credential column, comments included",
        )
    }
}

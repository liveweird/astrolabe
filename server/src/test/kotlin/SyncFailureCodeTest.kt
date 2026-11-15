package ch.nokillswit

import ch.nokillswit.flow.FlowRunCodes
import ch.nokillswit.infra.fetch.FetchCodes
import ch.nokillswit.jira.JiraRunCodes
import ch.nokillswit.sync.SyncErrorCodes
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.users.UserRole
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import java.io.File
import java.lang.reflect.Modifier
import java.util.concurrent.ThreadLocalRandom
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The failure codes of runs and test rows are ONE declared list: the spec's `SyncFailureCode`. The four Kotlin objects that hold the
 * values (`FetchCodes`, `SyncErrorCodes`, `JiraRunCodes`, `FlowRunCodes`) add up to exactly that enum, no call site names a code by a
 * literal (nor does any other upper-snake literal appear outside a declared code or a listed non-code), and a stored row of every
 * code is served and validates against the spec (the conformance client). Nothing validates a code on READ: an unknown stored code is
 * served as it is.
 */
class SyncFailureCodeTest {
    private val connections = mutableListOf<Int>()

    @AfterTest
    fun cleanup() {
        connections.forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it) }
        connections.clear()
    }

    private val objects: List<Pair<String, Class<*>>> = listOf(
        "FetchCodes" to FetchCodes::class.java,
        "SyncErrorCodes" to SyncErrorCodes::class.java,
        "JiraRunCodes" to JiraRunCodes::class.java,
        "FlowRunCodes" to FlowRunCodes::class.java,
    )

    /** Every `const val` String of [type]: the compiler publishes it as a static field of the object's class. */
    private fun constantsOf(type: Class<*>): List<Pair<String, String>> =
        type.declaredFields.filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }.map {
            it.isAccessible = true
            it.name to it.get(null) as String
        }

    private val declared: List<String> by lazy { objects.flatMap { (_, type) -> constantsOf(type).map { it.second } } }

    private val specEnum: List<String> by lazy {
        val schema = assertNotNull(OpenApiSpec.parsed.components.schemas["SyncFailureCode"], "SyncFailureCode schema")
        schema.enum.filterNotNull().map { it.toString() }
    }

    private val mainSources: List<File> by lazy {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        listOf("sync", "jira", "flow", "infra/fetch").flatMap { dir ->
            File(root, dir).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        }
    }

    @Test
    fun `the four constant objects add up to exactly the spec's enum`() {
        assertEquals(declared.size, declared.toSet().size, "a code is declared once: $declared")
        assertEquals(specEnum.sorted(), declared.sorted(), "the four objects must add up to SyncFailureCode")
        assertEquals(25, specEnum.size)
        // A constant is named as its value (a typo in either would read as two codes).
        for ((name, type) in objects) {
            constantsOf(type).filter { (constant, _) -> constant != "DEADLINE" }.forEach { (constant, value) ->
                assertEquals(constant, value, "$name.$constant")
            }
        }
        assertEquals("RUN_DEADLINE", SyncErrorCodes.DEADLINE)
    }

    @Test
    fun `the four wire members reference the one schema, and the column fits the longest code`() {
        val reference = "{ \$ref: '#/components/schemas/SyncFailureCode' }"
        val member = Regex("""^\s+(errorCode|code): ${Regex.escape(reference)}$""", RegexOption.MULTILINE)
        val users = member.findAll(OpenApiSpec.rawYaml).toList()
        assertEquals(4, users.size, "SyncRun.errorCode, SyncLastRun.errorCode, JiraTestRow.code and FlowTestRow.code")
        assertEquals(4, OpenApiSpec.rawYaml.split("schemas/SyncFailureCode'").size - 1, "no other member names the schema")
        assertTrue(declared.maxOf { it.length } <= 40, "sync_runs.error_code is a VARCHAR(40)")
    }

    @Test
    fun `no main source hands a string literal to FetchException, RunProblem, SyncResult failed or ProbeFailure`() {
        val callee = """FetchException\(\s*[^,()]+,\s*|RunProblem\(\s*|SyncResult\.failed\(\s*|ProbeFailure\(\s*"""
        val calls = Regex("""($callee)(if \([^)]*\)\s*)?"""")
        val offenders = mainSources.flatMap { file ->
            calls.findAll(file.readText()).map { "${file.name}: ${it.value.trim()}" }.toList()
        }
        assertEquals(emptyList(), offenders, "a code is a constant of one of the four objects, never a literal")
    }

    /**
     * The upper-snake string literals of the four packages that are NOT failure codes, each with its meaning. A new literal of this shape
     * is either a code (declared in its object and in the spec) or a deliberate entry here; every entry must still occur in the sources.
     */
    private val notCodes = mapOf(
        "CONFIGURED" to "a capacity figure's source (a configured figure) in the Flow capacity import",
        "TEAM_DEFAULT" to "a capacity figure's source (the team's default) in the Flow capacity import",
        "DELETED" to "a Jira binding's wire goneReason: the issue is gone from Jira",
        "FORBIDDEN" to "a Jira binding's wire goneReason: the connection's account may not read the issue",
        "MOVED_OUT" to "a Jira binding's wire goneReason: the issue moved out of the connection's projects",
        "NOT_LISTED" to "a Jira binding's wire goneReason: Jira has the issue but the listing no longer returns it",
        "OUT_OF_SCOPE" to "the stored gone_reason of a binding the sweep found out of scope",
        "NODE_GONE" to "the reason (audit, response) of a binding released because its plan node was deleted",
        "TEAM_GONE" to "the reason of a Flow team binding released because its Astrolabe team was deleted",
        "UNLINKED" to "the reason of a Flow team binding released by an explicit unlink",
        "DONE" to "the status category a Jira coverage row counts as finished",
        "UNCHECKED_CAST" to "the argument of a justified @Suppress in SourceHttp",
    )

    @Test
    fun `every upper-snake literal is a declared code in its own object's file, or a listed non-code`() {
        val literal = Regex(""""[A-Z][A-Z0-9_]{3,}"""")
        val ownerFile = objects.flatMap { (name, type) -> constantsOf(type).map { (_, value) -> value to "$name.kt" } }.toMap()
        val seen = mutableSetOf<String>()
        val offenders = mainSources.flatMap { file ->
            literal.findAll(file.readText()).map { it.value.trim('"') }.mapNotNull { value ->
                seen += value
                when {
                    value in ownerFile ->
                        if (ownerFile.getValue(value) == file.name) null else "${file.name}: \"$value\" belongs in ${ownerFile[value]}"
                    value in notCodes -> null
                    else -> "${file.name}: \"$value\" is neither a declared code nor a listed non-code"
                }
            }.toList()
        }
        assertEquals(emptyList(), offenders)
        assertEquals(emptyList(), notCodes.keys.filter { it !in seen }, "a listed non-code no longer occurs: drop it")
        assertEquals(emptyList(), declared.filter { it !in seen }, "a declared code occurs in no source")
    }

    @Test
    fun `a run of every code is served and validates against the spec, and an unknown stored code is served as it is`() {
        val connectionId = ThreadLocalRandom.current().nextInt(1_000_000, Int.MAX_VALUE).also { connections += it }
        declared.forEachIndexed { index, code ->
            jbSql(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome, error_code) " +
                    "VALUES ('FLOW', ?, 'MANUAL', ?, ?, 'FAILED', ?)",
                connectionId, 1_800_000_000_000L + index, 1_800_000_000_100L + index, code,
            )
        }
        var served: List<String?> = emptyList()
        testApplication {
            configureApp()
            startApplication()
            val admin = seededClient("failcodes", UserRole.ADMIN)
            val response = admin.get("$SYNC_RUNS?kind=FLOW&connectionId=$connectionId")
            assertEquals(HttpStatusCode.OK, response.status)
            served = jbJson.decodeFromString<SyncRunList>(response.bodyAsText()).items.map { it.errorCode }
        }
        assertEquals(declared.sorted(), served.filterNotNull().sorted(), "every code of the list comes back as it was stored")
        // The registry never validates on read: a code only an older or newer build wrote is served, not dropped or rewritten.
        val legacy = ThreadLocalRandom.current().nextInt(1_000_000, Int.MAX_VALUE).also { connections += it }
        jbSql(
            "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome, error_code) " +
                "VALUES ('JIRA', ?, 'MANUAL', 1800000000000, 1800000000100, 'FAILED', 'SOMETHING_OLDER')",
            legacy,
        )
        val rows = runBlocking { SyncRunService(sharedDatabaseForTests(), 10).list(SyncKind.JIRA, legacy.toUInt()) }
        assertEquals(listOf<String?>("SOMETHING_OLDER"), rows.map { it.errorCode })
    }
}

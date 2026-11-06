package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.jira.JiraConnectionService
import ch.nokillswit.sync.SyncRunService
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.io.File
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The encryption-at-rest boot backfill (`infra/db/Bootstrap.kt`, `Reencrypt.kt`): a registered service's legacy plaintext rows are
 * wrapped once at startup (proven on a throwaway table: V21's `ck_jira_connections_api_token` refuses plaintext in the real one), and
 * while `security.encryption.previousKey` is set EVERY row (soft-deleted included) moves to the current key,
 * each time leaving a `crypto.reencrypted` audit line. The only consumer is `jira_connections.api_token` (V21), whose NULL (a deleted
 * connection's destroyed credential) a rotation skips. The rotation test restores the suite's key afterwards: the table is shared, and its
 * rows must stay readable by the dev-key apps the other tests boot.
 */
class EncryptedAtRestBootTest {
    private val devCipher = FieldCipher(DEV_DATA_ENCRYPTION_KEY)
    // `class A(...) : EncryptedAtRest`, `class A : EncryptedAtRest` and `object A : EncryptedAtRest`; generics and a multi-line header too;
    // no part of the header spans a blank line, so a one-line class declared above the real one cannot swallow it.
    private val noBlankLine = """(?:(?!\n[ \t]*\n)[^{])"""
    private val implementer =
        Regex("""\b(?:class|object)\s+(\w+)\s*(?:<[^>{]*>)?\s*(?:\($noBlankLine*?\))?\s*:\s*$noBlankLine*\bEncryptedAtRest\b""")

    private fun uniqueName(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    /** A row with [storedToken] verbatim: an envelope, or NULL on a deleted row (V21's CHECKs refuse anything else). */
    private fun insertRow(storedToken: String?, deleted: Boolean = false): Int = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement(
            "INSERT INTO jira_connections " +
                "(name, site_url, email, api_token, auth_scheme, project_keys, created_at, updated_at, marked_as_deleted) " +
                "VALUES (?, 'https://sample.atlassian.net', 'legacy@example.test', ?, 'BASIC', '[\"SP\"]'::jsonb, 1, 1, ?) RETURNING id",
        ).use { st ->
            st.setString(1, uniqueName("legacy"))
            st.setString(2, storedToken)
            st.setBoolean(3, deleted)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    private fun storedToken(id: Int): String = checkNotNull(storedTokenOrNull(id)) { "row $id holds no token" }

    private fun storedTokenOrNull(id: Int): String? = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement("SELECT api_token FROM jira_connections WHERE id = ?").use { st ->
            st.setInt(1, id)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
    }

    /** A throwaway table the backfill body can run over: V21's CHECK forbids a plaintext `api_token`, so the wrap is proven here. */
    private class Probe(name: String) : UIntIdTable(name) {
        val secret = text("secret")
    }

    private fun <T> withProbeTable(block: (Probe) -> T): T {
        val probe = Probe("legacy_wrap_${UUID.randomUUID().toString().replace("-", "").substring(0, 12)}")
        PostgresTestSupport.connect().use { c ->
            c.createStatement().use { it.executeUpdate("CREATE TABLE ${probe.tableName} (id SERIAL PRIMARY KEY, secret TEXT NOT NULL)") }
        }
        try {
            return block(probe)
        } finally {
            PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate("DROP TABLE ${probe.tableName}") } }
        }
    }

    private fun Probe.insert(value: String): Int = PostgresTestSupport.connect().use { c ->
        c.prepareStatement("INSERT INTO $tableName (secret) VALUES (?) RETURNING id").use { st ->
            st.setString(1, value)
            st.executeQuery().use { rs -> rs.next(); rs.getInt(1) }
        }
    }

    private fun Probe.stored(id: Int): String = PostgresTestSupport.connect().use { c ->
        c.prepareStatement("SELECT secret FROM $tableName WHERE id = ?").use { st ->
            st.setInt(1, id)
            st.executeQuery().use { rs -> rs.next(); rs.getString(1) }
        }
    }

    private fun wrap(probe: Probe): Int = runBlocking {
        suspendTransaction(sharedDatabaseForTests()) { devCipher.reencryptRows(probe, listOf(probe.secret), reencryptAll = false) }
    }

    @Test
    fun `a legacy plaintext value is wrapped once by the backfill body and an envelope is left byte for byte`() = withProbeTable { probe ->
        val plaintext = "legacy-${UUID.randomUUID()}"
        val legacy = probe.insert(plaintext)
        val enveloped = devCipher.encrypt("already-${UUID.randomUUID()}")
        val alreadyEncrypted = probe.insert(enveloped)

        assertEquals(1, wrap(probe))
        assertTrue(probe.stored(legacy).startsWith(FieldCipher.PREFIX), "the plaintext row is now an envelope")
        assertEquals(plaintext, devCipher.decrypt(probe.stored(legacy)))
        assertEquals(enveloped, probe.stored(alreadyEncrypted), "an enveloped row is left byte for byte as it was")
        // Idempotent: a second pass finds nothing to wrap.
        assertEquals(0, wrap(probe))
    }

    @Test
    fun `a boot with no legacy rows touches no token and writes no audit line`() {
        val enveloped = devCipher.encrypt("already-${UUID.randomUUID()}")
        val row = insertRow(enveloped)
        testApplication {
            configureApp()
            withAuditCapture { capture ->
                startApplication()
                assertTrue(capture.events.none { it.message == "crypto.reencrypted" }, "nothing to wrap, nothing audited")
            }
        }
        assertEquals(enveloped, storedToken(row))
        val database = sharedDatabaseForTests()
        val service = JiraConnectionService(database, devCipher, SyncRunService(database, maxRunMinutes = 10))
        assertEquals(0, runBlocking { service.encryptLegacyRows(reencryptAll = false) })
    }

    @Test
    fun `a rotation re-encrypts every row under the current key, soft-deleted ones included, and the previous key can then go`() {
        val newKey = strongEncryptionKey()
        val newCipher = FieldCipher(newKey)
        val activePlain = "active-${UUID.randomUUID()}"
        val deletedPlain = "deleted-${UUID.randomUUID()}"
        val active = insertRow(devCipher.encrypt(activePlain))
        val deleted = insertRow(devCipher.encrypt(deletedPlain), deleted = true)
        val destroyed = insertRow(null, deleted = true) // a deleted connection's NULL credential: nothing to re-encrypt, nothing to fail
        try {
            testApplication {
                configureApp("security.encryption.key" to newKey, "security.encryption.previousKey" to DEV_DATA_ENCRYPTION_KEY)
                withAuditCapture { capture ->
                    startApplication()
                    val event = assertNotNull(capture.events.singleOrNull { it.message == "crypto.reencrypted" })
                    assertTrue(event.hasKeyValue("rotating", true))
                    val rows = event.keyValuePairs.single { it.key == "rows" }.value as Int
                    assertTrue(rows >= 2, "every row moves, the two of this test at least (saw $rows)")
                    val carriesToken = { text: String -> activePlain in text || deletedPlain in text }
                    assertTrue(
                        capture.events.none { e -> e.keyValuePairs.orEmpty().any { carriesToken(it.value.toString()) } },
                        "the audit lines never carry a token",
                    )
                }
            }
            assertNull(storedTokenOrNull(destroyed), "the rotation left the NULL as it was")
            for ((id, plain) in listOf(active to activePlain, deleted to deletedPlain)) {
                val stored = storedToken(id)
                assertEquals(plain, newCipher.decrypt(stored), "readable under the current key alone")
                assertFailsWith<java.security.GeneralSecurityException>("no longer readable under the previous key") {
                    devCipher.decrypt(stored)
                }
            }
        } finally {
            // Hand every row back to the suite's own key (dev key current, the new one previous), so later tests can still read the table.
            testApplication {
                configureApp("security.encryption.key" to DEV_DATA_ENCRYPTION_KEY, "security.encryption.previousKey" to newKey)
                startApplication()
            }
        }
        assertEquals(activePlain, devCipher.decrypt(storedToken(active)))
        assertEquals(deletedPlain, devCipher.decrypt(storedToken(deleted)))
    }

    @Test
    fun `the implementer scan sees classes, classes without a constructor and objects`() {
        fun found(source: String) = implementer.findAll(source).map { it.groupValues[1] }.toList()
        assertEquals(listOf("A"), found("class A(private val x: Int,\n    val y: String,\n) : EncryptedAtRest {"))
        assertEquals(listOf("B"), found("class B : EncryptedAtRest {"))
        assertEquals(listOf("C"), found("object C : Base(), EncryptedAtRest {"))
        assertEquals(listOf("D"), found("class D<T>(val t: T) : Other, EncryptedAtRest {"))
        assertEquals(emptyList(), found("class E : Other {\n val note = \"EncryptedAtRest\"\n}\ninterface EncryptedAtRest {"))
    }

    @Test
    fun `a rotation that meets an unreadable envelope fails the boot closed and touches no row`() {
        val newKey = strongEncryptionKey()
        val sibling = insertRow(devCipher.encrypt("sibling-${UUID.randomUUID()}"))
        val siblingBefore = storedToken(sibling)
        // Enveloped under a key neither the current nor the previous one: a row stranded by an earlier rotation. Soft-deleted rows count.
        val stranded = insertRow(FieldCipher(strongEncryptionKey()).encrypt("lost-${UUID.randomUUID()}"), deleted = true)
        try {
            val failure = runCatching {
                testApplication {
                    configureApp("security.encryption.key" to newKey, "security.encryption.previousKey" to DEV_DATA_ENCRYPTION_KEY)
                    startApplication()
                }
            }.exceptionOrNull()
            assertNotNull(failure, "an unreadable envelope must refuse startup")
            assertTrue(
                generateSequence(failure) { it.cause }.any { it is java.security.GeneralSecurityException },
                "the cause chain names the decryption failure",
            )
            assertEquals(siblingBefore, storedToken(sibling), "the backfill is one transaction: the sibling row is untouched")
        } finally {
            PostgresTestSupport.connect().use { connection ->
                connection.prepareStatement("DELETE FROM jira_connections WHERE id = ?").use { st ->
                    st.setInt(1, stranded)
                    st.executeUpdate()
                }
            }
        }
    }

    @Test
    fun `every service implementing EncryptedAtRest is registered with the boot backfill`() {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        val sources = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.map { it.readText() }.toList()
        val implementers = sources.flatMap { text ->
            implementer.findAll(text).map { it.groupValues[1] }.toList()
        }
        assertTrue("JiraConnectionService" in implementers, "the scan must see the known implementer, saw $implementers")
        val bootstrap = File(root, "infra/db/Bootstrap.kt").readText()
        val unregistered = implementers.filter { "attributes[${it}Key]" !in bootstrap }
        assertEquals(
            emptyList(),
            unregistered,
            "register these in encryptedAtRestServices() (infra/db/Bootstrap.kt): a rotation would strand their rows",
        )
    }
}

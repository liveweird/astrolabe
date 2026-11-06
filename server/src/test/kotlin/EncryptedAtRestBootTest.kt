package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.jira.JiraConnectionService
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import java.io.File
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The encryption-at-rest boot backfill (`infra/db/Bootstrap.kt`, `Reencrypt.kt`): a registered service's legacy plaintext rows are
 * wrapped once at startup, and while `security.encryption.previousKey` is set EVERY row (soft-deleted included) moves to the current key,
 * each time leaving a `crypto.reencrypted` audit line. The only consumer is `jira_connections.api_token` (V21). The rotation test restores
 * the suite's key afterwards: the table is shared, and its rows must stay readable by the dev-key apps the other tests boot.
 */
class EncryptedAtRestBootTest {
    private val devCipher = FieldCipher(DEV_DATA_ENCRYPTION_KEY)
    // `class A(...) : EncryptedAtRest`, `class A : EncryptedAtRest` and `object A : EncryptedAtRest`; generics and a multi-line header too.
    private val implementer =
        Regex("""\b(?:class|object)\s+(\w+)\s*(?:<[^>{]*>)?\s*(?:\([^{]*?\))?\s*:\s*[^{]*\bEncryptedAtRest\b""")

    private fun uniqueName(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    /** A row exactly as a build before the cipher (or a manual SQL load) would have left it: [storedToken] verbatim. */
    private fun insertRow(storedToken: String, deleted: Boolean = false): Int = PostgresTestSupport.connect().use { connection ->
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

    private fun storedToken(id: Int): String = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement("SELECT api_token FROM jira_connections WHERE id = ?").use { st ->
            st.setInt(1, id)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
    }

    @Test
    fun `a legacy plaintext token is encrypted once at boot and the pass is audited`() {
        val plaintext = "legacy-${UUID.randomUUID()}"
        val legacy = insertRow(plaintext)
        val enveloped = devCipher.encrypt("already-${UUID.randomUUID()}")
        val alreadyEncrypted = insertRow(enveloped)

        testApplication {
            configureApp()
            withAuditCapture { capture ->
                startApplication()
                val event = assertNotNull(capture.events.singleOrNull { it.message == "crypto.reencrypted" })
                assertTrue(event.hasKeyValue("label", "Jira API token"))
                assertTrue(event.hasKeyValue("rotating", false))
                // >= 1, not == 1: class order is not a contract, a sibling class may have left a plaintext row in this fork's table.
                val rows = event.keyValuePairs.single { it.key == "rows" }.value as Int
                assertTrue(rows >= 1, "at least the plaintext row was touched (saw $rows)")
                assertTrue(
                    capture.events.none { e -> e.keyValuePairs.orEmpty().any { plaintext in it.value.toString() } },
                    "the audit line never carries a token",
                )
            }
        }

        val stored = storedToken(legacy)
        assertTrue(stored.startsWith(FieldCipher.PREFIX), "the plaintext row is now an envelope")
        assertEquals(plaintext, devCipher.decrypt(stored))
        assertEquals(enveloped, storedToken(alreadyEncrypted), "an enveloped row is left byte for byte as it was")
        // Idempotent: a second pass finds nothing to wrap.
        val service = JiraConnectionService(sharedDatabaseForTests(), devCipher)
        assertEquals(0, runBlocking { service.encryptLegacyRows(reencryptAll = false) })
    }

    @Test
    fun `a rotation re-encrypts every row under the current key, soft-deleted ones included, and the previous key can then go`() {
        val newKey = strongEncryptionKey()
        val newCipher = FieldCipher(newKey)
        val activePlain = "active-${UUID.randomUUID()}"
        val deletedPlain = "deleted-${UUID.randomUUID()}"
        val legacyPlain = "legacy-${UUID.randomUUID()}"
        val active = insertRow(devCipher.encrypt(activePlain))
        val deleted = insertRow(devCipher.encrypt(deletedPlain), deleted = true)
        val legacy = insertRow(legacyPlain)
        try {
            testApplication {
                configureApp("security.encryption.key" to newKey, "security.encryption.previousKey" to DEV_DATA_ENCRYPTION_KEY)
                withAuditCapture { capture ->
                    startApplication()
                    val event = assertNotNull(capture.events.singleOrNull { it.message == "crypto.reencrypted" })
                    assertTrue(event.hasKeyValue("rotating", true))
                    val rows = event.keyValuePairs.single { it.key == "rows" }.value as Int
                    assertTrue(rows >= 3, "every row moves, the three of this test at least (saw $rows)")
                }
            }
            for ((id, plain) in listOf(active to activePlain, deleted to deletedPlain, legacy to legacyPlain)) {
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

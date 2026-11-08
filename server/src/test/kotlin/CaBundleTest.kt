package ch.nokillswit

import ch.nokillswit.infra.outbound.defaultTrustManager
import ch.nokillswit.infra.outbound.loadCaBundleTrust
import java.nio.file.Files
import java.nio.file.Path
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `loadCaBundleTrust` (`infra/outbound/CaBundle.kt`, the Flow connector's `FLOW_CA_BUNDLE`): the JVM's default anchors PLUS the
 * bundle's certificates, and a refusal that names the config key and never the file's content. The fixture
 * (`test-ca-bundle.pem`) holds two throwaway self-signed certificates, public parts only.
 */
class CaBundleTest {
    private val key = "flow.caBundle"

    private fun fixture(): Path = Path.of(requireNotNull(javaClass.getResource("/test-ca-bundle.pem")) { "fixture missing" }.toURI())

    private fun fixtureCertificates(): List<X509Certificate> = Files.newInputStream(fixture()).use { input ->
        CertificateFactory.getInstance("X.509").generateCertificates(input).filterIsInstance<X509Certificate>()
    }

    private fun tempFile(bytes: ByteArray): Path =
        Files.createTempFile("ca-bundle-test", ".pem").also { file ->
            file.toFile().deleteOnExit()
            Files.write(file, bytes)
        }

    private fun refusal(path: String): String = assertFailsWith<IllegalStateException> { loadCaBundleTrust(path, key) }.message.orEmpty()

    @Test
    fun `a valid bundle adds its certificates to the default anchors and substitutes none`() {
        val bundle = fixtureCertificates()
        assertEquals(2, bundle.size)
        val defaults = defaultTrustManager().acceptedIssuers.toSet()
        assertTrue(bundle.none { it in defaults }, "the fixture CAs are not public anchors")

        val trust = loadCaBundleTrust(fixture().toString(), key)

        val anchors = trust.trustManager.acceptedIssuers.toSet()
        assertTrue(anchors.containsAll(defaults), "every default anchor is kept")
        assertTrue(anchors.containsAll(bundle), "every bundle certificate is trusted")
        assertEquals(defaults.size + bundle.size, anchors.size)
    }

    @Test
    fun `a malformed bundle is refused naming the key and never the content`() {
        val garbage = "-----BEGIN CERTIFICATE-----\nnot-base64-s3cret!!\n-----END CERTIFICATE-----\n"
        val message = refusal(tempFile(garbage.toByteArray()).toString())
        assertContains(message, key)
        assertContains(message, "not a valid PEM bundle")
        assertFalse("s3cret" in message, "the file's content is never echoed: $message")
    }

    @Test
    fun `a bundle over one MiB is refused before it is parsed`() {
        val oversized = ByteArray(1024 * 1024 + 1) { '#'.code.toByte() }
        val message = refusal(tempFile(oversized).toString())
        assertContains(message, key)
        assertContains(message, "larger than")
    }

    @Test
    fun `a file without a certificate, a directory and an invalid path are refused`() {
        val empty = refusal(tempFile(ByteArray(0)).toString())
        assertContains(empty, key)
        assertContains(empty, "holds no X.509 certificate")
        // Text with no PEM block at all is a parse failure, not an empty bundle.
        assertContains(refusal(tempFile("# comments only\n".toByteArray()).toString()), "not a valid PEM bundle")
        assertContains(refusal(fixture().parent.toString()), "does not point at a readable file")
        assertContains(refusal("/nonexistent/ca-bundle.pem"), "does not point at a readable file")
        assertContains(refusal("bad\u0000path"), "not a valid file path")
    }
}

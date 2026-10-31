package ch.nokillswit.telemetry

import ch.nokillswit.infra.catchingFailures
import java.lang.management.ManagementFactory
import java.net.InetAddress

internal const val MAX_INSTANCE_LENGTH = 100

/** The only process role: Astrolabe is one JVM that serves the API and samples itself (the `role` column stays for a future split). */
const val PROCESS_ROLE = "app"
private const val MAX_BUILD_FIELD_LENGTH = 64

/**
 * Who a sampler is, written once per process run to `ops.telemetry_processes`: the role, the pod/host name, the JVM's start, the
 * build identity (the image's `ASTROLABE_BUILD_VERSION`/`ASTROLABE_BUILD_COMMIT`, null outside it) and the sizing facts the memory
 * percentage reads. NEVER JVM arguments, environment variables or system properties.
 */
data class ProcessIdentity(
    val role: String,
    val instance: String,
    val startedAt: Long,
    val buildVersion: String?,
    val buildCommit: String?,
    val processors: Int,
    val heapMaxBytes: Long,
) {
    companion object {
        /** The running process. [env] is injectable (`System::getenv`), so a test can pin the build fields. */
        fun detect(env: (String) -> String? = System::getenv): ProcessIdentity = ProcessIdentity(
            role = PROCESS_ROLE,
            instance = instanceName(env),
            startedAt = ManagementFactory.getRuntimeMXBean().startTime,
            buildVersion = buildField(env("ASTROLABE_BUILD_VERSION")),
            buildCommit = buildField(env("ASTROLABE_BUILD_COMMIT")),
            processors = Runtime.getRuntime().availableProcessors(),
            heapMaxBytes = Runtime.getRuntime().maxMemory(),
        )

        /** `HOSTNAME` (the pod name under Kubernetes, the container id under compose), else the resolver's host name. */
        internal fun instanceName(env: (String) -> String?): String {
            val host = env("HOSTNAME")?.takeIf { it.isNotBlank() }
                ?: catchingFailures({ InetAddress.getLocalHost().hostName }) { null }
            return host?.trim()?.filter { !it.isISOControl() }?.take(MAX_INSTANCE_LENGTH)?.ifBlank { null } ?: "unknown"
        }

        private fun buildField(raw: String?): String? =
            raw?.trim()?.filter { !it.isISOControl() }?.take(MAX_BUILD_FIELD_LENGTH)?.ifBlank { null }
    }
}

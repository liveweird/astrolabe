package ch.nokillswit

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Pins the JVM memory sizing ported from Flow (PRs #272-#276, `.claude/docs/build-times.md` WHY 17, 26, 27), which used to live in
 * comments only: the baked `applicationDefaultJvmArgs` (`server/build.gradle.kts`), any `JAVA_OPTS` override, the
 * container limits (`docker-compose.yaml`, `k8s/app-deployment.yaml`) and the Dockerfile's ENV lines.
 * Pure file parsing (no Docker, no classpath tricks).
 *
 * The headroom rule: a container's memory limit is at least its EFFECTIVE `-Xmx` plus [HEADROOM_MIB]. The effective `-Xmx` is the LAST
 * one on the java command line: the Gradle launcher assembles `$DEFAULT_JVM_OPTS $JAVA_OPTS $SERVER_OPTS`, i.e. the baked flags, then
 * `JAVA_OPTS`. 256 MiB comes from the measured non-heap budget: ~150 MiB (metaspace 55, class space 10, code 22, symbols 25, thread
 * stacks 12, the rest <= 5 each; WHY 17) plus <= ~30 MiB outside NMT (glibc malloc) is ~180 MiB that no heap flag moves (AppCDS only
 * lowers it, WHY 27), and the remaining ~76 MiB is the slack the kernel needs for page cache and a transient spike. The shipped pair
 * sits exactly on the rule (256m in 512Mi, no worker heap override), so raising `-Xmx` without the limit - "raise both together, never
 * one alone" -
 * fails here. The rule is a floor, not a recipe: lowering a limit below `-Xmx` + 256 MiB needs a new measurement and a new constant.
 */
class JvmMemoryFlagsTest {
    private val repoRoot = File(System.getProperty("repo.root") ?: "..")
    private val yaml = YAMLMapper()

    private fun text(path: String): String {
        val file = File(repoRoot, path)
        assertTrue(file.isFile, "${file.absolutePath} not found")
        return file.readText()
    }

    private fun tree(path: String): JsonNode = yaml.readTree(text(path))

    /** A JVM-running container: where it is declared, the flags it starts with, and the memory limit its runtime enforces. */
    private data class Jvm(val name: String, val tokens: List<String>, val limitMiB: Long?)

    /** The `applicationDefaultJvmArgs` list only - the comments around it mention flags that must NOT be set. */
    private fun bakedFlags(): List<String> {
        val block = Regex("""applicationDefaultJvmArgs\s*=\s*listOf\((.*?)\)""", RegexOption.DOT_MATCHES_ALL)
            .find(text("server/build.gradle.kts"))
        assertNotNull(block, "applicationDefaultJvmArgs = listOf(...) not found in server/build.gradle.kts")
        val flags = Regex(""""([^"]+)"""").findAll(block.groupValues[1]).map { it.groupValues[1] }.toList()
        assertTrue(flags.isNotEmpty(), "applicationDefaultJvmArgs is empty")
        return flags
    }

    private fun split(opts: String?): List<String> = opts?.trim()?.split(Regex("""\s+"""))?.filter { it.isNotEmpty() } ?: emptyList()

    /** `512m` / `768Mi` / `2g` / `1Gi` -> MiB (compose, k8s and JVM spellings of the same quantity). */
    private fun mib(quantity: String): Long {
        val match = Regex("""(\d+)([kKmMgG])i?""").matchEntire(quantity.trim())
        assertNotNull(match, "unreadable memory quantity '$quantity'")
        val n = match.groupValues[1].toLong()
        return when (match.groupValues[2].lowercase()) {
            "k" -> n / KIB_PER_MIB
            "m" -> n
            else -> n * KIB_PER_MIB
        }
    }

    /** The heap the JVM actually gets: the LAST `-Xmx` wins. */
    private fun effectiveXmxMiB(tokens: List<String>): Long? =
        tokens.lastOrNull { it.startsWith("-Xmx") }?.let { mib(it.removePrefix("-Xmx")) }

    /** The final state of a boolean `-XX:+Flag` / `-XX:-Flag`: the last occurrence wins, null when the flag is never mentioned. */
    private fun flagState(tokens: List<String>, flag: String): Boolean? =
        tokens.lastOrNull { it == "-XX:+$flag" || it == "-XX:-$flag" }?.let { it.startsWith("-XX:+") }

    private fun headroomViolations(jvm: Jvm): List<String> {
        val xmx = effectiveXmxMiB(jvm.tokens) ?: return listOf("${jvm.name}: no -Xmx on the command line")
        val limit = jvm.limitMiB ?: return listOf("${jvm.name}: no memory limit")
        if (limit >= xmx + HEADROOM_MIB) return emptyList()
        return listOf("${jvm.name}: -Xmx${xmx}m in a ${limit}Mi limit leaves ${limit - xmx} MiB, under the $HEADROOM_MIB MiB rule")
    }

    private fun composeEnv(service: JsonNode): Map<String, String> {
        val env = service.path("environment")
        return when {
            env.isObject -> env.properties().associate { (key, value) -> key to value.asText() }
            env.isArray -> env.map { it.asText() }.associate { it.substringBefore('=') to it.substringAfter('=', "") }
            else -> emptyMap()
        }
    }

    private fun composeServices(path: String): JsonNode =
        tree(path).path("services").also { assertTrue(it.isObject, "$path has no services") }

    /**
     * The compose `app` is the image's own JVM: baked flags, then `JAVA_OPTS` (none is set).
     */
    private fun composeApp(path: String): Jvm {
        val base = composeServices(path).path("app")
        val env = composeEnv(base)
        val limit = base.path("mem_limit")
        return Jvm("$path app", bakedFlags() + split(env["JAVA_OPTS"]), limit.takeIf { it.isTextual }?.let { mib(it.asText()) })
    }

    private fun k8sJvms(): List<Jvm> = k8sDeployments().flatMap { (file, deployment) ->
        containersOf(deployment).filter { it.path("image").asText().startsWith("astrolabe-app") }.map { container ->
            val javaOpts = container.path("env").firstOrNull { it.path("name").asText() == "JAVA_OPTS" }?.path("value")?.asText()
            val limit = container.path("resources").path("limits").path("memory").takeIf { it.isTextual }?.asText()
            Jvm("$file/${container.path("name").asText()}", bakedFlags() + split(javaOpts), limit?.let(::mib))
        }
    }

    private fun k8sDeployments(): List<Pair<String, JsonNode>> {
        val dir = File(repoRoot, "k8s")
        assertTrue(dir.isDirectory, "${dir.absolutePath} not found")
        val files = dir.listFiles { f -> f.name.endsWith("-deployment.yaml") }.orEmpty().sortedBy { it.name }
        return files.map { "k8s/${it.name}" to yaml.readTree(it) }
    }

    private fun containersOf(deployment: JsonNode): JsonNode = deployment.path("spec").path("template").path("spec").path("containers")

    private fun shippedJvms(): List<Jvm> = listOf(composeApp("docker-compose.yaml")) + k8sJvms()

    private fun codeLines(path: String): List<String> = text(path).lines().filter { line ->
        val trimmed = line.trimStart()
        trimmed.isNotEmpty() && listOf("#", "//", "*", "/*").none { trimmed.startsWith(it) }
    }

    @Test
    fun `the scan sees every JVM it is meant to pin`() {
        val names = shippedJvms().map { it.name }
        assertEquals(
            listOf("docker-compose.yaml app", "k8s/app-deployment.yaml/astrolabe-app"),
            names,
        )
        assertTrue("-Xmx256m" in bakedFlags(), "the baked heap moved: re-read WHY 26 and update this pin together with every limit")
    }

    @Test
    fun `every container has a memory limit`() {
        val missing = mutableListOf<String>()
        composeServices("docker-compose.yaml").fieldNames().forEach { name ->
            if (!composeServices("docker-compose.yaml").path(name).path("mem_limit").isTextual) missing += "docker-compose.yaml $name"
        }
        for ((file, deployment) in k8sDeployments()) {
            containersOf(deployment).forEach { container ->
                if (!container.path("resources").path("limits").path("memory").isTextual) {
                    missing += "$file ${container.path("name").asText()}"
                }
            }
        }
        assertEquals(emptyList(), missing, "containers without a memory limit")
    }

    @Test
    fun `the effective -Xmx leaves the headroom rule under every limit`() {
        val jvms = shippedJvms()
        assertEquals(emptyList(), jvms.flatMap(::headroomViolations))
        // The shipped sizes, so a changed pair is a conscious edit of this test: 256m in 512m (compose) and 512Mi (k8s).
        assertEquals(
            listOf(256L to 512L, 256L to 512L),
            jvms.map { effectiveXmxMiB(it.tokens)!! to it.limitMiB!! }, // (-Xmx, limit) in the order of shippedJvms()
        )
    }

    @Test
    fun `the rule reads the LAST -Xmx and fails a heap that outgrows its limit`() {
        val baked = listOf("-Xmx256m")
        assertEquals(512L, effectiveXmxMiB(baked + split("-Xmx512m")))
        assertEquals(emptyList(), headroomViolations(Jvm("ok", baked + split("-Xmx512m"), 768)))
        assertEquals(1, headroomViolations(Jvm("raised alone", baked + split("-Xmx700m"), 768)).size)
        assertEquals(1, headroomViolations(Jvm("lowered limit", baked, 400)).size)
        assertEquals(1, headroomViolations(Jvm("no limit", baked, null)).size)
        assertEquals(1024L, mib("1Gi"))
        assertEquals(2048L, mib("2g"))
    }

    @Test
    fun `ExitOnOutOfMemoryError is on for every JVM`() {
        assertEquals(true, flagState(bakedFlags(), "ExitOnOutOfMemoryError"), "the baked flags must carry -XX:+ExitOnOutOfMemoryError")
        // A later JAVA_OPTS could switch it off again; the effective state per container is what counts.
        for (jvm in shippedJvms()) {
            assertEquals(true, flagState(jvm.tokens, "ExitOnOutOfMemoryError"), "${jvm.name} lost ExitOnOutOfMemoryError")
        }
    }

    @Test
    fun `DisableExplicitGC is set nowhere`() {
        // Flow's idle heap give-back (a candidate to port) relies on System.gc(); the flag would turn it into a no-op (WHY 26).
        assertTrue(shippedJvms().none { jvm -> jvm.tokens.any { it.contains("DisableExplicitGC") } }, "a launched JVM disables explicit GC")
        val files = listOf("Dockerfile", "docker-compose.yaml", "server/build.gradle.kts") +
            File(repoRoot, "k8s").listFiles { f -> f.extension == "yaml" }.orEmpty().map { "k8s/${it.name}" }
        val offenders = files.filter { path -> codeLines(path).any { it.contains("DisableExplicitGC") } }
        assertEquals(emptyList(), offenders, "files that set -XX:+DisableExplicitGC")
    }

    @Test
    fun `the Dockerfile sets MALLOC_ARENA_MAX to 2 and nothing else overrides it`() {
        assertTrue(codeLines("Dockerfile").any { it.trim() == "ENV MALLOC_ARENA_MAX=2" }, "Dockerfile: ENV MALLOC_ARENA_MAX=2 missing")
        val overrides = deploymentEnvNames().filter { (_, name) -> name == "MALLOC_ARENA_MAX" }
        assertEquals(emptyList(), overrides, "compose/k8s override the image's MALLOC_ARENA_MAX")
    }

    @Test
    fun `SERVER_OPTS is the Dockerfile's AppCDS hook alone`() {
        val dockerfile = codeLines("Dockerfile").filter { it.contains("SERVER_OPTS") }
        assertEquals(listOf("""ENV SERVER_OPTS="-XX:SharedArchiveFile=/app/cds/astrolabe.jsa""""), dockerfile.map { it.trim() })
        // Setting it anywhere else replaces the archive flag silently (the app still starts, just slower).
        assertEquals(emptyList(), deploymentEnvNames().filter { (_, name) -> name == "SERVER_OPTS" })
        assertTrue(bakedFlags().none { it.contains("SharedArchiveFile") }, "the archive flag belongs to the image's ENV")
    }

    /** `file to variable name` for every environment entry of every compose service and k8s container. */
    private fun deploymentEnvNames(): List<Pair<String, String>> {
        val compose = composeServices("docker-compose.yaml").properties().asSequence().flatMap { (service, node) ->
            composeEnv(node).keys.map { "docker-compose.yaml $service" to it }
        }.toList()
        val k8s = k8sDeployments().flatMap { (file, deployment) ->
            containersOf(deployment).flatMap { container ->
                container.path("env").map { "$file ${container.path("name").asText()}" to it.path("name").asText() }
            }
        }
        return compose + k8s
    }

    /** Kubernetes sends SIGTERM, waits `terminationGracePeriodSeconds`, then SIGKILLs: the pod must outlive the whole shutdown (D9-5). */
    @Test
    fun `terminationGracePeriodSeconds outlasts the shutdown budget`() {
        val telemetry = text("server/src/main/kotlin/plugins/OpenTelemetry.kt")
        val stopWait = Regex("""STOP_WAIT_SECONDS\s*=\s*(\d+)L""").find(telemetry)?.groupValues?.get(1)?.toLong()
        assertNotNull(stopWait, "STOP_WAIT_SECONDS not found in plugins/OpenTelemetry.kt")
        // Ktor's stop (grace + timeout, ~6 s) fits inside STOP_WAIT; the SDK then needs <= SDK_CLOSE_SECONDS more.
        val needed = stopWait + SDK_CLOSE_SECONDS + GRACE_MARGIN_SECONDS
        for ((file, deployment) in k8sDeployments().filter { (name, _) -> name != "k8s/postgres-deployment.yaml" }) {
            val grace = deployment.path("spec").path("template").path("spec").path("terminationGracePeriodSeconds")
            assertTrue(grace.isIntegralNumber, "$file sets no terminationGracePeriodSeconds (the 30 s default has zero margin)")
            assertTrue(
                grace.asLong() >= needed,
                "$file: terminationGracePeriodSeconds ${grace.asLong()} < $needed " +
                    "(STOP_WAIT $stopWait + SDK close $SDK_CLOSE_SECONDS + margin $GRACE_MARGIN_SECONDS)",
            )
        }
        // Compose does the same SIGTERM -> wait -> SIGKILL; its 10 s default is shorter than STOP_WAIT, so it must be set.
        val composeGrace = composeServices("docker-compose.yaml").path("app").path("stop_grace_period")
        assertTrue(
            composeGrace.isTextual,
            "docker-compose.yaml app sets no stop_grace_period (the 10 s default is shorter than STOP_WAIT $stopWait)",
        )
        assertTrue(
            composeSeconds(composeGrace.asText()) >= needed,
            "docker-compose.yaml app: stop_grace_period ${composeGrace.asText()} < ${needed}s " +
                "(STOP_WAIT $stopWait + SDK close $SDK_CLOSE_SECONDS + margin $GRACE_MARGIN_SECONDS)",
        )
    }

    /** A compose duration (`45s`, `1m30s`, `1h`) in whole seconds; sub-second units are not used for a stop grace. */
    private fun composeSeconds(duration: String): Long {
        val value = duration.trim()
        assertTrue(Regex("""(\d+[hms])+""").matches(value), "unreadable compose duration '$duration'")
        return Regex("""(\d+)([hms])""").findAll(value).sumOf { match ->
            val unit = when (match.groupValues[2]) {
                "h" -> SECONDS_PER_HOUR
                "m" -> SECONDS_PER_MINUTE
                else -> 1L
            }
            match.groupValues[1].toLong() * unit
        }
    }

    private companion object {
        const val KIB_PER_MIB = 1024L
        const val SECONDS_PER_MINUTE = 60L
        const val SECONDS_PER_HOUR = 3_600L

        /** Non-heap ~150 MiB + <= ~30 MiB outside NMT, plus ~76 MiB of slack (class comment, WHY 17/26). */
        const val HEADROOM_MIB = 256L

        /** The OpenTelemetry SDK's own bounded `close()` (`plugins/OpenTelemetry.kt` KDoc). */
        const val SDK_CLOSE_SECONDS = 10L

        /** Slack for the JVM's own exit and the kubelet's bookkeeping. */
        const val GRACE_MARGIN_SECONDS = 15L
    }
}

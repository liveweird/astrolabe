package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.BIG_BODY_BYTES_FOR_HEAP_FIT
import ch.nokillswit.infra.fetch.RESPONSE_BYTES_PER_NODE
import ch.nokillswit.infra.fetch.defaultMaxResponseNodes
import java.lang.management.ManagementFactory
import java.lang.management.MemoryType

// The boot-time check that the JVM heap can hold what the Jira response ceilings allow (Flow's `JiraHeapFit.kt`, cut to what Astrolabe
// keeps). `jira.maxResponseBytes` bounds the WIRE bytes and the node ceiling bounds one parsed tree's CONSTRUCTION; this bounds how much
// the configuration lets the process hold at once, so an operator who raises a knob without the heap is refused at boot instead of meeting
// an `OutOfMemoryError` (an exit under `-XX:+ExitOnOutOfMemoryError`) the first time a dense document arrives.

private const val MIB = 1024L * 1024

/**
 * Heap bytes ONE parsed JSON tree retains per node (a structural token, [RESPONSE_BYTES_PER_NODE] wire bytes) in the worst shape found:
 * Flow measured 108 B a node on the hostile `[{"a":0},...]` document (its build-times WHY 48), 112 B being that plus ~4 %. Not re-measured
 * on Astrolabe's own JVM.
 */
internal const val TREE_BYTES_PER_NODE = 112L

/**
 * The old generation the rest of the application keeps beside Jira's trees: Astrolabe's idle live set plus the collector's slack for the
 * API's concurrent requests and the plan views (a view is ~1,000 rows). Flow measured a 21-24 MiB idle live set plus ~16 MiB for its web
 * role (40 MiB reserve); Astrolabe's views hold more, so 96 MiB (Flow's worker figure) is budgeted until it is measured here.
 */
internal const val HEAP_RESERVE_BYTES = 96L * MIB

internal data class JiraHeapVerdict(val needBytes: Long, val availableBytes: Long) {
    val fits: Boolean get() = needBytes <= availableBytes
}

/**
 * What the Jira client can pin at once: ONE big tree (a body over the transport's lock threshold is parsed behind a single lock, and the
 * trimmed result the caller keeps is small), up to `maxConcurrentRequests - 1` other trees below that threshold (no lock), and every
 * in-flight body of [maxResponseBytes] - plus [HEAP_RESERVE_BYTES]. Nothing else of a Test connection or a run is retained as a tree (the
 * client trims inside the transform), so these are the terms that move with the Jira knobs.
 */
internal fun jiraHeapVerdict(maxResponseBytes: Long, maxConcurrentRequests: Int, availableBytes: Long): JiraHeapVerdict {
    val bigTree = TREE_BYTES_PER_NODE * defaultMaxResponseNodes(maxResponseBytes)
    val smallNodes = minOf(maxResponseBytes, BIG_BODY_BYTES_FOR_HEAP_FIT) / RESPONSE_BYTES_PER_NODE
    val otherTrees = (maxConcurrentRequests - 1).toLong() * TREE_BYTES_PER_NODE * smallNodes
    val bodies = maxConcurrentRequests * maxResponseBytes
    return JiraHeapVerdict(bigTree + otherTrees + bodies + HEAP_RESERVE_BYTES, availableBytes)
}

/** Refuses the boot (naming the knobs) when the configured ceilings do not fit [availableBytes]; the message carries numbers only. */
internal fun requireHeapFitsJiraCeilings(
    maxResponseBytes: Long,
    maxConcurrentRequests: Int,
    availableBytes: Long = availableOldGenerationBytes(),
) {
    val verdict = jiraHeapVerdict(maxResponseBytes, maxConcurrentRequests, availableBytes)
    check(verdict.fits) {
        "The Jira response ceilings do not fit the heap: jira.maxResponseBytes ($maxResponseBytes) x jira.maxConcurrentRequests " +
            "($maxConcurrentRequests) need ${verdict.needBytes.ceilMib()} MiB of old generation (a ${TREE_BYTES_PER_NODE} B tree node " +
            "per ${RESPONSE_BYTES_PER_NODE} wire bytes, ${HEAP_RESERVE_BYTES / MIB} MiB reserve), but only " +
            "${verdict.availableBytes.ceilMib()} MiB is available: lower jira.maxResponseBytes or jira.maxConcurrentRequests, " +
            "or raise -Xmx (JAVA_OPTS)"
    }
}

private fun Long.ceilMib(): Long = (this + MIB - 1) / MIB

/**
 * The running JVM's old generation: the heap pool named `Tenured Gen`/`...Old Gen` (SerialGC's exact cap, here `-Xmx` less `-Xmn`;
 * G1's old pool reports the whole heap), else two thirds of `Runtime.maxMemory()` (a collector with one undivided pool), which errs
 * towards refusing.
 */
internal fun availableOldGenerationBytes(): Long {
    val old = ManagementFactory.getMemoryPoolMXBeans()
        .filter { it.type == MemoryType.HEAP && ("Old" in it.name || "Tenured" in it.name) }
        .sumOf { it.usage.max.coerceAtLeast(0) }
    return if (old > 0) old else Runtime.getRuntime().maxMemory() / 3 * 2
}

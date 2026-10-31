package ch.nokillswit.telemetry

import ch.nokillswit.infra.time.MILLIS_PER_DAY

/** The `range` query parameter: how far back a history reaches. */
internal enum class HistoryRange(val param: String, val millis: Long) {
    H24("24h", MILLIS_PER_DAY),
    D7("7d", 7 * MILLIS_PER_DAY),
    D90("90d", 90 * MILLIS_PER_DAY),
    ;

    companion object {
        fun parse(value: String): HistoryRange? = entries.firstOrNull { it.param == value }
    }
}

/** The `group` query parameter: one section of the panel. */
internal enum class HistoryGroup(val param: String) {
    MEMORY("memory"),
    STORAGE("storage"),
    REQUESTS("requests"),
    JVM("jvm"),
    ;

    companion object {
        fun parse(value: String): HistoryGroup? = entries.firstOrNull { it.param == value }
    }
}

/** A series carries at most this many points, a response at most [MAX_SERIES] series. */
internal const val MAX_POINTS = 400
internal const val MAX_SERIES = 40

private const val HOUR_SECONDS = 3_600
private const val SIX_HOUR_SECONDS = 21_600
private const val DAY_SECONDS = 86_400

/**
 * The width of a history bucket in seconds: 24h reads the raw tier at the sample interval (widened to a whole multiple of it only
 * when the span would exceed [MAX_POINTS] points, i.e. an interval under 216 s), 7d the hourly tier (168 points) and 90d the hourly
 * tier folded to six hours (360 points).
 */
internal fun historyBucketSeconds(range: HistoryRange, intervalSeconds: Int): Int = when (range) {
    HistoryRange.H24 -> intervalSeconds * Math.ceilDiv(DAY_SECONDS, MAX_POINTS * intervalSeconds)
    HistoryRange.D7 -> HOUR_SECONDS
    HistoryRange.D90 -> SIX_HOUR_SECONDS
}

private val REGISTRY: Map<String, MetricDef> = TelemetryMetrics.all.associateBy { it.name }

/**
 * Per-process metrics merge per ROLE (memory, jvm); every other group's metrics are cluster-wide (whichever process held the lock wrote
 * them). Requests are per process too, so their series carry no role.
 */
private val PER_ROLE_GROUPS = setOf(MetricGroup.MEMORY, MetricGroup.JVM)

/**
 * `GET /api/v1/telemetry/history`: the series of one panel section over a range. The groups (memory, jvm, requests, storage) are SQL
 * aggregations of `ops.telemetry_samples` per process role, metric, label and bucket (`TelemetryReads`), merged here: several processes
 * of one role share a series (a gauge's mean is n-weighted and its max the largest, a DELTA adds up), so a trend survives a restart.
 */
internal class TelemetryHistoryReport(
    private val reads: TelemetryReads,
    private val intervalSeconds: Int,
) {
    suspend fun build(group: HistoryGroup, range: HistoryRange, now: Long): TelemetryHistory {
        val bucketSeconds = historyBucketSeconds(range, intervalSeconds)
        val bucketMillis = bucketSeconds * 1000L
        val from = now - range.millis
        val window = HistoryWindow(range, from - Math.floorMod(from, bucketMillis), bucketMillis)
        val series = when (group) {
            HistoryGroup.MEMORY -> sampled(MetricGroup.MEMORY, window)
            HistoryGroup.JVM -> sampled(MetricGroup.JVM, window)
            HistoryGroup.STORAGE -> sampled(MetricGroup.STORAGE, window)
            HistoryGroup.REQUESTS -> sampled(MetricGroup.REQUESTS, window, topRoutes = true)
        }
        // The oldest instant the range holds data for, clipped to the range: the first sampler boot.
        val historyFrom = reads.oldestProcessStart()?.let { maxOf(from, minOf(it, now)) } ?: now
        return TelemetryHistory(
            group = group.param, range = range.param, bucketSeconds = bucketSeconds, from = from, to = now, historyFrom = historyFrom,
            truncated = series.size > MAX_SERIES, series = series.take(MAX_SERIES),
        )
    }

    private suspend fun sampled(group: MetricGroup, window: HistoryWindow, topRoutes: Boolean = false): List<TelemetrySeries> {
        val metrics = TelemetryMetrics.all.filter { it.group == group }
        return mergeRows(reads.historyRows(metrics, window, topRoutes))
    }

    /** Folds the SQL groups into series: one per (role | cluster, metric, label), the groups of one bucket merged. */
    private fun mergeRows(rows: List<HistoryRow>): List<TelemetrySeries> {
        val known = rows.filter { it.metric in REGISTRY }
        val series = known.groupBy { Triple(roleOf(it), it.metric, it.label) }.map { (identity, own) ->
            val (role, metric, label) = identity
            val def = REGISTRY.getValue(metric)
            val points = own.groupBy { it.t }.toSortedMap().map { (t, parts) ->
                val n = parts.sumOf { it.n }
                val sum = parts.sumOf { it.sum }
                TelemetryPoint(t, if (def.kind == MetricKind.DELTA) sum else sum / n, parts.maxOf { it.max })
            }
            TelemetrySeries(
                key = listOfNotNull(role, metric, label.ifEmpty { null }).joinToString(":"), metric = metric, label = label, role = role,
                unit = def.unit.name, kind = def.kind.name, points = points,
            )
        }
        val order = TelemetryMetrics.all.withIndex().associate { (index, def) -> def.name to index }
        return series.sortedWith(compareBy({ order.getValue(it.metric) }, { it.label }, { it.role.orEmpty() }))
    }

    private fun roleOf(row: HistoryRow): String? = if (REGISTRY.getValue(row.metric).group in PER_ROLE_GROUPS) row.role else null
}

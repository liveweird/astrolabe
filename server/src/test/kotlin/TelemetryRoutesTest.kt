package ch.nokillswit

import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncConnectors
import ch.nokillswit.sync.SyncConnectorsKey
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncFirstTickDelayKey
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncState
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.users.UserRole
import ch.nokillswit.telemetry.HistoryGroup
import ch.nokillswit.telemetry.HistoryRange
import ch.nokillswit.telemetry.TelemetryCurrent
import ch.nokillswit.telemetry.TelemetryHistory
import ch.nokillswit.telemetry.TelemetryMetrics
import ch.nokillswit.telemetry.TelemetryOverrides
import ch.nokillswit.telemetry.TelemetryOverridesKey
import ch.nokillswit.telemetry.READ_TIMEOUT_SECONDS
import ch.nokillswit.telemetry.TelemetrySync
import ch.nokillswit.telemetry.TelemetrySyncReport
import ch.nokillswit.telemetry.TelemetrySeries
import ch.nokillswit.telemetry.hourFloor
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The telemetry read API (`telemetry/TelemetryRoutes.kt`, `GET /api/v1/telemetry/current` and `/history`): ADMIN only, 403 before
 * 400, and the shapes the panel reads - over rows seeded straight into `ops`, never over a running sampler.
 *
 * The clock is pinned (`TelemetryOverridesKey`) 1000 days in the past, hour-aligned plus 20 minutes. `ops` is the telemetry tests' own
 * schema, emptied before each test.
 */
class TelemetryRoutesTest {
    private val store = telemetryStore()

    @Before
    fun emptyOps() = runBlocking { wipeTelemetry(store) }

    private val now = hourFloor(System.currentTimeMillis() - 1000 * TELE_DAY) + 20 * TELE_MINUTE
    private val hourStart = hourFloor(now)

    /** The newest completed raw bucket at the pinned `now`. */
    private val latest = now - 5 * TELE_MINUTE

    private suspend fun ApplicationTestBuilder.boot(vararg overrides: Pair<String, String>) {
        configureApp(*overrides)
        val clockNow = now
        application { attributes.put(TelemetryOverridesKey, TelemetryOverrides(clock = { clockNow })) }
        startApplication()
    }

    private suspend fun HttpClient.current(): TelemetryCurrent {
        val response = get("/api/v1/telemetry/current")
        assertEquals(HttpStatusCode.OK, response.status)
        return response.body()
    }

    private suspend fun HttpClient.history(group: String, range: String): TelemetryHistory {
        val response = get("/api/v1/telemetry/history?group=$group&range=$range")
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return response.body()
    }

    private fun TelemetryHistory.series(key: String): TelemetrySeries =
        assertNotNull(series.firstOrNull { it.key == key }, "series $key in ${series.map { it.key }}")

    private fun TelemetrySeries.ts() = points.map { it.t }
    private fun TelemetrySeries.avgs() = points.map { it.avg }
    private fun TelemetrySeries.maxes() = points.map { it.max }

    // ---- guard and parsing ---------------------------------------------------------------------------------------------

    @Test
    fun `an ADMIN reads an empty ops, every group and range`() = testApplication {
        boot()
        val admin = seededClient("telemetry-empty", UserRole.ADMIN)

        val current = admin.current()
        assertEquals(now, current.generatedAt)
        assertEquals(TELE_RAW_SECONDS, current.sampleIntervalSeconds)
        assertTrue(current.processes.isEmpty())
        assertNull(current.storage)
        assertNull(current.requests.measuredAt)
        assertEquals(TELE_RAW_SECONDS, current.requests.windowSeconds)
        assertEquals(0L, current.requests.total.count)
        assertNull(current.requests.total.p50Ms)
        assertTrue(current.requests.routes.isEmpty())

        val buckets = mapOf("24h" to TELE_RAW_SECONDS, "7d" to 3600, "90d" to 21600)
        for (group in HistoryGroup.entries) {
            for (range in HistoryRange.entries) {
                val history = admin.history(group.param, range.param)
                assertEquals(group.param, history.group)
                assertEquals(range.param, history.range)
                assertEquals(buckets.getValue(range.param), history.bucketSeconds, "${group.param} ${range.param}")
                assertEquals(now - range.millis, history.from)
                assertEquals(now, history.to)
                assertFalse(history.truncated, "${group.param} ${range.param}")
                assertTrue(history.series.isEmpty(), "${group.param} ${range.param}: no samples, no series")
                assertEquals(now, history.historyFrom, "no sampler ever ran: nothing to hold")
            }
        }
    }

    @Test
    fun `a USER is refused 403 on both routes, before the query is read, and the denial is audited`() = testApplication {
        boot()
        val user = seededClient("telemetry-user")
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.Forbidden, user.get("/api/v1/telemetry/current").status)
            assertEquals(HttpStatusCode.Forbidden, user.get("/api/v1/telemetry/history?group=memory&range=24h").status)
            assertEquals(HttpStatusCode.Forbidden, user.get("/api/v1/telemetry/history?group=nope&range=never").status, "403 outranks 400")
            assertEquals(HttpStatusCode.Forbidden, user.get("/api/v1/telemetry/history").status, "403 outranks 400")
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/telemetry/current") })
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/telemetry/history") })
        }
    }

    @Test
    fun `an unknown, missing or repeated group or range is a 400 for an ADMIN`() = testApplication {
        boot()
        val admin = seededClient("telemetry-400", UserRole.ADMIN)
        for (query in listOf(
            "", "?range=24h", "?group=memory", "?group=nope&range=24h", "?group=memory&range=1h", "?group=MEMORY&range=24h",
            "?group=memory&range=24h&group=jvm", "?group=memory&range=24h&range=7d", "?group=&range=24h",
        )) {
            assertEquals(HttpStatusCode.BadRequest, admin.get("/api/v1/telemetry/history$query").status, query)
        }
    }

    @Test
    fun `current lists the live processes with their latest sample and the percentage of the container limit`() = testApplication {
        boot()
        val webLimit = 512L shl 20
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 3 * TELE_HOUR, limitBytes = webLimit)
        val worker = store.seedProcess("worker", lastSeen = now - 20_000)
        val replaced = store.seedProcess("web", lastSeen = now - 2 * TELE_HOUR) // stale long ago, its role is alive: not listed
        val wedged = store.seedProcess("web", lastSeen = now - 30 * TELE_MINUTE) // stale but seen within the hour: listed, flagged
        val silent = store.seedProcess("worker", lastSeen = now - 10_000, startedAt = now - 3 * TELE_HOUR) // ticks but samples are old
        val stoppedAll = store.seedProcess("all", lastSeen = now - 2 * TELE_HOUR) // stale and alone in its role: listed, flagged
        val ancient = store.seedProcess("batch", lastSeen = now - 25 * TELE_HOUR) // unseen for more than a day: not listed
        val m = TelemetryMetrics
        store.put(
            // An older tick of the web process: superseded by the newest bucket, and a metric only it wrote must not be carried over.
            rawRow(web, latest - 5 * TELE_MINUTE, m.HEAP_USED, 1.0), rawRow(web, latest - 5 * TELE_MINUTE, m.CGROUP_PEAK, 777.0),
            rawRow(web, latest, m.HEAP_USED, 100_000_000.0), rawRow(web, latest, m.HEAP_COMMITTED, 150_000_000.0),
            rawRow(web, latest, m.OLD_GEN_PEAK, 60_000_000.0), rawRow(web, latest, m.NON_HEAP_USED, 70_000_000.0),
            rawRow(web, latest, m.DIRECT_BUFFERS, 1_000_000.0), rawRow(web, latest, m.RSS, 300_000_000.0),
            rawRow(web, latest, m.CGROUP_CURRENT, 280_000_000.0), rawRow(web, latest, m.CGROUP_ANON, 250_000_000.0),
            rawRow(web, latest, m.CGROUP_WORKING_SET, (256L shl 20).toDouble()),
            rawRow(web, latest, m.CPU_RATIO, 0.25), rawRow(web, latest, m.THREADS, 42.0),
            rawRow(web, latest, m.GC_COUNT, 3.0, "G1 Young"), rawRow(web, latest, m.GC_COUNT, 1.0, "G1 Old"),
            rawRow(web, latest, m.GC_TIME, 20.0, "G1 Young"), rawRow(web, latest, m.GC_TIME, 90.0, "G1 Old"),
            rawRow(web, latest, m.POOL_ACQUIRED, 2.0), rawRow(web, latest, m.POOL_IDLE, 3.0),
            rawRow(web, latest, m.POOL_PENDING, 0.0), rawRow(web, latest, m.POOL_ALLOCATED, 5.0),
            rawRow(worker, latest, m.HEAP_USED, 50_000_000.0), rawRow(worker, latest, m.CGROUP_WORKING_SET, 200_000_000.0),
            rawRow(silent, now - TELE_HOUR, m.HEAP_USED, 1.0),
        )
        val admin = seededClient("telemetry-current", UserRole.ADMIN)

        val processes = admin.current().processes.associateBy { it.id }
        assertEquals(setOf(web, worker, stoppedAll, wedged, silent), processes.keys, "$replaced and $ancient are not listed")
        assertTrue(processes.getValue(wedged).stale, "a wedged replica stays visible, flagged")
        assertTrue(processes.getValue(silent).stale, "fresh ticks but a sample an hour old is stale")
        assertFalse(processes.getValue(worker).stale)

        val w = processes.getValue(web)
        assertEquals("web", w.role)
        assertEquals(now - 3 * TELE_HOUR, w.startedAt)
        assertEquals(now - 10_000, w.lastSeenAt)
        assertEquals(latest, w.sampledAt)
        assertFalse(w.stale)
        assertEquals("9.9.9", w.version)
        assertEquals("abc1234", w.commit)
        assertEquals(100_000_000L, w.memory.heapUsedBytes)
        assertEquals(150_000_000L, w.memory.heapCommittedBytes)
        assertEquals(256L shl 20, w.memory.heapMaxBytes)
        assertEquals(60_000_000L, w.memory.oldGenPeakBytes)
        assertEquals(70_000_000L, w.memory.nonHeapBytes)
        assertEquals(1_000_000L, w.memory.directBytes)
        assertEquals(300_000_000L, w.memory.rssBytes)
        assertEquals(280_000_000L, w.memory.cgroupCurrentBytes)
        assertEquals(250_000_000L, w.memory.cgroupAnonBytes)
        assertEquals(256L shl 20, w.memory.workingSetBytes)
        assertNull(w.memory.cgroupPeakBytes, "an older tick's figure is not carried into the newest")
        assertEquals(webLimit, w.memory.containerLimitBytes)
        assertEquals(50.0, w.memory.percentOfLimit)
        assertEquals(0.25, w.jvm.cpuRatio)
        assertEquals(42, w.jvm.threads)
        assertEquals(4L, w.jvm.gcCount, "collectors add up")
        assertEquals(110L, w.jvm.gcTimeMs)
        assertEquals(listOf(2, 3, 0, 5), listOf(w.jvm.poolAcquired, w.jvm.poolIdle, w.jvm.poolPending, w.jvm.poolAllocated))

        val wk = processes.getValue(worker)
        assertNull(wk.memory.containerLimitBytes)
        assertNull(wk.memory.percentOfLimit, "no limit, no percentage")
        assertEquals(200_000_000L, wk.memory.workingSetBytes)
        assertNull(wk.jvm.cpuRatio)

        val gone = processes.getValue(stoppedAll)
        assertTrue(gone.stale)
        assertNull(gone.sampledAt)
        assertNull(gone.memory.heapUsedBytes)
    }

    @Test
    fun `current reads the newest storage measurement and the busiest routes of the latest interval`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000)
        val m = TelemetryMetrics
        val older = latest - TELE_HOUR
        val routeRows = (1..17).flatMap { i ->
            val route = "/api/v1/users/r%02d".format(i)
            listOf(rawRow(web, latest, m.HTTP_COUNT, i.toDouble(), route), rawRow(web, latest, m.HTTP_P95, i * 10.0, route))
        }
        store.put(
            rawRow(web, latest, m.HEAP_USED, 1.0),
            rawRow(web, older, m.DB_SIZE, 1.0), rawRow(web, older, m.DB_SCHEMA_SIZE, 1.0, "raw"),
            rawRow(web, latest - 30 * TELE_MINUTE, m.DB_SIZE, 9_000_000.0),
            rawRow(web, latest - 30 * TELE_MINUTE, m.DB_SCHEMA_SIZE, 6_000_000.0, "raw"),
            rawRow(web, latest - 30 * TELE_MINUTE, m.DB_SCHEMA_SIZE, 1_000_000.0, "ops"),
            rawRow(web, latest, m.HTTP_COUNT, 200.0, "*"), rawRow(web, latest, m.HTTP_P50, 12.0, "*"),
            rawRow(web, latest, m.HTTP_P95, 80.0, "*"),
            rawRow(web, latest, m.HTTP_5XX, 3.0, "*"), rawRow(web, latest, m.HTTP_429, 2.0, "*"),
            rawRow(web, latest, m.HTTP_P50, 5.0, "/api/v1/users/r17"), rawRow(web, latest, m.HTTP_5XX, 1.0, "/api/v1/users/r17"),
            rawRow(web, latest - 5 * TELE_MINUTE, m.HTTP_COUNT, 999.0, "/api/v1/users/old"), // an older interval: not "latest"
            *routeRows.toTypedArray(),
        )
        val current = seededClient("telemetry-storage", UserRole.ADMIN).current()

        val storage = assertNotNull(current.storage)
        assertEquals(latest - 30 * TELE_MINUTE, storage.measuredAt, "the newest measurement")
        assertEquals(9_000_000L, storage.databaseBytes)
        assertEquals(listOf("ops" to 1_000_000L, "raw" to 6_000_000L), storage.schemas.map { it.name to it.bytes })

        val requests = current.requests
        assertEquals(latest, requests.measuredAt)
        assertEquals(200L, requests.total.count)
        assertEquals(12.0, requests.total.p50Ms)
        assertEquals(80.0, requests.total.p95Ms)
        assertEquals(3L, requests.total.serverErrors)
        assertEquals(2L, requests.total.rateLimited)
        assertEquals((17 downTo 3).map { "/api/v1/users/r%02d".format(it) }, requests.routes.map { it.route }, "top 15 by count")
        val top = requests.routes.first()
        assertEquals(17L, top.count)
        assertEquals(5.0, top.p50Ms)
        assertEquals(170.0, top.p95Ms)
        assertEquals(1L, top.serverErrors)
        assertEquals(0L, top.rateLimited, "an absent 429 row is zero")
        assertNull(requests.routes.last().p50Ms, "no p50 row, no p50")
    }

    @Test
    fun `history merges the processes of one role per bucket and keeps the trend across a restart`() = testApplication {
        boot()
        val first = store.seedProcess("web", lastSeen = now - TELE_HOUR, startedAt = now - 2 * TELE_HOUR) // stopped
        val second = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - TELE_HOUR) // its replacement
        val worker = store.seedProcess("worker", lastSeen = now - 10_000, startedAt = now - 90 * TELE_MINUTE)
        val m = TelemetryMetrics
        val a = latest - 10 * TELE_MINUTE
        val b = latest - 5 * TELE_MINUTE
        store.put(
            rawRow(first, a, m.HEAP_USED, 100.0, max = 120.0), rawRow(second, a, m.HEAP_USED, 300.0, max = 350.0),
            rawRow(second, b, m.HEAP_USED, 400.0), rawRow(second, latest, m.HEAP_USED, 500.0),
            rawRow(worker, a, m.HEAP_USED, 50.0), rawRow(worker, a, m.RSS, 7.0),
            rawRow(first, a, m.GC_COUNT, 2.0, "G1 Young"), rawRow(second, a, m.GC_COUNT, 3.0, "G1 Young"),
            rawRow(second, b, m.THREADS, 40.0), rawRow(second, a, m.POOL_IDLE, 4.0),
        )
        val admin = seededClient("telemetry-merge", UserRole.ADMIN)

        val memory = admin.history("memory", "24h")
        assertEquals(listOf("web:mem.heap_used", "worker:mem.heap_used", "worker:mem.rss"), memory.series.map { it.key })
        val heap = memory.series("web:mem.heap_used")
        assertEquals(listOf(a, b, latest), heap.ts())
        assertEquals(listOf(200.0, 400.0, 500.0), heap.avgs(), "the mean of the two processes in their shared bucket")
        assertEquals(listOf(350.0, 400.0, 500.0), heap.maxes(), "the largest of the two")
        assertEquals("web", heap.role)
        assertEquals("mem.heap_used", heap.metric)
        assertEquals("", heap.label)
        assertEquals("BYTES", heap.unit)
        assertEquals("GAUGE", heap.kind)
        assertEquals(listOf(50.0), memory.series("worker:mem.heap_used").avgs())
        assertEquals(now - 2 * TELE_HOUR, memory.historyFrom, "the first sampler of the retained processes booted two hours ago")
        assertFalse(memory.truncated)
        assertEquals(TELE_RAW_SECONDS, memory.bucketSeconds)

        val jvm = admin.history("jvm", "24h")
        val gc = jvm.series("web:jvm.gc_count:G1 Young")
        assertEquals("DELTA", gc.kind)
        assertEquals("COUNT", gc.unit)
        assertEquals("G1 Young", gc.label)
        assertEquals(listOf(5.0), gc.avgs(), "a DELTA adds up: the bucket's total")
        assertEquals(listOf(3.0), gc.maxes(), "and keeps the largest single interval")
        assertEquals(setOf("web:jvm.gc_count:G1 Young", "web:jvm.threads", "web:pool.idle"), jvm.series.map { it.key }.toSet())
    }

    @Test
    fun `the 7 day history reads hourly rows plus the hours the rollup has not folded yet`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 3 * TELE_DAY)
        val m = TelemetryMetrics
        val rolled = hourStart - 2 * TELE_HOUR
        val unrolled = hourStart - TELE_HOUR
        store.put(
            hourlyRow(web, rolled - 2 * TELE_HOUR, m.THREADS, avg = 100.0, max = 120.0),
            hourlyRow(web, rolled - TELE_HOUR, m.THREADS, avg = 200.0, max = 260.0),
            hourlyRow(web, rolled, m.THREADS, avg = 300.0, max = 310.0),
            hourlyRow(web, rolled, m.GC_COUNT, avg = 0.5, max = 2.0, label = "G1 Young"),
            // Raw rows of an hour that IS rolled up: already inside the hourly row, so counted once.
            rawRow(web, rolled + 5 * TELE_MINUTE, m.THREADS, 999.0), rawRow(web, rolled + 5 * TELE_MINUTE, m.GC_COUNT, 77.0, "G1 Young"),
            // Raw rows of the two hours after the newest hourly row: read time folds them.
            rawRow(web, unrolled, m.THREADS, 10.0), rawRow(web, unrolled + 5 * TELE_MINUTE, m.THREADS, 30.0),
            rawRow(web, hourStart, m.THREADS, 50.0),
            rawRow(web, unrolled, m.GC_COUNT, 1.0, "G1 Young"), rawRow(web, unrolled + 5 * TELE_MINUTE, m.GC_COUNT, 2.0, "G1 Young"),
        )
        val history = seededClient("telemetry-7d", UserRole.ADMIN).history("jvm", "7d")

        assertEquals(3600, history.bucketSeconds)
        val threads = history.series("web:jvm.threads")
        assertEquals(listOf(rolled - 2 * TELE_HOUR, rolled - TELE_HOUR, rolled, unrolled, hourStart), threads.ts())
        assertEquals(listOf(100.0, 200.0, 300.0, 20.0, 50.0), threads.avgs())
        assertEquals(listOf(120.0, 260.0, 310.0, 30.0, 50.0), threads.maxes())
        val gc = history.series("web:jvm.gc_count:G1 Young")
        assertEquals(listOf(rolled, unrolled), gc.ts())
        assertEquals(listOf(6.0, 3.0), gc.avgs(), "an hourly DELTA row's avg * n is the hour's total; the raw rows add up")
        assertEquals(listOf(2.0, 2.0), gc.maxes())
        assertEquals(now - 3 * TELE_DAY, history.historyFrom)
    }

    @Test
    fun `the 90 day history folds the hourly rows into six hour buckets`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 50 * TELE_DAY)
        val m = TelemetryMetrics
        val bucket = 6 * TELE_HOUR
        val base = Math.floorDiv(now - 40 * TELE_DAY, bucket) * bucket
        store.put(
            hourlyRow(web, base, m.THREADS, avg = 100.0, max = 120.0),
            hourlyRow(web, base + TELE_HOUR, m.THREADS, avg = 200.0, max = 260.0),
            hourlyRow(web, base + bucket, m.THREADS, avg = 50.0, max = 60.0, n = 6),
            hourlyRow(web, base, m.GC_COUNT, avg = 1.0, max = 4.0, label = "G1 Old"),
            hourlyRow(web, base + TELE_HOUR, m.GC_COUNT, avg = 2.0, max = 3.0, label = "G1 Old"),
        )
        val history = seededClient("telemetry-90d", UserRole.ADMIN).history("jvm", "90d")

        assertEquals(21600, history.bucketSeconds)
        val threads = history.series("web:jvm.threads")
        assertEquals(listOf(base, base + bucket), threads.ts())
        assertEquals(listOf(150.0, 50.0), threads.avgs(), "the n-weighted mean of the hours in the bucket")
        assertEquals(listOf(260.0, 60.0), threads.maxes())
        assertEquals(listOf(12.0 + 24.0), history.series("web:jvm.gc_count:G1 Old").avgs(), "totals add up: 1 * 12 + 2 * 12")
        assertEquals(now - 50 * TELE_DAY, history.historyFrom)
    }

    @Test
    fun `a history carries at most 400 points per series and 40 series`() = testApplication {
        boot("telemetry.sampleIntervalSeconds" to "60")
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 2 * TELE_DAY)
        val oneMinute = 60_000L
        val rows = (0 until 1440).map { rawRow(web, latest - it * oneMinute, TelemetryMetrics.HEAP_USED, it.toDouble(), resolution = 60) }
        store.put(rows)
        val admin = seededClient("telemetry-caps", UserRole.ADMIN)

        assertEquals(60, admin.current().sampleIntervalSeconds)
        val heap = admin.history("memory", "24h")
        assertEquals(240, heap.bucketSeconds, "a day of 60 s samples is 1440 points: four of them per bucket")
        val points = heap.series("web:mem.heap_used").points
        assertTrue(points.size in 358..361, "${points.size} points")
        assertTrue(points.size <= 400)
        assertEquals(points.map { it.t }.sorted(), points.map { it.t })
        assertTrue(points.all { it.t % 240_000L == 0L })
    }

    @Test
    fun `more than 40 series are cut to 40 and flagged`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000)
        store.put((1..45).map { rawRow(web, latest, TelemetryMetrics.GC_COUNT, it.toDouble(), "collector-%02d".format(it)) })
        val history = seededClient("telemetry-series-cap", UserRole.ADMIN).history("jvm", "24h")

        assertEquals(40, history.series.size)
        assertTrue(history.truncated)
    }

    @Test
    fun `the requests history keeps the total and the ten busiest routes`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 2 * TELE_HOUR)
        val all = store.seedProcess("all", lastSeen = now - 10_000, startedAt = now - 2 * TELE_HOUR)
        val m = TelemetryMetrics
        val earlier = latest - 5 * TELE_MINUTE
        fun route(i: Int) = "/api/v1/users/r%02d".format(i)
        val rows = (1..12).flatMap { i ->
            listOf(earlier, latest).flatMap { ts ->
                listOf(
                    rawRow(web, ts, m.HTTP_COUNT, i.toDouble(), route(i)), rawRow(web, ts, m.HTTP_P50, i.toDouble(), route(i)),
                    rawRow(web, ts, m.HTTP_P95, i * 2.0, route(i)),
                )
            }
        } + listOf(
            rawRow(web, latest, m.HTTP_COUNT, 500.0, "*"), rawRow(web, latest, m.HTTP_P50, 9.0, "*"),
            rawRow(web, latest, m.HTTP_P95, 90.0, "*"), rawRow(web, latest, m.HTTP_5XX, 4.0, "*"),
            rawRow(web, latest, m.HTTP_429, 1.0, "*"), rawRow(web, latest, m.HTTP_5XX, 2.0, route(12)),
            // Another serving role of the same fleet: one series per route, not one per role.
            rawRow(all, latest, m.HTTP_COUNT, 3.0, route(12)), rawRow(all, latest, m.HTTP_COUNT, 100.0, "*"),
        )
        store.put(rows)
        val history = seededClient("telemetry-requests", UserRole.ADMIN).history("requests", "24h")

        val keys = history.series.map { it.key }.toSet()
        assertEquals(35, history.series.size, "5 for the total + 3 for each of ten routes")
        val totals = keys.filter { it.endsWith(":*") }.map { it.removePrefix("http.").removeSuffix(":*") }
        assertEquals(setOf("count", "p50", "p95", "5xx", "429"), totals.toSet())
        for (i in 3..12) assertTrue("http.count:${route(i)}" in keys && "http.p95:${route(i)}" in keys, route(i))
        assertTrue(keys.none { route(1) in it || route(2) in it }, "the two quietest routes are out")
        assertFalse("http.5xx:${route(12)}" in keys, "per-route errors are not in the history")
        val count = history.series("http.count:${route(12)}")
        assertEquals(route(12), count.label)
        assertEquals("DELTA", count.kind)
        assertNull(count.role, "the serving roles are one series per route")
        assertEquals(listOf(12.0, 15.0), count.avgs(), "web and all add up in the shared bucket")
        assertEquals(600.0, history.series("http.count:*").avgs().single())
        assertEquals("MILLISECONDS", history.series("http.p95:*").unit)
        assertEquals(4.0, history.series("http.5xx:*").avgs().single())
    }

    @Test
    fun `the storage history is cluster-wide, whichever process took the measurement`() = testApplication {
        boot()
        val web = store.seedProcess("web", lastSeen = now - 10_000, startedAt = now - 5 * TELE_HOUR)
        val worker = store.seedProcess("worker", lastSeen = now - 10_000, startedAt = now - 5 * TELE_HOUR)
        val m = TelemetryMetrics
        val earlier = latest - 2 * TELE_HOUR
        val later = latest - TELE_HOUR
        store.put(
            rawRow(web, earlier, m.DB_SIZE, 1.0e9), rawRow(worker, later, m.DB_SIZE, 2.0e9),
            rawRow(web, earlier, m.DB_SCHEMA_SIZE, 5.0e8, "raw"), rawRow(worker, later, m.DB_SCHEMA_SIZE, 6.0e8, "raw"),
        )
        val history = seededClient("telemetry-storage-history", UserRole.ADMIN).history("storage", "24h")

        val size = history.series("db.size")
        assertNull(size.role)
        assertEquals(listOf(earlier, later), size.ts())
        assertEquals(listOf(1.0e9, 2.0e9), size.avgs())
        assertEquals(listOf(5.0e8, 6.0e8), history.series("db.schema.size:raw").avgs())
        assertEquals("BYTES", size.unit)
    }

    @Test
    fun `both telemetry reads share one per-user bucket of 30 a minute`() = testApplication {
        boot()
        val admin = seededClient("telemetry-bucket", UserRole.ADMIN)
        val other = seededClient("telemetry-bucket-other", UserRole.ADMIN)
        repeat(15) {
            assertEquals(HttpStatusCode.OK, admin.get("/api/v1/telemetry/current").status)
            assertEquals(HttpStatusCode.OK, admin.get("/api/v1/telemetry/history?group=memory&range=24h").status)
        }
        assertEquals(HttpStatusCode.TooManyRequests, admin.get("/api/v1/telemetry/current").status)
        assertEquals(HttpStatusCode.TooManyRequests, admin.get("/api/v1/telemetry/history?group=memory&range=24h").status)
        assertEquals(HttpStatusCode.OK, other.get("/api/v1/telemetry/current").status, "keyed by the user, not the address")
    }

    @Test
    fun `the raw tier filter lists exactly the resolutions the V9 check allows below an hour`() {
        assertEquals((60 until 3600).filter { 3600 % it == 0 }, ch.nokillswit.telemetry.RAW_RESOLUTIONS)
    }

    // ---- the sync block ------------------------------------------------------------------------------------------------

    @Test
    fun `the sync block lists a connection with its derived status and nothing of its site, and reports the scheduler off by default`() =
        testApplication {
            configureApp()
            startApplication()
            val admin = seededClient("telemetry-sync", UserRole.ADMIN)
            val created = jbJson.decodeFromString<JiraConnectionResponse>(admin.postJson(JB_CONNECTIONS, jbRequest()).bodyAsText())
            val failedAt = System.currentTimeMillis() - 10 * TELE_MINUTE
            // The connection was last edited BEFORE the run began, else the edit makes it due at once (the scheduler's rule).
            jbSql(
                "UPDATE jira_connections SET discovered_at = 1, created_at = ?, updated_at = ? WHERE id = ?",
                failedAt - TELE_MINUTE, failedAt - TELE_MINUTE, created.id.toInt(),
            )
            jbSql(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome, error_code) " +
                    "VALUES ('JIRA', ?, 'SCHEDULED', ?, ?, 'FAILED', 'TIMEOUT')",
                created.id.toInt(), failedAt, failedAt + 1_000,
            )
            try {
                val raw = admin.get("/api/v1/telemetry/current").bodyAsText()
                val sync = jbJson.decodeFromString<TelemetryCurrent>(raw).sync
                assertFalse(sync.schedulerEnabled, "the harness runs no scheduler")
                assertEquals(60, sync.tickSeconds, "the configured tick is reported either way")
                val row = sync.connections.single { it.connectionId == created.id }
                assertEquals(SyncKind.JIRA, row.kind)
                assertEquals(created.name, row.name)
                assertEquals(15, row.pollIntervalMinutes)
                assertTrue(row.ready)
                assertEquals(SyncState.FAILED, row.status.state)
                assertEquals(1, row.status.consecutiveFailures)
                assertEquals("TIMEOUT", row.status.lastRun!!.errorCode)
                assertEquals(SyncTrigger.SCHEDULED, row.status.lastRun!!.trigger)
                assertEquals(failedAt + 1_000 + 15 * TELE_MINUTE, row.status.nextPollAt, "one interval after the failed run finished")
                assertFalse(listOf(created.siteUrl, created.email, "JTOK").any { raw.contains(it) }, "no site, email or token")
            } finally {
                // Removes the connection (and its runs): a due connection must not stay in the shared database for a later scheduler test.
                admin.delete("$JB_CONNECTIONS/${created.id}")
            }
        }

    @Test
    fun `the sync block says the scheduler is on when it runs, with the configured tick`() = testApplication {
        configureApp("sync.scheduler.enabled" to "true", "sync.tickSeconds" to "30")
        application { attributes.put(SyncFirstTickDelayKey, 3_600_000L) } // the loop never ticks: no run is claimed in the shared database
        startApplication()
        val sync = seededClient("telemetry-sync-on", UserRole.ADMIN).current().sync
        assertTrue(sync.schedulerEnabled)
        assertEquals(30, sync.tickSeconds)
    }

    private class FakeConnector(private val listing: (Int) -> List<ConnectorConnection>) : Connector {
        override val kind = SyncKind.JIRA
        var budget: Int? = null

        override suspend fun requireRunnable(connectionId: UInt) = Unit

        override suspend fun connections(): List<ConnectorConnection> = error("the telemetry block must pass its statement budget")

        override suspend fun connections(queryTimeoutSeconds: Int): List<ConnectorConnection> {
            budget = queryTimeoutSeconds
            return listing(queryTimeoutSeconds)
        }

        override suspend fun run(run: ClaimedRun): SyncResult = SyncResult.succeeded(SyncCounts())
    }

    private fun syncAttributes(connector: Connector) = io.ktor.util.Attributes().also {
        it.put(SyncConnectorsKey, SyncConnectors().also { connectors -> connectors.register(connector) })
        it.put(SyncRunServiceKey, SyncRunService(sharedDatabaseForTests(), maxRunMinutes = 10))
    }

    @Test
    fun `the sync block reads under the telemetry statement budget`() = runBlocking {
        val connector = FakeConnector { emptyList() }
        TelemetrySyncReport(syncAttributes(connector), tickSeconds = 60).build(now)
        assertEquals(READ_TIMEOUT_SECONDS, connector.budget, "the same 5 s queryTimeout as the other reads")
    }

    @Test
    fun `a failing connector costs the sync block its connections, never the report, and warns once with the exception class only`() =
        runBlocking {
            val connector = FakeConnector { error("connection string with a-secret-value") }
            val capture = LogCapture(TelemetrySyncReport::class.java.name)
            try {
                val report = TelemetrySyncReport(syncAttributes(connector), tickSeconds = 60)
                repeat(2) {
                    assertEquals(TelemetrySync(schedulerEnabled = false, tickSeconds = 60, connections = emptyList()), report.build(now))
                }
                val warnings = capture.events.filter { it.level == ch.qos.logback.classic.Level.WARN }
                assertEquals(1, warnings.size, "the repeat is a DEBUG")
                assertTrue(warnings.single().formattedMessage.contains("IllegalStateException"))
                assertFalse(capture.events.any { it.formattedMessage.contains("a-secret-value") }, "the class, never the message")
            } finally {
                capture.detach()
            }
        }

    @Test
    fun `without a connector the sync block is empty, the scheduler off and the tick still reported`() = runBlocking {
        val bare = TelemetrySyncReport(io.ktor.util.Attributes(), tickSeconds = 45)
        assertEquals(TelemetrySync(schedulerEnabled = false, tickSeconds = 45, connections = emptyList()), bare.build(now))
    }
}

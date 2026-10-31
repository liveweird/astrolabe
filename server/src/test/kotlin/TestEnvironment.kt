package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.auth.hashPassword
import ch.nokillswit.infra.db.SEED_ADMIN_EMAIL
import ch.nokillswit.infra.db.SEED_PASSWORD_HASH
import ch.nokillswit.infra.db.connectPooledDatabase
import ch.nokillswit.users.User
import ch.nokillswit.users.UserRole
import ch.nokillswit.users.UserService
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.config.ApplicationConfig
import io.ktor.server.config.MapApplicationConfig
import io.ktor.server.config.mergeWith
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.TestApplicationBuilder
import io.r2dbc.spi.ConnectionFactoryOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeout
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.time.Duration

/**
 * Points the app at the shared Testcontainers Postgres (with CSRF off) WITHOUT starting it —
 * callers that assert startup behavior (fail-closed checks) add their own overrides and call
 * `startApplication()` themselves. Later duplicate keys win in [MapApplicationConfig], so
 * [overrides] may replace the defaults listed first.
 *
 * [overrides] replace the defaults; the telemetry sampler is off by default (see the key below).
 */
fun TestApplicationBuilder.configureApp(vararg overrides: Pair<String, String>) {
    environment {
        config = ApplicationConfig("application.yaml").mergeWith(
            MapApplicationConfig(
                "postgres.jdbcUrl" to PostgresTestSupport.jdbcUrl,
                "postgres.r2dbcUrl" to PostgresTestSupport.r2dbcUrl,
                "postgres.user" to PostgresTestSupport.user,
                "postgres.password" to PostgresTestSupport.password,
                "security.csrf.enabled" to "false",
                // The self-service reset builds its emailed link from this origin. https, not http: the origin is validated at
                // boot in every mode, and the production-mode boot tests reuse this config (http is a development-only scheme).
                "mail.appUrl" to "https://localhost:8086",
                // The telemetry sampler is off for the suite (it would write a process row and samples into the shared database from
                // every booted app); its tests build the sampler directly or opt in with "telemetry.enabled" to "true".
                "telemetry.enabled" to "false",
                *overrides,
            )
        )
    }
}

suspend fun ApplicationTestBuilder.usePostgresTestcontainer() {
    configureApp()
    startApplication()
}

/**
 * Shared config for every test HTTP client: JSON (+ problem+json) negotiation and the
 * [OpenApiConformance] plugin, which validates each /api/ interaction against the OpenAPI spec.
 */
fun HttpClientConfig<*>.testClientDefaults() {
    install(ContentNegotiation) { json(); json(contentType = ContentType.parse("application/problem+json")) }
    install(OpenApiConformance)
}

fun ApplicationTestBuilder.jsonClient(): HttpClient = createClient { testClientDefaults() }

/** A unique throwaway email so tests never collide on the partial-unique active-email index. */
fun uniqueEmail(prefix: String) = "$prefix-${java.util.UUID.randomUUID()}@test"

/** A private 64-hex data-encryption key — every production-mode boot needs one (the dev default is burned). */
fun strongEncryptionKey(): String =
    java.util.UUID.randomUUID().toString().replace("-", "") + java.util.UUID.randomUUID().toString().replace("-", "")

/** Test-only private JWT key in the production-required 64-hex format. */
fun strongJwtSecret(): String = strongEncryptionKey()

/** POSTs [body] as JSON — the contentType+setBody ceremony, owned once. */
suspend inline fun <reified T> HttpClient.postJson(path: String, body: T): HttpResponse =
    post(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

/** PUTs [body] as JSON. */
suspend inline fun <reified T> HttpClient.putJson(path: String, body: T): HttpResponse =
    put(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

/** The raw login POST — for tests asserting login behavior itself ([authedClient] wraps it). */
suspend fun HttpClient.login(email: String, password: String): HttpResponse =
    postJson("/api/v1/login", LoginRequest(email, password))

/** Logs in as [email] and returns a client that sends the bearer token on every request. */
suspend fun ApplicationTestBuilder.authedClient(email: String, password: String): HttpClient {
    val token = jsonClient().login(email, password).body<LoginResponse>().token
    return createClient {
        testClientDefaults()
        install(DefaultRequest) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
    }
}

/** Seeds a unique throwaway user and logs them in — the standard per-test caller fixture. */
suspend fun ApplicationTestBuilder.seededClient(prefix: String, role: UserRole = UserRole.USER): HttpClient {
    val email = uniqueEmail(prefix)
    TestUsers.seed(email = email, password = "pw", role = role)
    return authedClient(email, "pw")
}

/**
 * Captures a logger's events (the audit trail on `ch.nokillswit.audit`, or another logger — e.g.
 * the ROOT logger during application startup). Use in a try/finally with [detach]; [awaitEvent]
 * polls for asynchronously produced events.
 */
class LogCapture(loggerName: String) {
    private val logger = org.slf4j.LoggerFactory.getLogger(loggerName) as ch.qos.logback.classic.Logger
    // A copy-on-write list rather than Logback's ListAppender (a plain ArrayList): a capture on a
    // busy logger — the ROOT logger during application start, say — is appended to from other
    // threads while a test iterates `events`, which raised ConcurrentModificationException
    // (ported from Toadie).
    private val captured = java.util.concurrent.CopyOnWriteArrayList<ch.qos.logback.classic.spi.ILoggingEvent>()
    private val appender = object : ch.qos.logback.core.AppenderBase<ch.qos.logback.classic.spi.ILoggingEvent>() {
        override fun append(eventObject: ch.qos.logback.classic.spi.ILoggingEvent) {
            captured.add(eventObject)
        }
    }

    init {
        appender.start()
        logger.addAppender(appender)
    }

    val events: List<ch.qos.logback.classic.spi.ILoggingEvent> get() = captured

    fun detach() = logger.detachAppender(appender)

    suspend fun awaitEvent(
        predicate: (ch.qos.logback.classic.spi.ILoggingEvent) -> Boolean,
    ): ch.qos.logback.classic.spi.ILoggingEvent? {
        repeat(100) {
            events.firstOrNull(predicate)?.let { return it }
            kotlinx.coroutines.delay(50)
        }
        return null
    }
}

/**
 * audit() fields travel as SLF4J key/values, not in the message text — and TYPED: ids arrive
 * as Longs, flags as Booleans, so compare with the same type the emitter used.
 */
fun ch.qos.logback.classic.spi.ILoggingEvent.hasKeyValue(key: String, value: Any?) =
    keyValuePairs?.any { it.key == key && it.value == value } == true

/** The audit-trail capture scaffold: attaches to the audit logger and always detaches. */
suspend fun <T> withAuditCapture(block: suspend (LogCapture) -> T): T {
    val capture = LogCapture("ch.nokillswit.audit")
    return try {
        block(capture)
    } finally {
        capture.detach()
    }
}

/** Bootstrap/prod-mode scaffold: whatever [block] does to the seed admin is restored after. */
suspend fun withSeedRestored(block: suspend () -> Unit) {
    try {
        block()
    } finally {
        TestSeedState.restoreSeedAccounts()
    }
}

/** Asserts the app refuses to start and that the failure cause chain mentions [messagePart]. */
suspend fun assertStartupFails(messagePart: String, start: suspend () -> Unit) {
    val failure = runCatching { start() }.exceptionOrNull()
    kotlin.test.assertNotNull(failure, "startup must fail closed")
    val messages = generateSequence(failure) { it.cause }.mapNotNull { it.message }.joinToString(" | ")
    kotlin.test.assertTrue(messagePart in messages, "unexpected startup failure: $messages")
}

/** A fresh blocklist service (own cache) over the shared container DB, with an injected clock. */
internal fun newTokenBlocklistService(clock: () -> Long): ch.nokillswit.auth.TokenBlocklistService =
    ch.nokillswit.auth.TokenBlocklistService(sharedTestDatabase, clock)

internal fun newPasswordResetService(ttlMillis: Long = 900_000, clock: () -> Long = System::currentTimeMillis) =
    ch.nokillswit.auth.PasswordResetService(sharedTestDatabase, ttlMillis, clock)

/** The emailed token of a freshly minted grant, or null when [ch.nokillswit.auth.PasswordResetService.issue] refused (stale or capped). */
internal suspend fun ch.nokillswit.auth.PasswordResetService.issueToken(userId: UInt, credentialRevision: Long, email: String): String? =
    (issue(userId, credentialRevision, email) as? ch.nokillswit.auth.PasswordResetService.IssueOutcome.Issued)?.token

/** The digests of [userId]'s stored reset grants (the table never holds a raw token). */
internal suspend fun resetTokenHashes(userId: UInt): List<String> = suspendTransaction(sharedTestDatabase) {
    with(ch.nokillswit.auth.PasswordResetService.Grants) {
        selectAll().where { this@with.userId eq userId }.toList().map { it[tokenHash] }
    }
}

/** The shared test database — for fixtures that construct a service by hand (the encryption tests). */
fun sharedDatabaseForTests(): R2dbcDatabase = sharedTestDatabase

/**
 * POOLED like production (`connectPooledDatabase`, `.claude/docs/build-times.md` WHY 10): an unpooled
 * connect opened a fresh PostgreSQL backend per `suspendTransaction`. Small — the suite's test-side
 * calls are sequential, and a test holding a transaction open while another test-side call runs
 * needs a second connection; 8 leaves headroom and the acquire timeout turns a real deadlock into
 * a failure in seconds. Never disposed: the JVM exit (and the container's shutdown hook) ends it.
 */
private val sharedTestDatabase: R2dbcDatabase by lazy {
    val options = ConnectionFactoryOptions.parse(PostgresTestSupport.r2dbcUrl)
        .mutate()
        .option(ConnectionFactoryOptions.USER, PostgresTestSupport.user)
        .option(ConnectionFactoryOptions.PASSWORD, PostgresTestSupport.password)
        .build()
    connectPooledDatabase(
        options,
        maxSize = 10, // headroom for tests that claim several connections at once
        initialSize = 1,
        maxAcquireTime = Duration.ofSeconds(30),
        maxIdleTime = Duration.ofMinutes(10),
    ).first
}

object TestUsers {
    val service: UserService by lazy { UserService(sharedTestDatabase) }

    suspend fun seed(
        email: String,
        password: String,
        name: String = "Test",
        role: UserRole = UserRole.ADMIN,
        language: String = "en",
    ): UInt = service.create(
        User(
            name = name,
            email = email,
            passwordHash = hashPassword(password, cost = 4),
            role = role,
            language = language,
        )
    )

    /** Direct soft-delete for fixtures needing to bypass the endpoint's guards. */
    suspend fun softDelete(id: UInt) {
        suspendTransaction(sharedTestDatabase) {
            UserService.Users.update({ UserService.Users.id eq id }) {
                it[UserService.Users.markedAsDeleted] = true
            }
        }
    }

    /** Sets `password_changed_at` directly — the refresh test moves it past a token's `iat` instead of sleeping. */
    suspend fun stampPasswordChangedAt(id: UInt, epochMillis: Long) {
        suspendTransaction(sharedTestDatabase) {
            UserService.Users.update({ UserService.Users.id eq id }) {
                it[UserService.Users.passwordChangedAt] = epochMillis
            }
        }
    }

    /**
     * Runs [block] while the users in [soloAdminIds] are the ONLY active admins — every other
     * active ADMIN row (the seed admin and other tests' fixtures included) is temporarily
     * soft-deleted and restored in a finally. Backs the last-admin-protection tests, which
     * need `countActiveAdmins()` to be exact in the shared container.
     */
    suspend fun withSoloAdmins(soloAdminIds: Set<UInt>, block: suspend () -> Unit) {
        val parked: List<UInt> = suspendTransaction(sharedTestDatabase) {
            val others = UserService.Users.selectAll()
                .where {
                    (UserService.Users.role eq UserRole.ADMIN.name) and
                        (UserService.Users.markedAsDeleted eq false)
                }
                .map { it[UserService.Users.id].value }
                .toList()
                .filter { it !in soloAdminIds }
            UserService.Users.update({ UserService.Users.id inList others }) {
                it[UserService.Users.markedAsDeleted] = true
            }
            others
        }
        try {
            block()
        } finally {
            suspendTransaction(sharedTestDatabase) {
                UserService.Users.update({ UserService.Users.id inList parked }) {
                    it[UserService.Users.markedAsDeleted] = false
                }
            }
        }
    }
}

/** A lease no test clock ever reaches (year ~2286) — how [withOnlyConnections] parks other connections' jobs. */
internal const val PARKED_LEASE_UNTIL = 9_999_999_999_999L

private const val PARKED_LEASE_OWNER = "test-parked"

/**
 * Fences `IngestWorker.tick()`: a tick enqueues due jobs for EVERY enabled connection in the shared
 * database and claims from the ENTIRE shared queue, so an unfenced tick runs whatever other classes
 * left behind (measured: ~14 pending DERIVEs, one of the 1,200-issue shared stub at ~4 s, plus a SYNC
 * and its chained DERIVE per enabled foreign connection — `.claude/docs/build-times.md` WHY 11).
 *
 * Runs [block] with, for every connection NOT in [ownConnectionIds]: `enabled` switched off (no
 * `config_revision` bump, so nothing is enqueued), and every job the claim scan could pick up — a
 * PENDING row, or a RUNNING row whose `lease_until` is below [leaseClockMillis] (the tick's own
 * clock; an expired lease is re-claimable) — parked as a RUNNING row leased far beyond any test
 * clock. The setup is ONE transaction (a failure part-way leaves nothing changed) and the restore
 * runs in a `finally`: every parked job gets its original status, lease owner and lease back and
 * every disabled connection is re-enabled — the [TestUsers.withSoloAdmins] precedent, shared state
 * is borrowed, never destroyed. Jobs of [ownConnectionIds] are untouched.
 */
internal suspend fun <T> withOnlyConnections(ownConnectionIds: Set<UInt>, leaseClockMillis: Long, block: suspend () -> T): T {
    data class Parked(val id: Int, val status: String, val leaseOwner: String?, val leaseUntil: Long?)

    fun <R> transaction(body: (java.sql.Connection) -> R): R =
        PostgresTestSupport.connect()
            .use { c ->
                c.autoCommit = false
                try {
                    body(c).also { c.commit() }
                } catch (e: Throwable) {
                    c.rollback()
                    throw e
                }
            }

    val own = ownConnectionIds.map { it.toInt() }.toTypedArray()
    val (parkedConnections, parkedJobs) = transaction { c ->
        val ownArray = c.createArrayOf("integer", own)
        val disable = "UPDATE source_connections SET enabled = FALSE WHERE enabled AND id <> ALL(?) RETURNING id"
        val connections = c.prepareStatement(disable).use { st ->
            st.setArray(1, ownArray)
            st.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getInt(1)) } }
        }
        val claimable = "SELECT id, status, lease_owner, lease_until FROM sync_jobs WHERE connection_id <> ALL(?) AND " +
            "(status = 'PENDING' OR (status = 'RUNNING' AND lease_until < ?))"
        val jobs = c.prepareStatement(claimable).use { st ->
            st.setArray(1, ownArray)
            st.setLong(2, leaseClockMillis)
            st.executeQuery().use { rs ->
                buildList { while (rs.next()) add(Parked(rs.getInt(1), rs.getString(2), rs.getString(3), rs.getObject(4) as Long?)) }
            }
        }
        val park = "UPDATE sync_jobs SET status = 'RUNNING', lease_owner = '$PARKED_LEASE_OWNER', lease_until = ? WHERE id = ANY(?)"
        c.prepareStatement(park).use { st ->
            st.setLong(1, PARKED_LEASE_UNTIL)
            st.setArray(2, c.createArrayOf("integer", jobs.map { it.id }.toTypedArray()))
            st.executeUpdate()
        }
        connections to jobs
    }
    try {
        return block()
    } finally {
        transaction { c ->
            val unpark = "UPDATE sync_jobs SET status = ?, lease_owner = ?, lease_until = ? " +
                "WHERE id = ? AND lease_owner = '$PARKED_LEASE_OWNER'"
            c.prepareStatement(unpark).use { st ->
                for (job in parkedJobs) {
                    st.setString(1, job.status)
                    st.setString(2, job.leaseOwner)
                    st.setObject(3, job.leaseUntil, java.sql.Types.BIGINT)
                    st.setInt(4, job.id)
                    st.addBatch()
                }
                st.executeBatch()
            }
            c.prepareStatement("UPDATE source_connections SET enabled = TRUE WHERE id = ANY(?)").use { st ->
                st.setArray(1, c.createArrayOf("integer", parkedConnections.toTypedArray()))
                st.executeUpdate()
            }
        }
    }
}

object TestSeedState {
    suspend fun restoreSeedAccounts() {
        suspendTransaction(sharedTestDatabase) {
            UserService.Users.update({ UserService.Users.email eq SEED_ADMIN_EMAIL }) {
                it[UserService.Users.passwordHash] = SEED_PASSWORD_HASH
                it[UserService.Users.markedAsDeleted] = false
                it[UserService.Users.passwordChangedAt] = 0
                it[UserService.Users.credentialRevision] = 0
                // A test flipping the seed admin's language must not leak into other tests.
                it[UserService.Users.language] = "en"
            }
        }
    }
}

/** Direct team fixtures — raw reads past the routes (the soft-delete assertions) and quick seeding. */
object TestTeams {
    val service: ch.nokillswit.teams.TeamService by lazy { ch.nokillswit.teams.TeamService(sharedTestDatabase) }

    suspend fun seed(name: String): UInt = service.create(ch.nokillswit.teams.TeamCreateRequest(name = name))

    data class RawTeam(val id: UInt, val name: String, val markedAsDeleted: Boolean)

    suspend fun rawRows(): List<RawTeam> = suspendTransaction(sharedTestDatabase) {
        val t = ch.nokillswit.teams.TeamService.Teams
        t.selectAll().map { RawTeam(it[t.id].value, it[t.name], it[t.markedAsDeleted]) }.toList()
    }
}

/** Direct people fixtures (V10) — quick seeding (optionally linked to a login) and raw reads past the routes. */
object TestPeople {
    val service: ch.nokillswit.people.PersonService by lazy { ch.nokillswit.people.PersonService(sharedTestDatabase) }

    suspend fun seed(name: String, userId: UInt? = null, email: String? = null): UInt =
        service.create(ch.nokillswit.people.PersonCreateRequest(name = name, email = email, userId = userId))

    /** Direct soft-delete for fixtures needing to bypass the delete endpoint's guards. */
    suspend fun softDelete(id: UInt) {
        suspendTransaction(sharedTestDatabase) {
            val p = ch.nokillswit.people.PersonService.People
            p.update({ p.id eq id }) { it[p.markedAsDeleted] = true }
        }
    }

    data class RawPerson(val id: UInt, val name: String, val email: String?, val userId: UInt?, val markedAsDeleted: Boolean)

    suspend fun rawRows(): List<RawPerson> = suspendTransaction(sharedTestDatabase) {
        val p = ch.nokillswit.people.PersonService.People
        p.selectAll().map { RawPerson(it[p.id].value, it[p.name], it[p.email], it[p.userId]?.value, it[p.markedAsDeleted]) }.toList()
    }
}

/**
 * Polls `pg_stat_activity` until some OTHER session is waiting on a lock inside a statement whose text contains [queryFragment]
 * (case-insensitive): the "the request under test reached its lock wait" barrier of a deterministic concurrency test. The test
 * holds the conflicting lock on a raw JDBC connection, starts the request asynchronously, calls this, then releases the lock.
 * [waiters] is how many sessions must be waiting at once (a test that races two requests for one lock waits for both).
 */
suspend fun awaitLockWait(queryFragment: String, waiters: Int = 1) = withTimeout(30_000) {
    PostgresTestSupport.connect().use { probe ->
        while (true) {
            val waiting = probe.prepareStatement(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND query ILIKE ?",
            ).use { st ->
                st.setString(1, "%$queryFragment%")
                st.executeQuery().use { rs ->
                    rs.next()
                    rs.getInt(1)
                }
            }
            if (waiting >= waiters) break
            delay(50)
        }
    }
}

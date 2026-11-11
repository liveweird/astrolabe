package ch.nokillswit.plugins

import ch.nokillswit.authz.caller
import ch.nokillswit.infra.config.requireConfigInt
import io.ktor.server.application.*
import io.ktor.server.plugins.origin
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.util.AttributeKey
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Duration.Companion.seconds

/** The name of the bucket a call last rode, stamped by its `requestKey`; read by the 429 audit in ErrorHandling.kt. */
internal val RateLimitBucketKey = AttributeKey<String>("RateLimitBucket")

/**
 * The authenticated user id the PER-USER telemetry bucket keyed the call by, stamped by its `requestKey`;
 * absent on the per-IP buckets. The 429 audit carries it as `byUserId` and throttles per user: it is the server-minted JWT claim
 * of a verified token, never client-chosen text.
 */
internal val RateLimitUserKey = AttributeKey<UInt>("RateLimitUser")

/**
 * Coalesces the `rate_limit.exceeded` audit event (checkup 2C15): an unauthenticated flood must not write one audit line
 * per rejected request. At most ONE event per key per [intervalMs]; [admit] returns the number of rejections folded
 * into the previous window (the event's `suppressed` field) when the caller should emit now, or null when this rejection
 * is folded into the current window. The key is the bucket name for a per-IP bucket (a handful of fixed names, never the
 * client) and `bucket:userId` for a per-user bucket (only a verified, signed-in account can reach it, so the key space is the
 * number of accounts), so memory is bounded no matter who floods; thread-safe via [ConcurrentHashMap.compute]'s per-key atomicity.
 */
internal class RateLimitAuditThrottle(
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Window(var lastEmitMs: Long, var suppressed: Long)

    private val windows = ConcurrentHashMap<String, Window>()

    fun admit(bucket: String): Long? {
        var emit: Long? = null
        windows.compute(bucket) { _, window ->
            val now = clock()
            when {
                window == null -> Window(now, 0).also { emit = 0 }
                now - window.lastEmitMs >= intervalMs -> window.also {
                    emit = it.suppressed
                    it.lastEmitMs = now
                    it.suppressed = 0
                }
                else -> window.also { it.suppressed++ }
            }
        }
        return emit
    }

    companion object {
        const val DEFAULT_INTERVAL_MS = 60_000L
    }
}

/**
 * Every token bucket the routes ride (per client IP, except [TELEMETRY], [JIRA_BIND], [JIRA_IMPORT], [PASSWORD_CHANGE] and [SYNC_RUN]:
 * per signed-in user), named in one place so a feature module never has to know another's constant (the auth module used to import
 * the try-it bucket's name — a layering inversion the checkup removed). Route files reference these names; only this plugin
 * installs them.
 */
object RateLimits {
    const val LOGIN = "login"
    const val REFRESH = "refresh"
    const val PASSWORD_RESET = "password-reset"
    const val MFA = "mfa"
    /** `POST /api/v1/password-reset/confirm` - the link's token exchange, 10/min per IP in every mode (the [MFA] idiom). */
    const val PASSWORD_RESET_CONFIRM = "password-reset-confirm"
    /**
     * Both Test-connection routes of the Jira sync (`POST /api/v1/integrations/jira/connections/test` and `…/{id}/test`) and Peek, per IP:
     * 10/min by default in every mode, pinnable within 1..100 via `security.rateLimit.jiraTestPerMinute` (the e2e stacks set 30). Each call
     * makes up to ~10 outbound requests with the stored token, so the bound is for a runaway client.
     */
    const val JIRA_TEST = "jira-test"
    /**
     * Both Test-connection routes of the Flow sync (`POST /api/v1/integrations/flow/connections/test` and `…/{id}/test`), per IP, its own
     * bucket (a Flow test never spends a Jira one): 10/min by default in every mode, pinnable within 1..100 via
     * `security.rateLimit.flowTestPerMinute` (the e2e stacks set 30). Each call makes two outbound requests with the token, so the
     * bound is for a runaway client.
     */
    const val FLOW_TEST = "flow-test"
    /** `GET /api/v1/ready` — the one anonymous route that takes a pooled DB connection per call (checkup D7-2, A16). */
    const val READY = "ready"
    /**
     * Both `GET /api/v1/telemetry/…` reads share ONE bucket per SIGNED-IN USER (the JWT's `userId`, never the client address: a NAT'd
     * office is not one bucket and changing IP buys nothing): 30/min in every mode. The panel polls `current` once a minute and
     * fetches a history per expanded section, a handful of calls a minute; the bound is for a runaway client, since each call is a
     * few `ops` aggregations.
     */
    const val TELEMETRY = "telemetry"
    /**
     * `POST /api/v1/integrations/jira/bindings` - 30/min per SIGNED-IN USER in every mode. A bind makes up to two outbound calls with the
     * connection's stored token on behalf of any node owner, so the shared Jira quota and the enumeration the pre-flight answers
     * (`authorization.md`) are bounded per account; a NAT'd office is not one bucket. A human links a handful of nodes a minute.
     */
    const val JIRA_BIND = "jira-bind"
    /**
     * `POST /api/v1/integrations/jira/connections/{id}/import-preview` (and, with the apply, `…/import`; `jira/JiraImportRoutes.kt`):
     * 5/min per SIGNED-IN USER in every mode, ONE bucket for both. Each call browses the connection's whole scope (up to 200 search
     * pages, plus up to 200 by-id parent reads under a filter) with the stored token on behalf of any plan-node owner, so the shared
     * Jira quota is bounded per account; it rides the route node, so it runs before the guard. It limits the RATE, not the concurrency:
     * see `security.md`.
     */
    const val JIRA_IMPORT = "jira-import"
    /**
     * `PUT /api/v1/users/{id}/password` (`users/UserRoutes.kt`): 10/min per SIGNED-IN USER in every mode, keyed by the CALLER (the verified
     * JWT `userId`), never the path id, so an admin resetting somebody else's password spends the admin's own tokens and the target's
     * attempts can never starve it. One bucket covers the self change and the admin reset (the route cannot tell them apart before the
     * guard); it rides the route node, so it runs before the lock preflight and before the cost-12 bcrypt verify: a burst from one
     * account stops paying CPU after ten requests instead of after the lock trips. Ten because a human changing a password needs a few
     * tries (a typo in the current password, a refused new one) and the wrong-current lock (5 attempts) is the guess budget, not this.
     */
    const val PASSWORD_CHANGE = "password-change"
    /**
     * `POST /api/v1/integrations/sync/runs` (Refresh now, `sync/SyncRoutes.kt`): per SIGNED-IN USER in every mode, ONE bucket for both
     * kinds (a Flow press and a Jira press count together; the list GET and the scheduler ride none). 10 presses per fixed 60-second
     * window per account (Ktor refills the whole window at once, so a burst across a window edge can admit up to 20); each press is one
     * run, bounded by its page ceilings, the probe cap (100 by-id reads since 1.13) and the one-unfinished-run-per-connection claim (the
     * security audit's L1). It rides the route node, so it runs before the guard and a refused press spends a token too.
     */
    const val SYNC_RUN = "sync-run"

    const val DEFAULT_REFRESH_PER_MINUTE = 30
    /**
     * 60/min per IP: the kubelet probes `/ready` every 5 s per container (12/min, `k8s/app-deployment.yaml`; the e2e global setup
     * polls every 2 s = 30/min), so real probers stay at a fifth to a half
     * of it, while one host can no longer hold the 20-connection pool busy with a flood of anonymous round trips.
     */
    const val DEFAULT_READY_PER_MINUTE = 60
    private const val MAX_LIMIT_PER_MINUTE = 1_000_000
    private const val TELEMETRY_PER_MINUTE = 30
    private const val JIRA_BIND_PER_MINUTE = 30
    private const val JIRA_IMPORT_PER_MINUTE = 5
    private const val PASSWORD_CHANGE_PER_MINUTE = 10
    private const val SYNC_RUN_PER_MINUTE = 10
    private const val MFA_PER_MINUTE = 10
    private const val PASSWORD_RESET_CONFIRM_PER_MINUTE = 10
    private const val JIRA_TEST_PER_MINUTE = 10
    private const val JIRA_TEST_MAX_PER_MINUTE = 100
    private const val FLOW_TEST_PER_MINUTE = 10
    private const val FLOW_TEST_MAX_PER_MINUTE = 100
    private const val LOGIN_PER_MINUTE_PRODUCTION = 10
    private const val LOGIN_PER_MINUTE_DEVELOPMENT = 1000
    private const val RESET_PER_MINUTE_PRODUCTION = 5
    private const val RESET_PER_MINUTE_DEVELOPMENT = 100

    /** Blank follows the mode; a number pins the bucket in either mode (the `http.exposeOpenApi` idiom). */
    internal fun Application.configuredLimit(key: String, default: Int, max: Int = MAX_LIMIT_PER_MINUTE): Int =
        if (environment.config.propertyOrNull(key)?.getString().isNullOrBlank()) {
            default
        } else {
            // Boot-validated: a non-numeric or non-positive limit (0 blocks every request) refuses startup.
            requireConfigInt(environment.config, key, min = 1, max = max)
        }

    internal fun Application.loginLimit() = configuredLimit(
        "security.rateLimit.loginPerMinute",
        if (developmentMode) LOGIN_PER_MINUTE_DEVELOPMENT else LOGIN_PER_MINUTE_PRODUCTION,
    )
    internal fun Application.refreshLimit() = configuredLimit("security.rateLimit.refreshPerMinute", DEFAULT_REFRESH_PER_MINUTE)
    internal fun Application.readyLimit() = configuredLimit("security.rateLimit.readyPerMinute", DEFAULT_READY_PER_MINUTE)
    internal fun Application.passwordResetLimit() = configuredLimit(
        "security.rateLimit.passwordResetPerMinute",
        if (developmentMode) RESET_PER_MINUTE_DEVELOPMENT else RESET_PER_MINUTE_PRODUCTION,
    )
    internal fun telemetryLimit() = TELEMETRY_PER_MINUTE
    internal fun jiraBindLimit() = JIRA_BIND_PER_MINUTE
    internal fun jiraImportLimit() = JIRA_IMPORT_PER_MINUTE
    internal fun passwordChangeLimit() = PASSWORD_CHANGE_PER_MINUTE
    internal fun syncRunLimit() = SYNC_RUN_PER_MINUTE
    internal fun mfaLimit() = MFA_PER_MINUTE
    internal fun passwordResetConfirmLimit() = PASSWORD_RESET_CONFIRM_PER_MINUTE
    /** The shipped manifests keep 10; the e2e stacks (compose, the OrbStack overlay) pin 30. Capped at 100: each call fans out to Jira. */
    internal fun Application.jiraTestLimit() =
        configuredLimit("security.rateLimit.jiraTestPerMinute", JIRA_TEST_PER_MINUTE, max = JIRA_TEST_MAX_PER_MINUTE)

    /** The `jiraTestLimit` idiom for Flow: the shipped manifests keep 10, the e2e stacks pin 30; capped at 100. */
    internal fun Application.flowTestLimit() =
        configuredLimit("security.rateLimit.flowTestPerMinute", FLOW_TEST_PER_MINUTE, max = FLOW_TEST_MAX_PER_MINUTE)
}

/**
 * The buckets (see application.yaml `security.rateLimit` and security.md): per IP, except the per-USER buckets (telemetry,
 * jira-bind, jira-import, password-change, sync-run). Login and password-reset follow the mode — production keeps them tight, development
 * lifts them so one host driving the e2e suite is not throttled (the per-account lockout and the per-email throttle are the
 * abuse defences in both modes); refresh, ready, MFA and the password-reset confirm are the same in every mode. Installed here,
 * before the feature modules, so any route may ride any bucket regardless of module order.
 */
fun Application.configureRateLimits() {
    val buckets = with(RateLimits) {
        mapOf(
            LOGIN to loginLimit(),
            REFRESH to refreshLimit(),
            PASSWORD_RESET to passwordResetLimit(),
            MFA to mfaLimit(),
            PASSWORD_RESET_CONFIRM to passwordResetConfirmLimit(),
            JIRA_TEST to jiraTestLimit(),
            FLOW_TEST to flowTestLimit(),
            READY to readyLimit(),
        )
    }
    val perUserBuckets = with(RateLimits) {
        mapOf(
            TELEMETRY to telemetryLimit(),
            JIRA_BIND to jiraBindLimit(),
            JIRA_IMPORT to jiraImportLimit(),
            PASSWORD_CHANGE to passwordChangeLimit(),
            SYNC_RUN to syncRunLimit(),
        )
    }
    install(RateLimit) {
        buckets.forEach { (name, limit) ->
            register(RateLimitName(name)) {
                rateLimiter(limit = limit, refillPeriod = 60.seconds)
                requestKey { call ->
                    // The plugin gives its 429 no handle on the bucket, but it computes this key right before
                    // rejecting, so the name stamped here is the rejecting bucket's (the `rate_limit.exceeded` audit).
                    call.attributes.put(RateLimitBucketKey, name)
                    call.request.origin.remoteHost
                }
            }
        }
        // The per-USER buckets (telemetry, jira-bind, jira-import, password-change, sync-run). The routes mount them INSIDE
        // `authenticate {}` (telemetry/TelemetryRoutes.kt, jira/JiraBindingRoutes.kt, users/UserRoutes.kt, sync/SyncRoutes.kt), so this key
        // runs only for a verified token: an anonymous call is a 401 that never reaches it
        // and never creates a limiter. The plugin keeps one limiter per key and drops it after its refill period, so memory is
        // bounded by the accounts active within a minute.
        perUserBuckets.forEach { (name, limit) ->
            register(RateLimitName(name)) {
                rateLimiter(limit = limit, refillPeriod = 60.seconds)
                requestKey { call ->
                    call.attributes.put(RateLimitBucketKey, name)
                    val userId = call.caller().userId
                    call.attributes.put(RateLimitUserKey, userId)
                    userId
                }
            }
        }
    }
}

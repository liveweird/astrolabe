package ch.nokillswit.auth

import ch.nokillswit.infra.maskedSecret
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.TreeMap

/**
 * In-memory store of pending email-MFA challenges (Lettuce's, ported): a login with correct
 * credentials by an MFA-enabled user mints a challenge — an opaque id handed to the client
 * plus a 6-digit code emailed to the account — and the pair must come back to
 * POST /api/v1/login/mfa within [ttlMillis] and [maxAttempts] guesses. A challenge is
 * single-use: consumed on success, dropped on expiry or when the attempt cap is exceeded.
 *
 * In-memory and per-instance by design (the LoginThrottle posture): the deployment runs a
 * single replica, and a restart only invalidates pending challenges — the user simply signs
 * in again. Multiple live challenges per account (repeated logins) are accepted: the short
 * TTL, the attempt cap, and the login rate bucket bound the guessing surface
 * (≤ maxAttempts·10⁻⁶ per challenge). At most [maxLivePerAccount] challenges stay live for one
 * account: a new login gets a fresh code (unless the shared store is genuinely full) and, at the
 * limit, the account's oldest live challenge is dropped (it can no longer verify). That bounds memory and stops one leaked password
 * from filling the shared store; it does not bound mails or guesses per account (the per-IP buckets do).
 */
class MfaChallenges(
    private val ttlMillis: Long,
    private val maxAttempts: Int,
    private val maxTracked: Int = 10_000,
    private val maxLivePerAccount: Int = 3,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    init {
        require(maxTracked > 0) { "maxTracked must be positive" }
        require(maxLivePerAccount > 0) { "maxLivePerAccount must be positive" }
    }

    class CapacityExceededException : RuntimeException()

    /** [evicted] = this account's older challenges dropped by the issue (stale revision or over the limit). */
    data class IssuedChallenge(val challengeId: String, val code: String, val expiresAt: Long, val evicted: Int = 0) {
        override fun toString(): String =
            "IssuedChallenge(challengeId=${maskedSecret(challengeId)}, code=${maskedSecret(code)}, " +
                "expiresAt=$expiresAt, evicted=$evicted)"
    }

    sealed interface Outcome {
        data class Success(val userId: UInt, val credentialRevision: Long) : Outcome

        /** [reason] feeds the audit trail only — the HTTP answer stays a uniform 401. */
        data class Failure(val reason: String) : Outcome
    }

    private data class Challenge(
        val userId: UInt,
        val credentialRevision: Long,
        val code: String,
        val expiresAt: Long,
        val attempts: Int,
        /** Issue order, from [issueSeq]: the deterministic "oldest" even when the clock ties. */
        val seq: Long,
    ) {
        override fun toString(): String =
            "Challenge(userId=$userId, credentialRevision=$credentialRevision, code=${maskedSecret(code)}, " +
                "expiresAt=$expiresAt, attempts=$attempts, seq=$seq)"
    }

    private val challenges = mutableMapOf<String, Challenge>()
    private val expiryIndex = TreeMap<Long, MutableSet<String>>()
    private val lock = Any()
    private var issueSeq = 0L

    fun issue(userId: UInt, credentialRevision: Long): IssuedChallenge = synchronized(lock) {
        val now = clock()
        pruneExpired(now)
        val evicted = evictForAccount(userId, credentialRevision)
        // After the eviction: an account at its limit frees a slot first, so a full store cannot
        // refuse it; the global 429 stays for a genuinely full store.
        if (challenges.size >= maxTracked) throw CapacityExceededException()
        val id = generateChallengeId()
        val code = generateMfaCode()
        val expiresAt = now + ttlMillis
        challenges[id] = Challenge(userId, credentialRevision, code, expiresAt, attempts = 0, seq = issueSeq++)
        expiryIndex.getOrPut(expiresAt) { mutableSetOf() }.add(id)
        IssuedChallenge(id, code, expiresAt, evicted)
    }

    fun verify(challengeId: String, code: String): Outcome = synchronized(lock) {
        val challenge = challenges[challengeId]
            ?: return@synchronized Outcome.Failure("unknown_challenge")
        if (challenge.expiresAt <= clock()) {
            removeChallenge(challengeId)
            return@synchronized Outcome.Failure("expired")
        }
        if (MessageDigest.isEqual(challenge.code.toByteArray(), code.toByteArray())) {
            removeChallenge(challengeId)
            return@synchronized Outcome.Success(challenge.userId, challenge.credentialRevision)
        }
        val attempts = challenge.attempts + 1
        if (attempts >= maxAttempts) {
            removeChallenge(challengeId)
            Outcome.Failure("too_many_attempts")
        } else {
            challenges[challengeId] = challenge.copy(attempts = attempts)
            Outcome.Failure("wrong_code")
        }
    }

    /** Drops an issued challenge when its delivery fails, immediately releasing its slot. */
    fun discard(challengeId: String) = synchronized(lock) {
        removeChallenge(challengeId)
    }

    /**
     * The account's challenges to drop before a new one: those minted under an OLDER credential
     * revision (the password changed since - they can never verify), then the oldest of the same
     * revision by issue order until a slot is free. Entries of a NEWER revision are never touched, so
     * a late login that read an old revision cannot evict the owner's current challenge (revisions
     * only increment; its own entry can never verify either and just expires). Expired entries are
     * already pruned, so only live ones count. O(n) over <= maxTracked under the lock - cheap next
     * to the bcrypt login that precedes an issue. Returns how many were dropped.
     */
    private fun evictForAccount(userId: UInt, credentialRevision: Long): Int {
        val mine = challenges.entries
            .filter { it.value.userId == userId }
            .map { it.key to it.value }
        val stale = mine.filter { it.second.credentialRevision < credentialRevision }
        stale.forEach { removeChallenge(it.first) }
        val same = mine.filter { it.second.credentialRevision == credentialRevision }
        val overflow = (same.size - (maxLivePerAccount - 1)).coerceAtLeast(0)
        same.sortedBy { it.second.seq }.take(overflow).forEach { removeChallenge(it.first) }
        return stale.size + overflow
    }

    private fun pruneExpired(now: Long) {
        while (expiryIndex.firstEntry()?.key?.let { it <= now } == true) {
            val (expiresAt, ids) = expiryIndex.pollFirstEntry()
            ids.forEach { id ->
                if (challenges[id]?.expiresAt == expiresAt) challenges.remove(id)
            }
        }
    }

    private fun removeChallenge(id: String): Boolean {
        val removed = challenges.remove(id) ?: return false
        expiryIndex[removed.expiresAt]?.let { ids ->
            ids.remove(id)
            if (ids.isEmpty()) expiryIndex.remove(removed.expiresAt)
        }
        return true
    }

    private companion object {
        val secureRandom = SecureRandom()

        /** 128 bits of opaque, unguessable challenge identity. */
        fun generateChallengeId(): String {
            val bytes = ByteArray(16)
            secureRandom.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}

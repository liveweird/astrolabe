package ch.nokillswit.auth

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.UnauthorizedException
import ch.nokillswit.infra.db.nowMillis
import com.auth0.jwt.exceptions.JWTVerificationException
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.*
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.CannotTransformContentToTypeException
import io.ktor.server.request.receive
import io.ktor.server.request.receiveNullable
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post

// The session-lifecycle half of the auth routes: refresh (rotation) and logout. Registered by `configureAuthRoutes`
// (AuthRoutes.kt) as before the split: refresh under its `RateLimits.REFRESH` bucket, logout inside `authenticate`.

internal fun Route.refresh(deps: AuthDeps) {
    val jwtConfig = deps.jwtConfig
    val userService = deps.userService
    val blocklist = deps.blocklist
    val refreshVerifier = deps.refreshVerifier
    // Not behind `authenticate`: the access token may already be expired here. Pure-sliding with
    // ROTATION: the presented refresh token is blocklisted (until its own expiry) by an atomic claim
    // and a fresh pair is minted, so the token works once. A replay inside REFRESH_REPLAY_GRACE_MS of
    // the rotation still gets a pair (the response was probably lost); beyond it, a `replayed` 401.
    // The access token it was paired with is left to expire on its own (<= 15 min).
    post("/api/v1/refresh") {
        val req = call.receive<RefreshRequest>()
        fun reject(reason: String, userId: Long? = null): Nothing {
            audit("refresh.rejected", "reason" to reason, "userId" to userId)
            throw UnauthorizedException(REFRESH_REJECT_MESSAGES[reason] ?: "Refresh token rejected")
        }

        val decoded = try {
            refreshVerifier.verify(req.refreshToken)
        } catch (_: JWTVerificationException) {
            reject("invalid_or_expired")
        }
        if (decoded.getClaim("typ").asString() != TOKEN_TYPE_REFRESH) {
            reject("wrong_token_type")
        }
        val rawUserId = decoded.strictLongClaim("userId")
        // A jti-less token could never be blocklisted, so it is malformed by definition
        // (every server-minted token carries one).
        val jti = decoded.id ?: reject("malformed", rawUserId)
        // The cheap fast path (one plain select); a recently rotated token is let through to the claim below.
        if (blocklist.isRevoked(jti) && !blocklist.inReplayGrace(jti)) {
            reject(if (blocklist.wasRotated(jti)) "replayed" else "revoked", rawUserId)
        }
        val userId = rawUserId
            ?.takeIf { it in 1..UInt.MAX_VALUE.toLong() }
            ?.toUInt()
            ?: reject("malformed")
        // One read: confirm the user still exists and isn't soft-deleted, and pick up their
        // current role/email so changes take effect on the next refresh.
        val user = userService.read(userId)
            ?: reject("user_gone", rawUserId)
        // Exact credential generation: legacy tokens without the claim and malformed numeric
        // representations are rejected rather than falling back to timestamp ordering.
        val credentialRevision = decoded.strictLongClaim("credentialRevision")
            ?.takeIf { it >= 0 }
            ?: reject("malformed", rawUserId)
        if (credentialRevision != user.credentialRevision) {
            reject("credential_changed", rawUserId)
        }
        // Rotation: claim the presented token LAST, after every other check passed, with one atomic
        // insert. Two concurrent refreshes with the same token both pass the fast path above; only the
        // insert's winner is CLAIMED, the other is answered by the grace (its own pair) or rejected.
        val expiresAt = decoded.expiresAt?.time ?: reject("malformed", rawUserId)
        when (blocklist.claimRefresh(jti, expiresAt, userId.toLong())) {
            RefreshClaim.CLAIMED -> Unit
            RefreshClaim.GRACE_REPLAY -> audit("refresh.replay_grace", "userId" to rawUserId)
            RefreshClaim.REPLAYED -> reject("replayed", rawUserId)
            RefreshClaim.REVOKED -> reject("revoked", rawUserId)
        }
        call.respond(HttpStatusCode.OK, jwtConfig.authResponse(userId, user))
    }
}

internal fun Route.logout(deps: AuthDeps) {
    val blocklist = deps.blocklist
    val refreshVerifier = deps.refreshVerifier
    post("/api/v1/logout") {
        val principal = call.principal<JWTPrincipal>()!!
        // A logout ends the replay grace of this user's recently rotated refresh tokens (a copy of one
        // must not mint after sign-out); the access principal is what logout already trusts.
        principal.payload.getClaim("userId").asLong()?.let { blocklist.forgetRotations(it) }
        val jti = principal.payload.id
        val exp = principal.payload.expiresAt?.time ?: nowMillis()
        if (jti != null) {
            blocklist.revoke(jti, exp)
        }
        // Also revoke the refresh token, if the client sent it, so an explicit logout kills it
        // too (a refresh token is also blocklisted when it is rotated, but logout ends the live one).
        // Best-effort by design (logout always answers 204), but the failures are NARROW
        // and logged — a blanket catch would silently skip revocation on unrelated errors
        // and swallow coroutine cancellation.
        val body = try {
            call.receiveNullable<LogoutRequest>()
        } catch (cause: BadRequestException) {
            // ContentNegotiation's malformed-JSON wrap. The cause chain can embed a body
            // excerpt (kotlinx's decode error message) — log the exception CLASS NAME
            // only, the login.mfa_send_failed/password_reset.send_failed `errorType` rule
            // (.claude/docs/observability.md), never the throwable itself.
            val errorType = cause.cause?.javaClass?.simpleName ?: cause.javaClass.simpleName
            call.application.log.debug(
                "Logout body unparsable — skipping refresh-token revocation ({})",
                errorType,
            )
            null
        } catch (cause: CannotTransformContentToTypeException) {
            // A body-less/Content-Type-less POST never enters ContentNegotiation.
            call.application.log.debug(
                "Logout sent no body — skipping refresh-token revocation ({})",
                cause.javaClass.simpleName,
            )
            null
        }
        body?.refreshToken?.let { rt ->
            val decoded = try {
                refreshVerifier.verify(rt)
            } catch (cause: JWTVerificationException) {
                // auth0's JWTDecodeException message can embed the decoded token segment —
                // class name only, same errorType rule as above.
                call.application.log.debug(
                    "Logout refresh token invalid — nothing to revoke ({})",
                    cause.javaClass.simpleName,
                )
                null
            }
            // Covers a mismatched pair too: the presented refresh token's own user loses its grace as well.
            decoded?.strictLongClaim("userId")?.let { blocklist.forgetRotations(it) }
            decoded?.id?.let { rjti ->
                blocklist.revoke(rjti, decoded.expiresAt?.time ?: nowMillis())
            }
        }
        audit(
            "logout",
            "userId" to principal.payload.getClaim("userId").asLong(),
            "email" to principal.payload.getClaim("email").asString(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
}

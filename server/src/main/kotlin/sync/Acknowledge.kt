package ch.nokillswit.sync

import io.ktor.server.plugins.BadRequestException

/*
 * The acknowledge vocabulary both connectors share (Jira's per-binding acknowledge, 1.3; Flow's per-sprint capacity acknowledge, 1.9):
 * ONE `409` problem type, so the web has ONE `isStaleDeviations` predicate, and ONE shape rule for the fingerprint a client echoes.
 * The fingerprint itself is `infra/json`'s `fingerprintOf`. `sync/` names no connector; `jira/` and `flow/` import from here.
 */

/**
 * `409` problem type of an acknowledge: the fingerprint the client saw is not the one of the deviation now, or there is nothing to
 * acknowledge. The client re-reads the view and decides again.
 */
const val STALE_DEVIATIONS_PROBLEM = "urn:astrolabe:problem:stale-deviations"

private val FINGERPRINT_SHAPE = Regex("^[0-9a-f]{64}$")

/** The shape rule of an echoed fingerprint (64 lower-case hex), shared by both acknowledge routes and services: a `400` otherwise. */
fun requireFingerprintShape(value: String) {
    if (!FINGERPRINT_SHAPE.matches(value)) {
        throw BadRequestException("fingerprint must be 64 lower-case hexadecimal characters")
    }
}

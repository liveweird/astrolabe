package ch.nokillswit.planning

import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import kotlinx.serialization.Serializable

/**
 * Programs (V12), the middle level: a name (unique among active programs, globally), an optional description and a REQUIRED owner,
 * under one work stream. The parent is fixed at create (`POST /work-streams/{id}/programs`) and never part of an update body — a
 * reparent endpoint is a v0.3 addition (`planning-model.md`).
 */
@Serializable
data class ProgramCreateRequest(
    val name: String,
    val description: String? = null,
    /** The owner — an ACTIVE person (400 otherwise). */
    val ownerPersonId: UInt,
)

/** PUT is a full replace: an omitted description is unset. */
typealias ProgramUpdateRequest = ProgramCreateRequest

@Serializable
data class ProgramResponse(
    val id: UInt,
    val workStreamId: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val createdAt: Long,
    val updatedAt: Long,
)

/** What the update replaced, for the audit delta: the STORED owner before the write. */
data class ProgramUpdateOutcome(val ownerFrom: UInt)

fun ProgramCreateRequest.sanitized(): ProgramCreateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description))

/** The program rules — enforced by the route AND re-checked by the service. */
fun validateProgram(request: ProgramCreateRequest) =
    requireNameAndDescription(request.name, request.description, MAX_PLAN_NAME_LENGTH, MAX_PLAN_DESCRIPTION_LENGTH)

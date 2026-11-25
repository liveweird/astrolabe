package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/**
 * `GET /api/v1/views/plan` — the whole hierarchy in one document (the documented view-endpoint shape exception, `list-endpoints.md`;
 * bounded by the plan's scale: ~5 work streams, ~20 programs, ~100 projects). Each node carries the actions the CALLER may take
 * (`can`, [PlanPermissions]), so the page never re-derives rights. Work streams in the shared order (open ones first, closed ones last;
 * `plan-tree.md`), each stream's programs in its own order; projects by name.
 */
@Serializable
data class PlanView(
    /** The plan revision read FIRST, before the rows (`planning-model.md`). */
    val revision: Long,
    /** The work stream order's own revision (`PUT /work-stream-order`'s `expectedRevision`; 0 while never written). */
    val workStreamOrderRevision: Long,
    val can: PlanViewCan,
    val workStreams: List<PlanWorkStream>,
)

@Serializable
data class PlanViewCan(
    val createWorkStream: Boolean,
    /** `PUT /work-stream-order` (ADMIN, [PlanPermissions.canOrderWorkStreams]). */
    val orderWorkStreams: Boolean,
)

@Serializable
data class PlanWorkStream(
    val id: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val startDate: String,
    val endDate: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val can: PlanWorkStreamCan,
    /** This stream's program order revision (`PUT /work-streams/{id}/program-order`'s `expectedRevision`; 0 while never written). */
    val programOrderRevision: Long,
    val programs: List<PlanProgram>,
)

@Serializable
data class PlanWorkStreamCan(
    val edit: Boolean,
    val delete: Boolean,
    val createProgram: Boolean,
    /** `PUT /work-streams/{id}/program-order` (the stream's owner or ADMIN, [PlanPermissions.canOrderPrograms]). */
    val orderPrograms: Boolean,
)

@Serializable
data class PlanProgram(
    val id: UInt,
    val workStreamId: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val createdAt: Long,
    val updatedAt: Long,
    val can: PlanProgramCan,
    val projects: List<PlanProject>,
)

@Serializable
data class PlanProgramCan(val edit: Boolean, val delete: Boolean, val createProject: Boolean, val move: Boolean)

@Serializable
data class PlanProject(
    val id: UInt,
    val programId: UInt,
    val workStreamId: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val can: PlanProjectCan,
)

@Serializable
data class PlanProjectCan(
    val edit: Boolean,
    val delete: Boolean,
    val editTargetWindow: Boolean,
    val move: Boolean,
    /** 1.15: `POST /projects/{id}/milestones` (the project view's `can.createMilestone`, the same kernel function). */
    val createMilestone: Boolean,
    /** 1.27: `POST /projects/{id}/dependencies` (the project view's `can.createDependency`, the same kernel function). */
    val createDependency: Boolean,
)

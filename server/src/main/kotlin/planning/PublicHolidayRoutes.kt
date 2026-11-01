package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.requireAdmin
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/public-holidays")
class PublicHolidaysRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: PublicHolidaysRoute = PublicHolidaysRoute(), val id: UInt)

    @Serializable
    @Resource("apply-preset")
    class ApplyPreset(val parent: PublicHolidaysRoute = PublicHolidaysRoute())
}

/**
 * The public-holiday dictionary API (ported from Flow): GET is any authenticated caller (every timeline page and the schedule dialog read
 * the dates), POST / DELETE / apply-preset are ADMIN-only with the guard BEFORE the body decodes and before the id lookup — a non-admin
 * probe gets a uniform 403 whether or not the row exists (the registry shape of `teams/`, `authorization.md`; the dictionary is a
 * registry, so unlike the plan nodes it is guard-before-read). Every accepted write is a plan write that bumps the plan revision
 * ([PublicHolidayService]); a rejected one (400/404/409) emits no audit event.
 */
internal fun Route.publicHolidayRoutes(service: PublicHolidayService) {
    get<PublicHolidaysRoute> {
        call.caller()
        call.respond(HttpStatusCode.OK, PublicHolidayList(service.list()))
    }
    post<PublicHolidaysRoute> {
        val caller = call.caller()
        requireAdmin(caller)
        val request = sanitizedPublicHoliday(call.receive())
        validatePublicHoliday(request)
        // A duplicate date is the database's unique index -> 23505 -> the central 409 mapping (rolled back before any bump).
        val created = service.create(request)
        audit(
            "public_holiday.created",
            "byUserId" to caller.userId.toLong(),
            "holidayId" to created.value.id.toLong(),
            "date" to created.value.date,
            "name" to created.value.name,
            "revisionTo" to created.revision,
        )
        call.response.header(HttpHeaders.Location, call.application.href(PublicHolidaysRoute.Id(id = created.value.id)))
        call.respond(HttpStatusCode.Created, created.value)
    }
    post<PublicHolidaysRoute.ApplyPreset> {
        val caller = call.caller()
        requireAdmin(caller)
        val request = call.receive<HolidayPresetRequest>()
        validatePresetYear(request.year)
        val applied = service.applyPreset(request.preset, request.year)
        audit(
            "public_holiday.preset_applied",
            "byUserId" to caller.userId.toLong(),
            "preset" to request.preset.name,
            "year" to request.year,
            "addedCount" to applied.value.added.size,
            "addedDates" to applied.value.added.joinToString(",") { it.date },
            "revisionTo" to applied.revision,
        )
        call.respond(HttpStatusCode.OK, applied.value)
    }
    delete<PublicHolidaysRoute.Id> { route ->
        val caller = call.caller()
        requireAdmin(caller)
        val removed = service.delete(route.id)
        audit(
            "public_holiday.deleted",
            "byUserId" to caller.userId.toLong(),
            "holidayId" to removed.value.id.toLong(),
            "date" to removed.value.date,
            "name" to removed.value.name,
            "revisionTo" to removed.revision,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}

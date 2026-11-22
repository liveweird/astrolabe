package ch.nokillswit

import ch.nokillswit.planning.ProjectDetailsRequest
import ch.nokillswit.planning.ProjectResponse
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ProjectAtomicEditTest {
    @Test
    fun `the combined edit updates the project and window together and a later fields edit leaves the window alone`() = testApplication {
        usePostgresTestcontainer()
        val world = planWorld("project-edit")
        val path = "/api/v1/projects/${world.projectId}"
        val project = world.admin.client.get(path).body<ProjectResponse>()
        val response = world.programOwner.client.put("$path/details") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Revised project","ownerPersonId":${project.ownerPersonId},
                "targetStart":"2027-03-01","targetEnd":"2027-03-12"}""")
        }
        assertEquals(HttpStatusCode.NoContent, response.status)
        var saved = world.admin.client.get(path).body<ProjectResponse>()
        assertEquals("Revised project", saved.name)
        assertEquals("2027-03-01", saved.targetStart)
        assertEquals("2027-03-12", saved.targetEnd)

        val fields = """{"name":"New name","ownerPersonId":${project.ownerPersonId}}"""
        val fieldsOnly = world.admin.client.put(path) {
            contentType(ContentType.Application.Json)
            setBody(fields)
        }
        assertEquals(HttpStatusCode.NoContent, fieldsOnly.status)
        val omittedWindow = world.admin.client.put("$path/details") {
            contentType(ContentType.Application.Json)
            setBody(fields)
        }
        assertEquals(HttpStatusCode.BadRequest, omittedWindow.status)
        saved = world.admin.client.get(path).body<ProjectResponse>()
        assertEquals("New name", saved.name)
        assertEquals("2027-03-01", saved.targetStart)
        assertEquals("2027-03-12", saved.targetEnd)

        val cleared = world.admin.client.put("$path/details") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"New name","ownerPersonId":${project.ownerPersonId},"targetStart":null,"targetEnd":null}""")
        }
        assertEquals(HttpStatusCode.NoContent, cleared.status)
        saved = world.admin.client.get(path).body<ProjectResponse>()
        assertNull(saved.targetStart)
        assertNull(saved.targetEnd)
    }

    @Test
    fun `a combined edit with a forbidden or invalid window leaves the project fields untouched`() = testApplication {
        usePostgresTestcontainer()
        val world = planWorld("project-edit-refused")
        val path = "/api/v1/projects/${world.projectId}"
        val project = world.admin.client.get(path).body<ProjectResponse>()
        val payload = """{"name":"A name that must not be stored","ownerPersonId":${project.ownerPersonId},
            "targetStart":"2027-03-01","targetEnd":"invalid"}"""

        val refused = world.projectOwner.client.put("$path/details") {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        assertEquals(HttpStatusCode.Forbidden, refused.status)
        val invalid = world.programOwner.client.put("$path/details") {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        val saved = world.admin.client.get(path).body<ProjectResponse>()
        assertEquals(project.name, saved.name)
        assertNull(saved.targetStart)
        assertNull(saved.targetEnd)
    }

    @Test
    fun `the details update returns not found before decoding and rolls back a name conflict`() = testApplication {
        usePostgresTestcontainer()
        val world = planWorld("project-edit-conflict")
        val admin = world.admin.client
        val path = "/api/v1/projects/${world.projectId}"
        val project = admin.get(path).body<ProjectResponse>()
        val siblingName = planName("project-edit-sibling")
        TestPlan.project(world.programId, project.ownerPersonId, siblingName)

        val missing = admin.put("/api/v1/projects/99999999/details") {
            contentType(ContentType.Application.Json)
            setBody("{")
        }
        assertEquals(HttpStatusCode.NotFound, missing.status)
        val conflict = admin.putJson(
            "$path/details",
            ProjectDetailsRequest(
                name = siblingName, ownerPersonId = project.ownerPersonId, targetStart = "2027-03-01", targetEnd = "2027-03-12",
            ),
        )
        assertEquals(HttpStatusCode.Conflict, conflict.status)
        assertEquals(project, admin.get(path).body<ProjectResponse>())
    }
}

package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.plugins.respondProblem
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall

/**
 * `502` problem type: Jira did not answer a Peek, a bind or an import browse (the failure code rides in the detail; never a URL, a
 * body or a token).
 */
const val JIRA_UPSTREAM_PROBLEM = "urn:astrolabe:problem:jira-upstream"

/**
 * The `502` every route that calls Jira inline answers when the call fails: the code only - the exception's text names an endpoint, and
 * nothing of the upstream body or the credentials reaches a client.
 */
internal suspend fun ApplicationCall.respondJiraUpstream(failure: FetchException) {
    respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
}

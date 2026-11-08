package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.infra.outbound.JIRA_SITE_URL_PATTERN
import ch.nokillswit.infra.outbound.Origin
import io.ktor.util.AttributeKey

/** The tenant-label prefix that marks a site as served by the development Jira stub (`https://stub-sample.atlassian.net`). */
const val JIRA_STUB_SITE_LABEL_PREFIX = "stub-"

/** Published by `configureJira` so the connection routes can say, per response, whether a site is routed to the stub. */
val JiraStubRoutingKey = AttributeKey<JiraStubRouting>("JiraStubRouting")

/**
 * The ONE rule that tells a stub-served site from a genuine one: the tenant label (captured by [JIRA_SITE_URL_PATTERN]) starts with
 * [JIRA_STUB_SITE_LABEL_PREFIX]. Case matters (the pattern is lowercase-only), so `stubsample`, `sample` and `STUB-X` are genuine sites,
 * and a URL with a path or port is no site at all.
 */
fun isJiraStubSite(siteUrl: String): Boolean =
    JIRA_SITE_URL_PATTERN.matchEntire(siteUrl)?.groupValues?.get(1)?.startsWith(JIRA_STUB_SITE_LABEL_PREFIX) == true

/**
 * Whether a connection's calls go to the development stub: development mode AND the stub is configured AND the site is a `stub-` site.
 * (`configureJira` also refuses `jira.stubBaseUrl` in production at boot; [developmentMode] here is the second lock.) Every other site
 * reaches Atlassian even with a stub configured. The stub's URL is derived from its [Origin] here, so a factory never holds a routing
 * and a URL that could disagree.
 */
class JiraStubRouting(stub: Origin?, developmentMode: Boolean) {
    private val stubUrl: String? = stub?.takeIf { developmentMode }?.let { "${it.scheme}://${it.host}:${it.port}" }

    /** The stub's base URL when [siteUrl] is served by it, else null. */
    fun stubUrlFor(siteUrl: String): String? = stubUrl.takeIf { isJiraStubSite(siteUrl) }

    fun routes(siteUrl: String): Boolean = stubUrlFor(siteUrl) != null
}

/**
 * The per-connection client factory: a routed (`stub-`) site's tenant_info host AND gateway host are the stub; any other site keeps its
 * own tenant_info host and the `api.atlassian.com` gateway (`HttpJiraClient` with a null stub).
 */
fun jiraClientFactory(jiraHttp: SourceHttp, routing: JiraStubRouting): JiraClientFactory =
    { siteUrl, email, apiToken, authScheme ->
        val toStub = routing.stubUrlFor(siteUrl)
        HttpJiraClient(jiraHttp, toStub ?: siteUrl, toStub, email, apiToken, authScheme)
    }

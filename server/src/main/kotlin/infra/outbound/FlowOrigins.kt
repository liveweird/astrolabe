package ch.nokillswit.infra.outbound

import java.net.InetAddress
import java.net.URI
import java.net.URISyntaxException

private const val HTTP_PORT = 80
private const val HTTPS_PORT = 443
private const val HTTP_PREFIX = "http://"

/** Why a registry `baseUrl` was refused (or not): the ADMIN is told which, so "not listed" never reads as "this port is not allowed". */
enum class FlowBaseUrlVerdict { ALLOWED, NOT_CANONICAL, NOT_LISTED }

/**
 * Which Flow origins the server may call (`.claude/docs/security.md` "The Flow consumer"): ONE rule set for the guarded client's host,
 * address, scheme and per-request origin checks AND for the registry's `baseUrl` validation, so a connection can never name an origin
 * the transport would refuse and an admin can never widen the list. Both lists are OPERATOR configuration (`flow.*`), nothing a user or
 * an admin types.
 *
 *  - [hosts] (`FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS`): a TLS Flow on a listed `host[:port]`, `https` only, resolving to a public
 *    address or, for a listed host, to a private range inside a listed CIDR ([SelfManagedHosts]; loopback and link-local never).
 *  - [insecure] (`FLOW_INSECURE_ORIGINS`): exact `http://host[:port]` origins - the Flow stub and a plain-http Flow on OrbStack - honoured
 *    in [developmentMode] ONLY (`configureFlow` refuses a non-blank list at boot otherwise; this class ignores it as defence in depth).
 *    Such a host may resolve to a loopback, private or docker-network address ("a local fixture by construction"), but never to a
 *    link-local (the cloud metadata address), any-local, multicast, `0.0.0.0/8`, `::/96`, NAT64, 6to4 or Teredo one
 *    ([insecureAddressAllowed]);
 *    the host check still applies unconditionally, so this never widens WHICH hosts are reachable. A host that is ALSO a listed TLS host
 *    follows the listed-host rule only.
 *
 * Every refusal the guard makes is the existing `outbound.blocked` audit (scheme + host).
 */
class FlowOrigins(
    private val hosts: SelfManagedHosts,
    private val insecure: Set<Origin>,
    private val developmentMode: Boolean,
) {
    private val insecureHosts: Set<String> = insecure.mapTo(HashSet()) { it.host }

    private fun insecureHost(host: String): Boolean = developmentMode && host.lowercase() in insecureHosts

    /** DNS-level check ([GuardedDns]): `Dns.lookup` sees a hostname and never a port. */
    fun hostAllowed(host: String): Boolean = hosts.hostListed(host) || insecureHost(host)

    /** The address rule, asked of EVERY address a lookup resolved to. */
    fun addressAllowed(host: String, address: InetAddress): Boolean =
        hosts.addressAllowed(host, address) || (insecureHost(host) && !hosts.hostListed(host) && address.isDevelopmentFixtureAddress())

    /** The scheme actually used to reach [host], for the `outbound.blocked` audit: a listed TLS host wins over an insecure alias. */
    fun schemeFor(host: String): String = if (insecureHost(host) && !hosts.hostListed(host)) "http" else "https"

    /** The transport-level rule, checked on every request: it also judges an IP-literal URL, which OkHttp never hands to DNS. */
    fun originAllowed(scheme: String, host: String, port: Int): Boolean =
        hosts.originListed(scheme, host, port) || (developmentMode && Origin(scheme.lowercase(), host.lowercase(), port) in insecure)

    /**
     * The origins an ADMIN may name, as the editor's hint shows them: the listed TLS hosts as `https://host[:port]` (443 omitted) and, in
     * [developmentMode] only, the insecure ones as `http://host[:port]` (80 omitted), distinct and sorted. OPERATOR configuration already
     * validated host-shaped at boot, so it carries no credential; this widens nothing (the guard still judges every call).
     */
    fun allowedOrigins(): List<String> {
        val plain = if (developmentMode) insecure.map { it.httpSpelling() } else emptyList()
        return (hosts.origins() + plain).distinct().sorted()
    }

    /** [baseUrlVerdict] reduced to a yes/no. */
    fun baseUrlAllowed(url: String): Boolean = baseUrlVerdict(url) == FlowBaseUrlVerdict.ALLOWED

    /**
     * The connection validation: [url] is EXACTLY a listed origin in its CANONICAL form - lowercase scheme and host, the scheme's default
     * port omitted - `scheme://host[:port]`, no path (a trailing slash included), query, fragment or credentials. The stored value is what
     * the client later appends the API paths to, and the identity of the connection, so there is one spelling of each origin. The verdict
     * says WHICH rule refused it: a spelling problem ([FlowBaseUrlVerdict.NOT_CANONICAL]) or a well-formed origin nobody listed
     * ([FlowBaseUrlVerdict.NOT_LISTED]) - a port is never the reason.
     */
    fun baseUrlVerdict(url: String): FlowBaseUrlVerdict {
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            return FlowBaseUrlVerdict.NOT_CANONICAL
        }
        val scheme = uri.scheme
        val host = uri.host?.takeIf { it.isNotBlank() && it == it.lowercase() }
        if (host == null || !uri.isBareAuthority() || (scheme != "http" && scheme != "https")) return FlowBaseUrlVerdict.NOT_CANONICAL
        val defaultPort = if (scheme == "https") HTTPS_PORT else HTTP_PORT
        if (uri.port == defaultPort) return FlowBaseUrlVerdict.NOT_CANONICAL
        // One spelling of the port too: the authority is the host alone or `host:port` with the port's canonical digits (no leading
        // zeros, no sign), so `:08443` and `:0443` are refused although `URI` parses them as 8443 and 443.
        val authority = uri.rawAuthority
        if (authority != host && authority != "$host:${uri.port}") return FlowBaseUrlVerdict.NOT_CANONICAL
        return if (originAllowed(scheme, host, if (uri.port != -1) uri.port else defaultPort)) {
            FlowBaseUrlVerdict.ALLOWED
        } else {
            FlowBaseUrlVerdict.NOT_LISTED
        }
    }

    private fun Origin.httpSpelling(): String = if (port == HTTP_PORT) "http://$host" else "http://$host:$port"

    /** Only an authority: no credentials, path, query or fragment, and no empty port (`host:`). */
    private fun URI.isBareAuthority(): Boolean =
        rawUserInfo == null && rawQuery == null && rawFragment == null && rawPath.isNullOrEmpty() && rawAuthority?.endsWith(':') == false

    companion object {
        /** Nothing listed: every Flow call is refused. */
        val NONE = FlowOrigins(SelfManagedHosts.NONE, emptySet(), developmentMode = false)
    }
}

/**
 * `flow.insecureOrigins` (comma-separated `http://host[:port]`, blank = none) as [Origin]s. Each entry is a DNS host name (no IP literal,
 * no wildcard, no credentials, no path, query or fragment; port 1..65535, default 80) or the boot is refused naming the key and the
 * entry's position - an entry that is not plainly host-shaped is never echoed, so a credential in it cannot reach a log. TLS hosts do not
 * belong here: they are `flow.allowedHosts`.
 */
fun parseFlowInsecureOrigins(raw: String, key: String): Set<Origin> {
    if (raw.isBlank()) return emptySet()
    return raw.split(',').mapIndexedTo(LinkedHashSet()) { index, part ->
        val entry = part.trim()
        if (!entry.startsWith(HTTP_PREFIX, ignoreCase = true)) {
            error("Config \"$key\": entry ${index + 1} must be an http://host[:port] origin (a TLS Flow is listed in the allowed hosts)")
        }
        val authority = entry.substring(HTTP_PREFIX.length)
        val parsed = parseHostEntry(authority, index, key)
        Origin("http", parsed.host, if (':' in authority) parsed.port else HTTP_PORT)
    }
}

package ch.nokillswit.sync

/**
 * `409` problem type of a bind that finds its target taken, for both connectors (Jira: the node already carries a binding, or the issue
 * is already bound to another node or through another connection of the site; Flow: the Astrolabe team already has a Flow team, or the
 * Flow team is already linked to a live team). ONE value, so the web has one slug and `sync/` still names no connector.
 */
const val ALREADY_BOUND_PROBLEM = "urn:astrolabe:problem:already-bound"

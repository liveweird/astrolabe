package ch.nokillswit

/**
 * The shared in-JVM WireMock over `sample-data/jira-stub` (the [StubServer] shape): the SAME mappings and `__files` the compose and
 * Kubernetes `jira-stub` image serves (`sample-data/jira/README.md`). Lazily started once per JVM and SHARED across the whole suite,
 * like [PostgresTestSupport]. A test class that reads it warms it first (`JiraStubFixture.warm()`, `StubWarmupGuardTest`).
 */
object JiraStubServer : StubServer("sample-data/jira-stub") {
    /** The generator's fixed `cloudId` (`sample-data/jira/catalog.mjs`, `expected.json`). */
    const val CLOUD_ID = "b3f1a2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c"
}

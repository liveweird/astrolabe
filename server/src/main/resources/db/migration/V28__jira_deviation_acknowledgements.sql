-- 1.12: "known, leave it" for ONE deviation of a Jira binding (jira-sync.md "Acknowledge"): keyed by the binding and the deviation's
-- KIND (the kernel raises a kind at most once per binding). It replaces V22's whole-list acknowledgement, whose three
-- jira_bindings.ack_* columns stay in place, unread and unwritten since 1.12 (a later migration drops them). Not plan state. Hard rows:
-- a withdrawal deletes, a re-acknowledge rewrites; the stored fingerprint is compared with the deviation's on every read. kind holds a
-- DeviationKind name: the CHECK pins its SHAPE only, so a kind added later needs no migration.
CREATE TABLE jira_deviation_acknowledgements (
    id SERIAL PRIMARY KEY,
    binding_id INTEGER NOT NULL REFERENCES jira_bindings(id),
    kind VARCHAR(32) NOT NULL CONSTRAINT ck_jira_deviation_acks_kind CHECK (kind ~ '^[A-Z][A-Z_]{0,31}$'),
    fingerprint VARCHAR(64) NOT NULL CONSTRAINT ck_jira_deviation_acks_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    ack_at BIGINT NOT NULL,
    ack_by_user_id BIGINT NOT NULL REFERENCES users(id)
);
-- One acknowledgement per (binding, kind); both NOT NULL, so no NULLS NOT DISTINCT (V26 needed it for its NULL sprint).
CREATE UNIQUE INDEX uq_jira_deviation_acks_key ON jira_deviation_acknowledgements (binding_id, kind);

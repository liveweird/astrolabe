-- 1.9: "known, leave it" for ONE sprint's capacity deviation (flow-sync.md "Acknowledge (1.9)"): keyed by the team binding and Flow's
-- sprint id; sprint_id NULL is the binding's TEAM_GONE row (the one deviation a gone team has). Not plan state (no plan lock, no
-- revision). Hard rows: an un-acknowledge deletes the row, a re-acknowledge rewrites the stamp; the stored fingerprint is compared on
-- every read (`current`), so a stale row is simply open again. ack_by_user_id is a plain id: flow/ names no users type.
CREATE TABLE flow_capacity_acknowledgements (
    id SERIAL PRIMARY KEY,
    binding_id INTEGER NOT NULL REFERENCES flow_team_bindings(id),
    sprint_id BIGINT NULL CONSTRAINT ck_flow_capacity_acks_sprint CHECK (sprint_id IS NULL OR sprint_id >= 1),
    fingerprint VARCHAR(64) NOT NULL CONSTRAINT ck_flow_capacity_acks_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    ack_at BIGINT NOT NULL,
    ack_by_user_id BIGINT NOT NULL REFERENCES users(id)
);
-- One acknowledgement per (binding, sprint); NULLS NOT DISTINCT so the TEAM_GONE rows collide too (the V15/V21 idiom; Postgres 18).
CREATE UNIQUE INDEX uq_flow_capacity_acks_key ON flow_capacity_acknowledgements (binding_id, sprint_id) NULLS NOT DISTINCT;

ALTER TABLE jira_connections
  ADD COLUMN poll_interval_minutes INTEGER DEFAULT 15
    CONSTRAINT ck_jira_connections_poll_interval CHECK (poll_interval_minutes IS NULL OR poll_interval_minutes BETWEEN 5 AND 1440);
ALTER TABLE jira_bindings
  ADD COLUMN ack_fingerprint VARCHAR(64) NULL CONSTRAINT ck_jira_bindings_ack_fingerprint CHECK (ack_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN ack_at BIGINT NULL,
  ADD COLUMN ack_by_user_id BIGINT NULL REFERENCES users(id),
  ADD CONSTRAINT ck_jira_bindings_ack CHECK ((ack_fingerprint IS NULL) = (ack_at IS NULL)),
  ADD CONSTRAINT ck_jira_bindings_ack_by CHECK (ack_by_user_id IS NULL OR ack_at IS NOT NULL);

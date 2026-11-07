-- 1.4.0 coverage and roll-ups: the mirror of a connection's in-scope Jira census (the mapped levels plus the child level the roll-ups
-- read), one row per issue, overwritten by every run and pruned by its sweeps. Written ONLY by jira/JiraIssueStore.kt in run-sized
-- chunks; hard-deleted with its connection (like sync_runs) - a documented hard-delete exception beside jira_observations.
-- No soft delete, no revision, no plan lock: a census row is observed state, not plan state.
CREATE TABLE jira_issues (
  connection_id   INTEGER       NOT NULL REFERENCES jira_connections(id),
  issue_id        VARCHAR(20)   NOT NULL CONSTRAINT ck_jira_issues_id CHECK (issue_id ~ '^[0-9]{1,20}$'),
  issue_key       VARCHAR(50)   NOT NULL,
  type_id         VARCHAR(20)   NULL,
  hierarchy_level INTEGER       NOT NULL,
  parent_issue_id VARCHAR(20)   NULL,
  summary         VARCHAR(255)  NULL,
  status_category VARCHAR(16)   NOT NULL CONSTRAINT ck_jira_issues_status CHECK (status_category IN ('TODO','IN_PROGRESS','DONE','UNKNOWN')),
  points          NUMERIC(12,2) NULL,
  jira_updated_at BIGINT        NULL,
  observed_at     BIGINT        NOT NULL,
  PRIMARY KEY (connection_id, issue_id)
);
CREATE INDEX ix_jira_issues_parent ON jira_issues (connection_id, parent_issue_id);
-- When the child level was last fully censused (NULL = never: the next run reads in full and seeds the mirror).
ALTER TABLE jira_connections ADD COLUMN census_at BIGINT NULL;

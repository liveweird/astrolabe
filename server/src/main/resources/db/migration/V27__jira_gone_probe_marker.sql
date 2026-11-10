-- 1.10: when the run's by-id probe last got an ANSWER (200, 404 or 403) about a gone binding's issue (jira-sync.md step 4b). NULL = no
-- answer yet for this vanish: never tried (flagged before 1.10, or beyond the per-run cap), failed, or cut by a stop or the breaker; a
-- later run probes it again. Cleared together with the gone flag. No backfill: an existing gone row is simply probed by the next run.
ALTER TABLE jira_observations
    ADD COLUMN gone_probed_at BIGINT NULL,
    ADD CONSTRAINT ck_jira_observations_gone_probed CHECK (gone_probed_at IS NULL OR gone);

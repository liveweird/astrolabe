-- 1.13: the issue KEY the run's by-id probe last got with a 200 for a gone binding (jira-sync.md step 4b): where Jira has the issue now.
-- NULL = no such answer: not gone, not yet answered, answered 404 or 403, a 200 without a usable key, or a 200 before 1.13 (a re-ask fills it).
-- The API derives the gone reason from it: a key outside the connection's project keys reads moved out, one inside reads not listed.
-- Deliberately no CHECK tying it to gone or gone_probed_at (unlike V27's): a 1.12 build still runs on this schema and clears those two
-- without knowing this column, so such a constraint would fail its writes. Readers take the key only from a gone, probed row, and every
-- 1.13 writer that sets or clears gone resets it. The value is validated in code (the issue-key pattern) before it is stored.
-- No backfill: a row answered 200 before 1.13 keeps no key and reads as it did in 1.12.
ALTER TABLE jira_observations ADD COLUMN gone_probed_key VARCHAR(50) NULL;

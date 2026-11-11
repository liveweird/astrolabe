-- 1.13: drops V22's whole-binding acknowledgement of a Jira binding, replaced in 1.12 by one row per (binding, kind) in
-- jira_deviation_acknowledgements (V28) and unread, unwritten since. Dropping the columns takes their constraints with them
-- (ck_jira_bindings_ack_fingerprint, ck_jira_bindings_ack, ck_jira_bindings_ack_by and the foreign key to users,
-- jira_bindings_ack_by_user_id_fkey). Their contents - who acknowledged which whole list before 1.12 - are gone for good (recoverable
-- only from a pre-upgrade dump), and a build older than 1.12 can no longer run on this schema.
ALTER TABLE jira_bindings
    DROP COLUMN ack_fingerprint,
    DROP COLUMN ack_at,
    DROP COLUMN ack_by_user_id;

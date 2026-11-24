-- 1.26: a saved cross-team schedule proposal (saved-schedule-proposals): the SERVER's own re-computation of a run, stored so a second
-- manager can open it. NOT plan state: no plan lock, no revision bump, nothing references it and it moves no milestone (the accept is
-- unchanged and recomputes everything under the plan lock). Immutable once written, so no updated_at and no soft-delete flag: a delete
-- removes the row, and the newest 20 are kept (the save prunes the older ones in its own transaction).
-- `document` is CrossTeamProposal and `check_document` the ScheduleCheckResponse of a PARTIAL selection (NULL = every move was
-- selected, the proposal's own post-check applies), each as the application serialised it; `format` names that shape (the application's
-- STORED_PROPOSAL_FORMAT): a row of another format reads as UNREADABLE instead of failing to decode. `teams` is [{id,name}] as of the save,
-- `selected` the ticked milestone ids. The row holds no foreign key to a live plan row; only the saving login is referenced.
CREATE TABLE saved_schedule_proposals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL CONSTRAINT ck_saved_schedule_proposals_name CHECK (char_length(btrim(name)) >= 1),
    as_of DATE NOT NULL,
    plan_revision BIGINT NOT NULL CONSTRAINT ck_saved_schedule_proposals_revision CHECK (plan_revision >= 0),
    scope_hash CHAR(64) NOT NULL CONSTRAINT ck_saved_schedule_proposals_hash CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    teams JSONB NOT NULL CONSTRAINT ck_saved_schedule_proposals_teams CHECK (jsonb_typeof(teams) = 'array' AND jsonb_array_length(teams) BETWEEN 1 AND 50),
    selected JSONB NOT NULL CONSTRAINT ck_saved_schedule_proposals_selected CHECK (jsonb_typeof(selected) = 'array'),
    move_count INTEGER NOT NULL CONSTRAINT ck_saved_schedule_proposals_moves CHECK (move_count >= 0),
    selected_count INTEGER NOT NULL CONSTRAINT ck_saved_schedule_proposals_selected_count CHECK (selected_count BETWEEN 1 AND move_count),
    passes INTEGER NOT NULL CONSTRAINT ck_saved_schedule_proposals_passes CHECK (passes >= 1),
    settled BOOLEAN NOT NULL,
    format SMALLINT NOT NULL CONSTRAINT ck_saved_schedule_proposals_format CHECK (format >= 1),
    document JSONB NOT NULL,
    check_document JSONB NULL,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL
);

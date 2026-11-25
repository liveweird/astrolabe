-- 1.28: the shared order of work streams and of a work stream's programs (the Plan tree and the Programs page). Two hard-delete position
-- joins in the V13/V17 shape (persistence.md "Soft delete"), NOT a position column on the soft-deleted node tables: a partial unique index over
-- active rows cannot be DEFERRABLE, and the wholesale rewrite needs deferral. NO DATA ROWS: no row means "by name", exactly the order before
-- this migration, so a list nobody has re-arranged keeps sorting by name and its newcomers (create, import, a move in) are unlisted until
-- someone lists them. How the rows are written and read: .claude/docs/plan-tree.md.
CREATE TABLE work_stream_orders (
    -- No ON DELETE rules: work streams and programs are soft-deleted only; the delete hooks remove the rows in the same transaction.
    work_stream_id INTEGER PRIMARY KEY REFERENCES work_streams(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    -- DEFERRABLE INITIALLY DEFERRED: a renumbering is one UPDATE, which an immediate unique check can reject mid-statement, depending on
    -- the physical row order (the V13 reasoning).
    CONSTRAINT uq_work_stream_orders_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE program_orders (
    program_id INTEGER PRIMARY KEY REFERENCES programs(id),
    -- The stream the position belongs to: a row only counts while the program is still under it (a program moved away is unlisted).
    work_stream_id INTEGER NOT NULL REFERENCES work_streams(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    -- Its index also serves every per-stream read, so there is no separate work_stream_id index.
    CONSTRAINT uq_program_orders_position UNIQUE (work_stream_id, position) DEFERRABLE INITIALLY DEFERRED
);
-- Per work stream, the plan revision at which its program order was last written (the V17 team_order_state shape).
CREATE TABLE program_order_state (
    work_stream_id INTEGER PRIMARY KEY REFERENCES work_streams(id),
    revision BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
-- The plan revision at which work_stream_orders was last written (the V18 ranking_revision shape); never above plan_state.revision.
ALTER TABLE plan_state ADD COLUMN work_stream_order_revision BIGINT NOT NULL DEFAULT 0;

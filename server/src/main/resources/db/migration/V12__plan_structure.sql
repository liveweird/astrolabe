-- The plan structure (v0.2.0): work streams -> programs -> projects, each with an OWNER (a person of the people directory,
-- required on every node), plus the one-row `plan_state` that carries the plan's revision and serialises every plan write.
-- Day-precision dates are Postgres DATE (infra/db/LocalDateColumn.kt). Soft-deleted like every business entity; names are
-- unique among ACTIVE rows only, case-insensitively (the V6 partial-index shape): work stream and program names globally,
-- a project name within its program. Parents are immutable (no reparent in v0.2).

-- The live plan's revision lock. `revision` is monotonic and bumped by EVERY plan mutation (work streams, programs, projects
-- and, from V13, the roadmap ranking); every plan write first takes this row FOR UPDATE, so "count the children, then delete"
-- and "compare the expected revision, then replace the ranking" are race-free. Plain FOR UPDATE is safe here: nothing
-- references plan_state by a foreign key, so no FK check can queue behind the lock.
CREATE TABLE plan_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
);
INSERT INTO plan_state (id, revision, updated_at)
VALUES (1, 0, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);

CREATE TABLE work_streams (
    id SERIAL PRIMARY KEY,
    "name" VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    owner_person_id INTEGER NOT NULL REFERENCES people(id),
    start_date DATE NOT NULL,
    -- Set only when the stream is closed; an end equal to the start is a one-day span.
    end_date DATE NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_work_streams_end_after_start CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX uq_work_streams_name_active ON work_streams (LOWER("name")) WHERE NOT marked_as_deleted;
CREATE INDEX idx_work_streams_owner ON work_streams(owner_person_id);

CREATE TABLE programs (
    id SERIAL PRIMARY KEY,
    work_stream_id INTEGER NOT NULL REFERENCES work_streams(id),
    "name" VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    owner_person_id INTEGER NOT NULL REFERENCES people(id),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_programs_name_active ON programs (LOWER("name")) WHERE NOT marked_as_deleted;
CREATE INDEX idx_programs_work_stream ON programs(work_stream_id);
CREATE INDEX idx_programs_owner ON programs(owner_person_id);

CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    program_id INTEGER NOT NULL REFERENCES programs(id),
    "name" VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    owner_person_id INTEGER NOT NULL REFERENCES people(id),
    -- The optional target window: both dates or neither, end not before start.
    target_start DATE NULL,
    target_end DATE NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_projects_target_window CHECK ((target_start IS NULL) = (target_end IS NULL)),
    CONSTRAINT ck_projects_target_order CHECK (target_start IS NULL OR target_end >= target_start)
);
CREATE UNIQUE INDEX uq_projects_program_name_active ON projects (program_id, LOWER("name")) WHERE NOT marked_as_deleted;
CREATE INDEX idx_projects_program ON projects(program_id);
CREATE INDEX idx_projects_owner ON projects(owner_person_id);

-- Make `platform` optional on appointments.
--
-- The admin "Create Event" dialog is not always booking a video call — it is
-- often just putting something on the calendar. Until now it could not say so:
-- `platform` was NOT NULL with a CHECK, so the dialog had to name one, and every
-- such event then displayed a meeting platform it does not have. NULL now means
-- "no meeting platform", which is distinct from every real platform rather than
-- being spelled as one of them. The public booking flow is unchanged — a
-- stranger booking time still has to choose.
--
-- SQLite cannot alter a CHECK constraint in place, so this is the standard
-- 12-step table rebuild. The column list is copied verbatim from
-- 0004_create_appointments_tables.sql; only the `platform` line changes, from
--   platform TEXT NOT NULL CHECK(platform IN (...))
-- to
--   platform TEXT          CHECK(platform IS NULL OR platform IN (...))
-- so every existing row carries across untouched and still satisfies it.
--
-- 'teams' stays in the allowed set: it is not bookable any more (it is absent
-- from VALID_PLATFORMS) but historical rows may hold it, and a rebuild that
-- dropped it would refuse to copy those rows.
--
-- No `PRAGMA foreign_keys = OFF` around the swap, deliberately. The usual reason
-- to need it is a foreign key pointing AT the table being dropped, and nothing
-- references `appointments` — the only FK here points the other way, out to
-- contact_submissions, and is recreated with the new table. D1 also runs a
-- migration inside a transaction, where that PRAGMA is a silent no-op, so
-- including it would have read as protection that was not there.

CREATE TABLE appointments_new (
    id TEXT PRIMARY KEY,
    submission_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT,

    slot_id TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration INTEGER NOT NULL,
    timezone TEXT NOT NULL,

    -- The one changed line: nullable, and the CHECK admits NULL explicitly.
    -- A bare `CHECK(platform IN (...))` would already pass on NULL (SQL
    -- three-valued logic: NULL IN (...) is NULL, and a CHECK only fails on
    -- FALSE), but writing it out is the difference between "we allow this" and
    -- "this slipped through" for whoever reads the schema next.
    platform TEXT CHECK(platform IS NULL OR platform IN ('discord', 'google', 'teams', 'jitsi')),
    meeting_link TEXT,
    meeting_id TEXT,

    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cancelled_at INTEGER,

    ip_address TEXT,
    user_agent TEXT,
    confirmation_sent BOOLEAN DEFAULT 0,
    reminder_sent BOOLEAN DEFAULT 0,

    FOREIGN KEY (submission_id) REFERENCES contact_submissions(id)
);

INSERT INTO appointments_new (
    id, submission_id, name, email, message,
    slot_id, date, start_time, end_time, duration, timezone,
    platform, meeting_link, meeting_id,
    status, created_at, updated_at, cancelled_at,
    ip_address, user_agent, confirmation_sent, reminder_sent
)
SELECT
    id, submission_id, name, email, message,
    slot_id, date, start_time, end_time, duration, timezone,
    platform, meeting_link, meeting_id,
    status, created_at, updated_at, cancelled_at,
    ip_address, user_agent, confirmation_sent, reminder_sent
FROM appointments;

DROP TABLE appointments;

ALTER TABLE appointments_new RENAME TO appointments;

-- Indexes do not survive the rename, so they are recreated verbatim from 0004.
CREATE INDEX idx_appointments_date ON appointments(date);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_email ON appointments(email);
CREATE INDEX idx_appointments_created_at ON appointments(created_at);
CREATE INDEX idx_appointments_slot_id ON appointments(slot_id);
CREATE INDEX idx_appointments_start_time ON appointments(start_time);
CREATE INDEX idx_appointments_active_slots ON appointments(date, slot_id, status)
    WHERE status = 'confirmed';

-- Migration: reconcilable inbound email
-- Created: 2026-08-07
--
-- Two problems this fixes:
--
-- 1. The webhook was the ONLY path that wrote inbound mail into
--    contact_submissions, and it dropped mail on four paths (non-whitelisted
--    sender, recipient forwarder, Resend fetch-back failure, any exception) —
--    every one of them returning 200 with no record kept. Anything dropped was
--    invisible forever, so the command station could never show what Resend
--    held. `filtered_reason` turns those drops into quarantined rows instead.
--
-- 2. There was no idempotency key, so nothing could safely re-read Resend and
--    backfill. `resend_email_id` is that key.
--
-- Deliberately additive: `status` keeps its four-value CHECK constraint. Adding
-- a fifth status would mean rebuilding the table (D1 cannot ALTER a CHECK — see
-- 0002), and quarantine is orthogonal to read/unread anyway: a filtered mail is
-- still unread mail, it just lives in a different folder.

ALTER TABLE contact_submissions ADD COLUMN resend_email_id TEXT;
ALTER TABLE contact_submissions ADD COLUMN filtered_reason TEXT;

-- SQLite treats NULLs as distinct in a UNIQUE index, so outbound sends and
-- web-form submissions (which have no Resend id) are unaffected while inbound
-- mail can never be double-inserted.
CREATE UNIQUE INDEX idx_contact_resend_email_id ON contact_submissions(resend_email_id);
CREATE INDEX idx_contact_filtered_reason ON contact_submissions(filtered_reason);

-- The ledger is the sync's memory, and it must OUTLIVE the submissions it
-- describes. archiveOldSubmissions() moves rows older than ARCHIVE_AFTER_DAYS
-- out of contact_submissions into contact_submissions_archive (which has no
-- resend_email_id column). Deduping the sync against contact_submissions alone
-- would therefore resurrect every archived email on the next poll, forever.
-- One row per Resend id we have ever made a decision about — never purged.
CREATE TABLE inbound_email_ledger (
    resend_email_id TEXT PRIMARY KEY,
    submission_id TEXT,
    ingested_at INTEGER NOT NULL,
    -- Which path saw it first. 'webhook' = live push, 'sync' = reconciliation
    -- poll, 'adopt' = the poll matched it to a row the webhook had already
    -- stored before this migration existed (so no duplicate is created).
    source TEXT NOT NULL CHECK(source IN ('webhook', 'sync', 'adopt')),
    -- What we did:
    --   stored          accepted into the inbox
    --   filtered        quarantined (see contact_submissions.filtered_reason)
    --   forwarded       handed to a recipient forwarder, not stored
    --   forward_skipped a forwarder recipient the SYNC found. Deliberately not
    --                   replayed — firing a "new open spot" trigger hours late
    --                   is an outward-facing side effect, so reconciliation
    --                   records it and moves on.
    outcome TEXT NOT NULL
        CHECK(outcome IN ('stored', 'filtered', 'forwarded', 'forward_skipped', 'error'))
);

CREATE INDEX idx_inbound_ledger_ingested_at ON inbound_email_ledger(ingested_at);

-- Migration: sender blocklist + the spam retention clock
-- Created: 2026-08-14
--
-- The whitelist (0003) answers "is this sender vouched for?" and its failure
-- mode is soft: unvouched mail is quarantined as `not_whitelisted` and still
-- shows up in the Filtered folder for review. That is deliberately permissive,
-- and it is the right default for a contact form on a public site.
--
-- It is the wrong answer for a sender you have actively judged. Marketing blasts
-- keep arriving, keep landing in Filtered, and keep having to be re-read to be
-- re-ignored. This table is the explicit, operator-driven half of the pair: a
-- sender on it is not merely unvouched, it is unwanted, and its mail goes
-- straight to Spam and is destroyed on a clock.
--
-- Two `kind`s because spam senders rotate the local part far more often than the
-- domain — `info@`, `hello@`, `news@` off one host is the common shape, so
-- blocking the address alone loses that race. Domain blocking is the answer to
-- it, but it is NOT the default: a domain block on a large provider silently
-- eats mail from every human behind it, and that failure is invisible by
-- construction. The caller states which it means.
CREATE TABLE email_blocklist (
    -- Lowercased. For kind='address' the full address (`info@cerebras.net`);
    -- for kind='domain' the bare host with no `@` (`cerebras.net`).
    pattern TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('address', 'domain')),
    blocked_at INTEGER NOT NULL,
    blocked_by TEXT NOT NULL, -- admin key or identifier that blocked it
    contact_id TEXT, -- the submission the Block button was pressed on, if any
    notes TEXT
);

CREATE INDEX idx_blocklist_blocked_at ON email_blocklist(blocked_at);
CREATE INDEX idx_blocklist_kind ON email_blocklist(kind);

-- `filtered_reason` gains a second value, 'blocked'. No table rebuild is needed
-- and none may be attempted: 0007 added the column as plain TEXT with NO CHECK
-- constraint, precisely so the vocabulary could grow without the copy-drop-rename
-- dance that `status` requires (see the header of 0002). Adding a value here is
-- a code change, not a schema change.
--
-- Spam therefore needs its own clock, and cannot reuse an existing column:
--
--   * `created_at` is when the mail ARRIVED. Blocking a sender you have tolerated
--     for months would retro-date the whole backlog past a 90-day horizon and
--     hard-delete it on the very next nightly sweep — the mail would be gone
--     before it was ever visible in the Spam folder. Retention must start when
--     the judgement was made, not when the mail landed.
--   * `deleted_at` belongs to the 7-day Trash clock and means "the operator
--     pressed Delete". Overloading it would make Spam inherit Trash's retention
--     and make Trash's purge eat spam a fortnight early.
--
-- NULL for every row that is not in the Spam folder.
ALTER TABLE contact_submissions ADD COLUMN spammed_at INTEGER;

-- The nightly purge scans on this alone, and it is also what exempts spam from
-- the 30-day archive sweep (`spammed_at IS NULL` in archiveOldSubmissions).
-- That exemption is load-bearing, not an optimisation: contact_submissions_archive
-- has no `filtered_reason` column at all, so a spam row that reached the archive
-- would come out the far side indistinguishable from ordinary old mail, invisible
-- to the UI, and immortal — the 90-day promise would silently never be kept.
CREATE INDEX idx_contact_spammed_at ON contact_submissions(spammed_at);

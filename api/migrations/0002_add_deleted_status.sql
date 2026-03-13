-- Migration: Add 'deleted' status for soft delete
-- Created: 2025-01-19

-- D1 doesn't support ALTER TABLE to modify CHECK constraints
-- We need to:
-- 1. Create new table with updated constraint
-- 2. Copy data
-- 3. Drop old table
-- 4. Rename new table

-- Create new table with 'deleted' status
CREATE TABLE contact_submissions_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'archived', 'deleted')),
    created_at INTEGER NOT NULL,
    deleted_at INTEGER, -- Track when item was deleted
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    recipient TEXT -- Track which email address received this
);

-- Copy existing data
INSERT INTO contact_submissions_new
    (id, name, email, message, status, created_at, deleted_at, ip_address, user_agent, referrer, recipient)
SELECT
    id, name, email, message, status, created_at, NULL, ip_address, user_agent, referrer, NULL
FROM contact_submissions;

-- Drop old table
DROP TABLE contact_submissions;

-- Rename new table
ALTER TABLE contact_submissions_new RENAME TO contact_submissions;

-- Recreate indexes
CREATE INDEX idx_contact_created_at ON contact_submissions(created_at);
CREATE INDEX idx_contact_status ON contact_submissions(status);
CREATE INDEX idx_contact_email ON contact_submissions(email);
CREATE INDEX idx_contact_deleted_at ON contact_submissions(deleted_at);
CREATE INDEX idx_contact_recipient ON contact_submissions(recipient);

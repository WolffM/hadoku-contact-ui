-- Migration: Add direction column to track inbound vs outbound emails
-- Created: 2025-03-13

-- Add direction column (inbound = contact form submissions, outbound = admin-sent emails)
ALTER TABLE contact_submissions ADD COLUMN direction TEXT DEFAULT 'inbound';

-- Index for filtering by direction (Sent folder)
CREATE INDEX idx_contact_direction ON contact_submissions(direction);

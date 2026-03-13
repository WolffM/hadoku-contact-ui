-- Migration: Create email whitelist table
-- Created: 2025-01-20
-- Purpose: Track emails that are whitelisted to bypass referrer restrictions
--          after admin has replied to their initial contact form submission

-- Email whitelist table
CREATE TABLE email_whitelist (
    email TEXT PRIMARY KEY,
    whitelisted_at INTEGER NOT NULL,
    whitelisted_by TEXT NOT NULL, -- Admin key or identifier who whitelisted this email
    contact_id TEXT, -- Original contact submission ID that led to whitelisting
    notes TEXT -- Optional notes about why this email was whitelisted
);

-- Index for efficient lookups
CREATE INDEX idx_whitelist_created_at ON email_whitelist(whitelisted_at);
CREATE INDEX idx_whitelist_by ON email_whitelist(whitelisted_by);

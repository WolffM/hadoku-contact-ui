-- Migration: Create contact submissions tables
-- Created: 2025-01-19

-- Active contact submissions
CREATE TABLE contact_submissions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'archived')),
    created_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT
);

-- Indexes for efficient queries
CREATE INDEX idx_contact_created_at ON contact_submissions(created_at);
CREATE INDEX idx_contact_status ON contact_submissions(status);
CREATE INDEX idx_contact_email ON contact_submissions(email);

-- Archive table for old submissions (30+ days)
CREATE TABLE contact_submissions_archive (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT
);

-- Indexes for archive table
CREATE INDEX idx_archive_created_at ON contact_submissions_archive(created_at);
CREATE INDEX idx_archive_archived_at ON contact_submissions_archive(archived_at);

-- Migration: Create appointments and configuration tables
-- Created: 2025-01-20

-- Appointment configuration table
CREATE TABLE appointment_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    business_hours_start TEXT NOT NULL DEFAULT '09:00',
    business_hours_end TEXT NOT NULL DEFAULT '17:00',
    available_days TEXT NOT NULL DEFAULT '1,2,3,4,5', -- Mon-Fri (0=Sunday, 6=Saturday)
    slot_duration_options TEXT NOT NULL DEFAULT '15,30,60', -- Available durations in minutes
    max_advance_days INTEGER NOT NULL DEFAULT 30,
    min_advance_hours INTEGER NOT NULL DEFAULT 24,
    meeting_platforms TEXT NOT NULL DEFAULT 'discord,google,teams,jitsi',
    last_updated INTEGER NOT NULL,
    CHECK(id = 1) -- Ensure only one config row exists
);

-- Insert default configuration
INSERT INTO appointment_config (
    timezone,
    business_hours_start,
    business_hours_end,
    available_days,
    slot_duration_options,
    max_advance_days,
    min_advance_hours,
    meeting_platforms,
    last_updated
) VALUES (
    'America/Los_Angeles',
    '09:00',
    '17:00',
    '1,2,3,4,5',
    '15,30,60',
    30,
    24,
    'discord,google,teams,jitsi',
    unixepoch()
);

-- Appointments table for storing booked slots
CREATE TABLE appointments (
    id TEXT PRIMARY KEY,
    submission_id TEXT, -- Links to contact_submissions if created via contact form
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT, -- Optional message from contact form

    -- Slot information
    slot_id TEXT NOT NULL UNIQUE, -- Prevents double-booking the same slot
    date TEXT NOT NULL, -- YYYY-MM-DD
    start_time TEXT NOT NULL, -- ISO 8601 format
    end_time TEXT NOT NULL, -- ISO 8601 format
    duration INTEGER NOT NULL, -- Minutes (15, 30, or 60)
    timezone TEXT NOT NULL, -- IANA timezone

    -- Meeting information
    platform TEXT NOT NULL CHECK(platform IN ('discord', 'google', 'teams', 'jitsi')),
    meeting_link TEXT, -- Generated meeting link
    meeting_id TEXT, -- External meeting ID (Google/Teams event ID)

    -- Status tracking
    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cancelled_at INTEGER,

    -- Metadata
    ip_address TEXT,
    user_agent TEXT,
    confirmation_sent BOOLEAN DEFAULT 0,
    reminder_sent BOOLEAN DEFAULT 0,

    FOREIGN KEY (submission_id) REFERENCES contact_submissions(id)
);

-- Indexes for efficient queries
CREATE INDEX idx_appointments_date ON appointments(date);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_email ON appointments(email);
CREATE INDEX idx_appointments_created_at ON appointments(created_at);
CREATE INDEX idx_appointments_slot_id ON appointments(slot_id);
CREATE INDEX idx_appointments_start_time ON appointments(start_time);

-- Index for checking availability (most important query)
CREATE INDEX idx_appointments_active_slots ON appointments(date, slot_id, status)
    WHERE status = 'confirmed';

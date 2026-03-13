-- Migration: Create templates and prompts tables
-- Created: 2025-01-20

-- Email templates table
-- Stores email template content with versioning and multi-language support
CREATE TABLE email_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, -- Unique identifier like 'appointment_confirmation'
    type TEXT NOT NULL DEFAULT 'email' CHECK(type IN ('email', 'sms', 'push')),
    subject TEXT, -- Email subject line (supports {{variables}})
    body TEXT NOT NULL, -- Email body text (supports {{variables}})
    language TEXT NOT NULL DEFAULT 'en', -- ISO 639-1 language code
    version INTEGER NOT NULL DEFAULT 1, -- Auto-incremented on updates
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'draft', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT, -- Admin identifier who created/updated
    metadata TEXT -- JSON string for additional data (tags, description, etc.)
);

-- Unique constraint: one active template per name+language combination
CREATE UNIQUE INDEX idx_email_templates_unique_active
ON email_templates(name, language) WHERE status = 'active';

-- Index for quick lookups
CREATE INDEX idx_email_templates_name ON email_templates(name);
CREATE INDEX idx_email_templates_status ON email_templates(status);
CREATE INDEX idx_email_templates_language ON email_templates(language);
CREATE INDEX idx_email_templates_updated ON email_templates(updated_at);

-- Chatbot prompts table
-- Stores LLM prompts with configuration for chatbot integrations
CREATE TABLE chatbot_prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, -- Unique identifier like 'greeting', 'help_request'
    system_prompt TEXT NOT NULL, -- System/context message for LLM
    user_prompt TEXT, -- Optional user message template
    context_window INTEGER DEFAULT 4096, -- Max tokens for context
    temperature REAL DEFAULT 0.7, -- LLM temperature (0.0-2.0)
    max_tokens INTEGER DEFAULT 500, -- Max response tokens
    model TEXT DEFAULT 'gpt-4', -- LLM model identifier
    language TEXT NOT NULL DEFAULT 'en', -- ISO 639-1 language code
    version INTEGER NOT NULL DEFAULT 1, -- Auto-incremented on updates
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'draft', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT, -- Admin identifier
    metadata TEXT -- JSON string (use_case, tags, etc.)
);

-- Unique constraint: one active prompt per name+language
CREATE UNIQUE INDEX idx_chatbot_prompts_unique_active
ON chatbot_prompts(name, language) WHERE status = 'active';

-- Indexes for quick lookups
CREATE INDEX idx_chatbot_prompts_name ON chatbot_prompts(name);
CREATE INDEX idx_chatbot_prompts_status ON chatbot_prompts(status);
CREATE INDEX idx_chatbot_prompts_language ON chatbot_prompts(language);
CREATE INDEX idx_chatbot_prompts_updated ON chatbot_prompts(updated_at);

-- Template version history table
-- Audit trail for all template/prompt changes
CREATE TABLE template_versions (
    id TEXT PRIMARY KEY,
    template_type TEXT NOT NULL CHECK(template_type IN ('email', 'chatbot')),
    template_id TEXT NOT NULL, -- References email_templates.id or chatbot_prompts.id
    version INTEGER NOT NULL,
    content TEXT NOT NULL, -- Full JSON snapshot of the template at this version
    changed_by TEXT, -- Admin identifier who made the change
    changed_at INTEGER NOT NULL,
    change_notes TEXT -- Optional notes about what changed
);

-- Indexes for version history
CREATE INDEX idx_template_versions_template ON template_versions(template_id, template_type);
CREATE INDEX idx_template_versions_changed_at ON template_versions(changed_at);

-- Seed initial email templates (migrating from hardcoded templates.ts)
INSERT INTO email_templates (
    id, name, type, subject, body, language, version, status,
    created_at, updated_at, created_by, metadata
) VALUES (
    'tpl_appt_confirm_v1',
    'appointment_confirmation',
    'email',
    'Appointment Confirmed - {{appointmentDate}} at {{startTime}}',
    'Hi {{recipientName}},

Your appointment has been confirmed!

APPOINTMENT DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date:     {{appointmentDate}}
Time:     {{startTime}} - {{endTime}} {{timezone}}
Duration: {{duration}} minutes
Platform: {{platformName}}
{{#if meetingLink}}

Meeting Link:
{{meetingLink}}
{{/if}}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{{#if message}}
YOUR MESSAGE:
{{message}}

{{/if}}
WHAT TO EXPECT
{{platformInstructions}}

NEED TO RESCHEDULE?
If you need to change or cancel this appointment, please reply to this email as soon as possible.

Looking forward to speaking with you!

Best regards,
Matthaeus Wolf
hadoku.me

---
This confirmation was sent from an automated system.
Reply to this email to reach me directly at matthaeus@hadoku.me.',
    'en',
    1,
    'active',
    unixepoch(),
    unixepoch(),
    'system',
    '{"description": "Confirmation email sent when appointment is booked", "tags": ["appointment", "confirmation"]}'
);

INSERT INTO email_templates (
    id, name, type, subject, body, language, version, status,
    created_at, updated_at, created_by, metadata
) VALUES (
    'tpl_appt_reminder_v1',
    'appointment_reminder',
    'email',
    'Reminder: Appointment Tomorrow - {{appointmentDate}} at {{startTime}}',
    'Hi {{recipientName}},

This is a friendly reminder about your upcoming appointment tomorrow.

APPOINTMENT DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date:     {{appointmentDate}}
Time:     {{startTime}} - {{endTime}} {{timezone}}
Duration: {{duration}} minutes
Platform: {{platformName}}
{{#if meetingLink}}

Meeting Link:
{{meetingLink}}
{{/if}}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{{platformInstructions}}

NEED TO RESCHEDULE?
If something came up and you need to reschedule, please let me know as soon as possible.

Looking forward to our conversation!

Best regards,
Matthaeus Wolf
hadoku.me

---
Reply to this email to reach me directly at matthaeus@hadoku.me.',
    'en',
    1,
    'active',
    unixepoch(),
    unixepoch(),
    'system',
    '{"description": "Reminder email sent 24 hours before appointment", "tags": ["appointment", "reminder"]}'
);

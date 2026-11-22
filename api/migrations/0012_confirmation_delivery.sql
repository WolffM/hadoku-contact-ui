-- What happened to a booking's confirmation email.
--
-- `confirmation_sent` was declared in 0004 and never written, so it read 0 on
-- every appointment ever booked and said nothing. These columns are written:
-- the Resend id when the send is accepted, then each delivery webhook Resend
-- posts for that id (sent, delivered, delivery_delayed, bounced, complained).
-- A bounce is how a mistyped address shows up after the fact.

ALTER TABLE appointments ADD COLUMN confirmation_email_id TEXT;
ALTER TABLE appointments ADD COLUMN confirmation_status TEXT;
ALTER TABLE appointments ADD COLUMN confirmation_status_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_appointments_confirmation_email_id
  ON appointments(confirmation_email_id);


-- Never written by any code path (no reminder was ever sent either), so both
-- read 0 on every row. 0012's confirmation_email_id/_status replace the first;
-- nothing replaces the second. Dropped one release after 0012, once no
-- deployed code inserted them.

ALTER TABLE appointments DROP COLUMN confirmation_sent;
ALTER TABLE appointments DROP COLUMN reminder_sent;

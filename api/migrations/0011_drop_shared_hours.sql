-- The single shared range that weekly_hours (0010) replaced. Dropped once the
-- code reading weekly_hours was live, so no running worker reads these.

ALTER TABLE appointment_config DROP COLUMN business_hours_start;
ALTER TABLE appointment_config DROP COLUMN business_hours_end;
ALTER TABLE appointment_config DROP COLUMN available_days;

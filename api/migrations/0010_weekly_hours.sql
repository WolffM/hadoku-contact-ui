-- Availability becomes a weekly grid of hours: one '0'/'1' per hour of the
-- week, index day * 24 + hour (0 = Sunday), wall-clock in `timezone`.
--
-- Filled from the single shared range it replaces (business_hours_start/_end
-- over available_days), so the slots offered do not change when this lands.
-- Those three columns stay until the code that reads weekly_hours is live;
-- dropping them here would break the running worker for the seconds between
-- this migration and its deploy. 0011 drops them.

ALTER TABLE appointment_config ADD COLUMN weekly_hours TEXT NOT NULL DEFAULT '';

WITH RECURSIVE hour_index(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM hour_index WHERE n < 167
)
UPDATE appointment_config
SET weekly_hours = (
  SELECT group_concat(bit, '')
  FROM (
    SELECT
      CASE
        WHEN instr(',' || replace(appointment_config.available_days, ' ', '') || ',', ',' || (n / 24) || ',') > 0
          AND (n % 24) >= CAST(substr(appointment_config.business_hours_start, 1, 2) AS INTEGER)
          AND (n % 24) < CAST(substr(appointment_config.business_hours_end, 1, 2) AS INTEGER)
        THEN '1'
        ELSE '0'
      END AS bit
    FROM hour_index
    ORDER BY n
  )
)
WHERE id = 1;

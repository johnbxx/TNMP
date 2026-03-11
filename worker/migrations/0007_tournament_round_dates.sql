-- Replace start_date + total_rounds with round_dates JSON array + url
-- round_dates stores all round dates as a JSON array of ISO date strings
-- url stores the tournament page URL

ALTER TABLE tournaments ADD COLUMN round_dates TEXT;
ALTER TABLE tournaments ADD COLUMN url TEXT;

-- Backfill round_dates from start_date + total_rounds (TNMs are weekly on Tuesdays)
UPDATE tournaments SET round_dates = (
    WITH RECURSIVE dates(i, d) AS (
        SELECT 0, start_date
        UNION ALL
        SELECT i + 1, date(start_date, '+' || ((i + 1) * 7) || ' days')
        FROM dates WHERE i + 1 < total_rounds
    )
    SELECT json_group_array(d) FROM dates
) WHERE start_date IS NOT NULL AND total_rounds IS NOT NULL;

ALTER TABLE tournaments DROP COLUMN start_date;
ALTER TABLE tournaments DROP COLUMN total_rounds;

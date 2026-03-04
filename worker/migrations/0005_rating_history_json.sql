-- Move rating history from separate table to JSON column on players
DROP TABLE IF EXISTS rating_history;
ALTER TABLE players ADD COLUMN rating_history TEXT;

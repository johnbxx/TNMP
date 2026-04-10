-- Add detailed tournament metadata (sourced from US Chess API)
ALTER TABLE tournaments ADD COLUMN time_control TEXT;
ALTER TABLE tournaments ADD COLUMN player_count INTEGER;
ALTER TABLE tournaments ADD COLUMN game_count INTEGER;
ALTER TABLE tournaments ADD COLUMN director TEXT;
ALTER TABLE tournaments ADD COLUMN organizer TEXT;

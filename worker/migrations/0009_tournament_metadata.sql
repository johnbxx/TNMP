-- Add total_rounds and sections columns to tournaments
ALTER TABLE tournaments ADD COLUMN total_rounds INTEGER;
ALTER TABLE tournaments ADD COLUMN sections TEXT;

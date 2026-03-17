-- Restore the UNIQUE constraint on (tournament_slug, round, board) that was lost.
-- This is required for ON CONFLICT upserts in the cron game ingestion.
CREATE UNIQUE INDEX idx_games_slug_round_board ON games(tournament_slug, round, board);

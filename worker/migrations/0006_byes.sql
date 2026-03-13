-- Byes table: tracks non-game rounds (half-point, full-point, zero-point byes)
CREATE TABLE IF NOT EXISTS byes (
  tournament_slug TEXT NOT NULL,
  round INTEGER NOT NULL,
  player_norm TEXT NOT NULL,
  bye_type TEXT NOT NULL, -- 'half', 'full', 'zero'
  PRIMARY KEY (tournament_slug, round, player_norm)
);

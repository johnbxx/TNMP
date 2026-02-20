-- D1 schema for TNMP game storage
-- Replaces GAMES KV for structured game data (game:*, index:*, gameid:* keys)

CREATE TABLE tournaments (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_code TEXT,
    start_date TEXT,
    total_rounds INTEGER
);

CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_slug TEXT NOT NULL REFERENCES tournaments(slug),
    round INTEGER NOT NULL,
    board INTEGER,
    white TEXT NOT NULL,
    black TEXT NOT NULL,
    white_norm TEXT NOT NULL,
    black_norm TEXT NOT NULL,
    white_elo INTEGER,
    black_elo INTEGER,
    result TEXT,
    eco TEXT,
    opening_name TEXT,
    section TEXT,
    date TEXT,
    game_id TEXT,
    pgn TEXT,
    UNIQUE(tournament_slug, round, board)
);

CREATE INDEX idx_white ON games(white_norm);
CREATE INDEX idx_black ON games(black_norm);
CREATE INDEX idx_eco ON games(eco);
CREATE INDEX idx_tournament_round ON games(tournament_slug, round);
CREATE INDEX idx_date ON games(date);
CREATE INDEX idx_game_id ON games(game_id);

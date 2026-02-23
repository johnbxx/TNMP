-- Staging table for community-submitted PGNs (moderated before promotion to games table)

CREATE TABLE game_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_slug TEXT NOT NULL REFERENCES tournaments(slug),
    round INTEGER NOT NULL,
    board INTEGER NOT NULL,
    white TEXT NOT NULL,
    black TEXT NOT NULL,
    white_norm TEXT NOT NULL,
    black_norm TEXT NOT NULL,
    result TEXT,
    eco TEXT,
    opening_name TEXT,
    section TEXT,
    pgn TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    submitted_by TEXT,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tournament_slug, round, board, status)
);

CREATE INDEX idx_submissions_lookup ON game_submissions(tournament_slug, round, board, status);
CREATE INDEX idx_submissions_status ON game_submissions(status);

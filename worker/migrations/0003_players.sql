-- Players table: canonical identity for each chess player
CREATE TABLE players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_norm TEXT NOT NULL,
    uscf_id TEXT,
    aliases TEXT DEFAULT '[]',
    UNIQUE(name_norm)
);

CREATE INDEX idx_players_uscf ON players(uscf_id);

-- Add USCF event ID to tournaments
ALTER TABLE tournaments ADD COLUMN uscf_event_id TEXT;

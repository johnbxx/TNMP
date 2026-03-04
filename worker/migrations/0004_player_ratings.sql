-- Add current USCF rating to players table
ALTER TABLE players ADD COLUMN rating INTEGER;
ALTER TABLE players ADD COLUMN rating_updated_at TEXT;

-- Rating history time series (one row per player per supplement month)
CREATE TABLE rating_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uscf_id TEXT NOT NULL,
    date TEXT NOT NULL,
    rating INTEGER NOT NULL,
    UNIQUE(uscf_id, date)
);

CREATE INDEX idx_rating_history_uscf ON rating_history(uscf_id);

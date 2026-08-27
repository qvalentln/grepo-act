CREATE TABLE IF NOT EXISTS players (
    player_id INT PRIMARY KEY,
    name TEXT NOT NULL,
    alliance_id INT,
    alliance_name TEXT,
    points INT DEFAULT 0,
    abp INT DEFAULT 0,
    dbp INT DEFAULT 0,
    inactive_hours INT DEFAULT 0,
    was_inactive BOOLEAN DEFAULT FALSE,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alliances (
    alliance_id INT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE INDEX idx_players_alliance ON players(alliance_id);
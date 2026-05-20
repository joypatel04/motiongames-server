CREATE TABLE IF NOT EXISTS arena_games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category TEXT DEFAULT 'action'
    CHECK (category IN ('action', 'puzzle', 'sports', 'party', 'educational', 'custom')),
  scoring_type TEXT DEFAULT 'points'
    CHECK (scoring_type IN ('points', 'time', 'survival', 'distance', 'custom')),
  min_players INTEGER DEFAULT 1,
  max_players INTEGER DEFAULT 8,
  default_duration_seconds INTEGER DEFAULT 60,
  difficulty_levels TEXT DEFAULT '["easy","medium","hard"]',
  is_active INTEGER DEFAULT 1,
  is_premium INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS arena_sessions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES arena_games(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'completed', 'cancelled')),
  player_count INTEGER NOT NULL DEFAULT 1,
  difficulty TEXT DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  start_time TEXT,
  end_time TEXT,
  duration_seconds INTEGER,
  total_price REAL,
  payment_status TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'on_credit', 'cancelled')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON arena_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON arena_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_synced ON arena_sessions(synced);

CREATE TABLE IF NOT EXISTS arena_scores (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  customer_id TEXT,
  player_profile_id TEXT,
  score INTEGER DEFAULT 0,
  rank INTEGER,
  is_winner INTEGER DEFAULT 0,
  stats TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scores_session ON arena_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_scores_synced ON arena_scores(synced);

CREATE TABLE IF NOT EXISTS arena_leaderboard (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES arena_games(id),
  display_name TEXT NOT NULL,
  customer_id TEXT,
  player_profile_id TEXT,
  total_games INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  highest_score INTEGER DEFAULT 0,
  average_score REAL DEFAULT 0,
  wins INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_played_at TEXT,
  UNIQUE(game_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_game ON arena_leaderboard(game_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_highest ON arena_leaderboard(game_id, highest_score DESC);

CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE')),
  payload TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_unsynced ON sync_queue(synced) WHERE synced = 0;

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'scroll-stopper.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    is_test_video INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS watch_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    watch_seconds REAL NOT NULL,
    feed_position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_videos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_library_videos (
    session_id TEXT NOT NULL,
    library_video_id TEXT NOT NULL,
    PRIMARY KEY (session_id, library_video_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (library_video_id) REFERENCES library_videos(id) ON DELETE CASCADE
  );
`);

module.exports = db;

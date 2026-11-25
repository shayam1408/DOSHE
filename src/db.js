const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'doshe.db');

/**
 * Initialize and return the persistent SQLite database connection for DOSHE.
 * Ensures the data directory exists, enables WAL mode, creates tables/indexes,
 * and applies non-destructive column migrations for existing databases.
 */
function initDatabase(dbPath = process.env.DOSHE_DB_PATH || DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intention TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      actual_minutes REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
      reflection TEXT NOT NULL DEFAULT '',
      tab_switches INTEGER NOT NULL DEFAULT 0,
      strict_mode INTEGER NOT NULL DEFAULT 0,
      breaches INTEGER NOT NULL DEFAULT 0,
      task_id INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      tag TEXT NOT NULL DEFAULT 'Study' CHECK (tag IN ('Study', 'Build', 'Personal')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
      est_sprints INTEGER NOT NULL DEFAULT 1 CHECK (est_sprints >= 1 AND est_sprints <= 20),
      completed_sprints INTEGER NOT NULL DEFAULT 0 CHECK (completed_sprints >= 0),
      is_top3 INTEGER NOT NULL DEFAULT 0 CHECK (is_top3 IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      video_title TEXT NOT NULL DEFAULT 'Untitled Study Stream',
      timestamp_sec INTEGER NOT NULL DEFAULT 0,
      note_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS study_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      video_title TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS urges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_source TEXT NOT NULL DEFAULT 'Impulse Feed',
      outcome TEXT NOT NULL DEFAULT 'resisted' CHECK (outcome IN ('resisted', 'pivoted', 'yielded')),
      cooldown_sec INTEGER NOT NULL DEFAULT 15,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
    CREATE INDEX IF NOT EXISTS idx_notes_video_ts ON notes (video_id, timestamp_sec ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_study_queue_order ON study_queue (completed ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_urges_created_at ON urges (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_order ON tasks (status ASC, is_top3 DESC, id DESC);
  `);

  // Safe migrations for pre-existing databases
  const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (!sessionCols.has('tab_switches')) {
    db.exec('ALTER TABLE sessions ADD COLUMN tab_switches INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionCols.has('strict_mode')) {
    db.exec('ALTER TABLE sessions ADD COLUMN strict_mode INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionCols.has('breaches')) {
    db.exec('ALTER TABLE sessions ADD COLUMN breaches INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionCols.has('task_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN task_id INTEGER DEFAULT NULL');
  }

  return db;
}

/**
 * Compute aggregate focus, integrity, urge-shield, and note telemetry from SQLite.
 */
function getTelemetryMetrics(db) {
  const sessionAgg = db.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
      SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_sessions,
      ROUND(COALESCE(SUM(CASE WHEN status != 'active' THEN actual_minutes ELSE 0 END), 0), 1) AS total_deep_focus_minutes,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN target_minutes ELSE 0 END), 0) AS completed_target_minutes,
      COALESCE(SUM(tab_switches), 0) AS total_tab_switches,
      COALESCE(SUM(breaches), 0) AS total_breaches,
      ROUND(AVG(CASE
        WHEN status != 'active' THEN MAX(0, 100 - (tab_switches * 5) - (breaches * 15))
        ELSE NULL
      END), 0) AS avg_focus_integrity
    FROM sessions
  `).get();

  const noteAgg = db.prepare(`
    SELECT
      COUNT(*) AS total_notes,
      COUNT(DISTINCT video_id) AS total_videos
    FROM notes
  `).get();

  const urgeAgg = db.prepare(`
    SELECT
      COUNT(*) AS total_urges,
      COALESCE(SUM(CASE WHEN outcome IN ('resisted', 'pivoted') THEN 1 ELSE 0 END), 0) AS urges_resisted
    FROM urges
  `).get();

  const finishedCount = (sessionAgg.completed_sessions || 0) + (sessionAgg.abandoned_sessions || 0);
  const completionRate = finishedCount > 0
    ? Math.round(((sessionAgg.completed_sessions || 0) / finishedCount) * 100)
    : 0;

  const focusIntegrityPct = finishedCount > 0 && sessionAgg.avg_focus_integrity !== null
    ? Math.max(0, Math.min(100, Number(sessionAgg.avg_focus_integrity)))
    : 100;

  const recentDays = db.prepare(`
    SELECT
      substr(created_at, 1, 10) AS day,
      ROUND(COALESCE(SUM(actual_minutes), 0), 1) AS minutes,
      COUNT(*) AS sessions
    FROM sessions
    WHERE created_at >= datetime('now', '-6 days')
    GROUP BY substr(created_at, 1, 10)
    ORDER BY day ASC
  `).all();

  return {
    total_deep_focus_minutes: sessionAgg.total_deep_focus_minutes || 0,
    completed_target_minutes: sessionAgg.completed_target_minutes || 0,
    total_sessions: sessionAgg.total_sessions || 0,
    completed_sessions: sessionAgg.completed_sessions || 0,
    abandoned_sessions: sessionAgg.abandoned_sessions || 0,
    active_sessions: sessionAgg.active_sessions || 0,
    intent_completion_rate: completionRate,
    total_tab_switches: sessionAgg.total_tab_switches || 0,
    total_breaches: sessionAgg.total_breaches || 0,
    focus_integrity_pct: focusIntegrityPct,
    urges_resisted: urgeAgg.urges_resisted || 0,
    total_urges: urgeAgg.total_urges || 0,
    total_notes: noteAgg.total_notes || 0,
    total_videos: noteAgg.total_videos || 0,
    daily_cadence: recentDays
  };
}

/**
 * Delete a single FocusTube study note by ID. Returns true if a row was deleted.
 */
function deleteNote(db, id) {
  const info = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return info.changes > 0;
}

module.exports = {
  initDatabase,
  getTelemetryMetrics,
  deleteNote
};

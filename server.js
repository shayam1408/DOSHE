const path = require('node:path');
const express = require('express');
const { initDatabase, getTelemetryMetrics, deleteNote } = require('./src/db');
const { runLocalStudyCoach } = require('./src/coach');

const VALID_SESSION_STATUSES = new Set(['active', 'completed', 'abandoned']);
const VALID_COACH_MODES = new Set(['summary', 'quiz', 'study_pack']);
const VALID_URGE_OUTCOMES = new Set(['resisted', 'pivoted', 'yielded']);
const TASK_TAG_MAP = new Map([
  ['study', 'Study'],
  ['build', 'Build'],
  ['personal', 'Personal']
]);
const VALID_TASK_TAGS = new Set(['Study', 'Build', 'Personal']);
const VALID_TASK_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_TASK_STATUSES = new Set(['todo', 'done']);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Extract a clean YouTube video ID from a URL or raw ID string.
 */
function extractYouTubeId(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const bareCandidate = raw.split(/[?&#/]/)[0];
  if (!raw.includes('.') && /^[A-Za-z0-9_-]{11}$/.test(bareCandidate)) {
    return bareCandidate;
  }

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (url.hostname.includes('youtu.be')) {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      if (seg && /^[A-Za-z0-9_-]{11}$/.test(seg)) return seg;
    }
    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
        if (/^[A-Za-z0-9_-]{11}$/.test(parts[1])) return parts[1];
      }
    }
  } catch (_) {
    // fall through to raw ID check
  }

  return VIDEO_ID_RE.test(raw) ? raw : '';
}

function formatSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    strict_mode: Boolean(row.strict_mode)
  };
}

function formatTaskRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_top3: Boolean(row.is_top3)
  };
}

/**
 * Create and configure the Express application with injected or default SQLite DB.
 */
function createApp(options = {}) {
  const db = options.db || initDatabase(options.dbPath);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // GET /api/health
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({
        ok: true,
        status: 'healthy',
        service: 'doshe-os',
        version: '1.0.0',
        db: 'connected',
        uptime_sec: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        status: 'degraded',
        error: err.message
      });
    }
  });

  // GET /api/sessions
  app.get('/api/sessions', (req, res) => {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    if (statusFilter && !VALID_SESSION_STATUSES.has(statusFilter)) {
      return res.status(400).json({
        error: 'Invalid status filter. Expected active, completed, or abandoned.'
      });
    }

    const sessions = (statusFilter
      ? db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(statusFilter, limit)
      : db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    ).map(formatSessionRow);

    const telemetry = getTelemetryMetrics(db);
    return res.json({ sessions, telemetry });
  });

  // POST /api/sessions
  app.post('/api/sessions', (req, res) => {
    const body = req.body || {};
    const intention = typeof body.intention === 'string' ? body.intention.trim() : '';
    if (!intention || intention.length > 280) {
      return res.status(400).json({
        error: 'Intention is required and must be 1–280 characters.'
      });
    }

    const targetMinutes = body.target_minutes === undefined ? 25 : Number(body.target_minutes);
    if (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 180) {
      return res.status(400).json({
        error: 'target_minutes must be an integer between 1 and 180.'
      });
    }

    const actualMinutes = body.actual_minutes === undefined ? 0 : Number(body.actual_minutes);
    if (!Number.isFinite(actualMinutes) || actualMinutes < 0 || actualMinutes > 360) {
      return res.status(400).json({
        error: 'actual_minutes must be a finite number between 0 and 360.'
      });
    }

    const status = typeof body.status === 'string' ? body.status.trim() : 'active';
    if (!VALID_SESSION_STATUSES.has(status)) {
      return res.status(400).json({
        error: 'status must be one of: active, completed, abandoned.'
      });
    }

    const reflection = typeof body.reflection === 'string' ? body.reflection.trim() : '';
    if (reflection.length > 2000) {
      return res.status(400).json({
        error: 'reflection must be at most 2000 characters.'
      });
    }

    const tabSwitches = body.tab_switches === undefined ? 0 : Number(body.tab_switches);
    if (!Number.isInteger(tabSwitches) || tabSwitches < 0 || tabSwitches > 10000) {
      return res.status(400).json({
        error: 'tab_switches must be an integer between 0 and 10000.'
      });
    }

    const strictMode = body.strict_mode ? 1 : 0;
    const breaches = body.breaches === undefined ? 0 : Number(body.breaches);
    if (!Number.isInteger(breaches) || breaches < 0 || breaches > 1000) {
      return res.status(400).json({
        error: 'breaches must be an integer between 0 and 1000.'
      });
    }

    let taskId = null;
    if (body.task_id !== undefined && body.task_id !== null && body.task_id !== '') {
      const parsedTaskId = Number(body.task_id);
      if (!Number.isInteger(parsedTaskId) || parsedTaskId <= 0) {
        return res.status(400).json({ error: 'task_id must be a positive integer.' });
      }
      taskId = parsedTaskId;
    }

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO sessions (intention, target_minutes, actual_minutes, status, reflection, tab_switches, strict_mode, breaches, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(intention, targetMinutes, Number(actualMinutes.toFixed(1)), status, reflection, tabSwitches, strictMode, breaches, taskId, now, now);

    const session = formatSessionRow(db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid));
    return res.status(201).json({ session });
  });

  // PATCH /api/sessions/:id
  app.patch('/api/sessions/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const body = req.body || {};
    let intention = existing.intention;
    if (body.intention !== undefined) {
      if (typeof body.intention !== 'string' || !body.intention.trim() || body.intention.trim().length > 280) {
        return res.status(400).json({ error: 'intention must be 1–280 characters.' });
      }
      intention = body.intention.trim();
    }

    let targetMinutes = existing.target_minutes;
    if (body.target_minutes !== undefined) {
      const parsed = Number(body.target_minutes);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 180) {
        return res.status(400).json({ error: 'target_minutes must be an integer between 1 and 180.' });
      }
      targetMinutes = parsed;
    }

    let actualMinutes = existing.actual_minutes;
    if (body.actual_minutes !== undefined) {
      const parsed = Number(body.actual_minutes);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 360) {
        return res.status(400).json({ error: 'actual_minutes must be a finite number between 0 and 360.' });
      }
      actualMinutes = Number(parsed.toFixed(1));
    }

    let status = existing.status;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_SESSION_STATUSES.has(body.status.trim())) {
        return res.status(400).json({ error: 'status must be active, completed, or abandoned.' });
      }
      status = body.status.trim();
    }

    let reflection = existing.reflection;
    if (body.reflection !== undefined) {
      if (typeof body.reflection !== 'string' || body.reflection.trim().length > 2000) {
        return res.status(400).json({ error: 'reflection must be a string up to 2000 characters.' });
      }
      reflection = body.reflection.trim();
    }

    let tabSwitches = existing.tab_switches ?? 0;
    if (body.tab_switches !== undefined) {
      const parsed = Number(body.tab_switches);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
        return res.status(400).json({ error: 'tab_switches must be an integer between 0 and 10000.' });
      }
      tabSwitches = parsed;
    }

    let strictMode = existing.strict_mode ?? 0;
    if (body.strict_mode !== undefined) {
      strictMode = body.strict_mode ? 1 : 0;
    }

    let breaches = existing.breaches ?? 0;
    if (body.breaches !== undefined) {
      const parsed = Number(body.breaches);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
        return res.status(400).json({ error: 'breaches must be an integer between 0 and 1000.' });
      }
      breaches = parsed;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE sessions
      SET intention = ?, target_minutes = ?, actual_minutes = ?, status = ?, reflection = ?, tab_switches = ?, strict_mode = ?, breaches = ?, updated_at = ?
      WHERE id = ?
    `).run(intention, targetMinutes, actualMinutes, status, reflection, tabSwitches, strictMode, breaches, now, id);

    // Automatically increment linked task's completed_sprints when transitioning to completed
    let updatedTask = null;
    const linkedTaskId = existing.task_id || (Number.isInteger(Number(body.task_id)) && Number(body.task_id) > 0 ? Number(body.task_id) : null);
    if (existing.status !== 'completed' && status === 'completed' && linkedTaskId) {
      const incInfo = db.prepare(`
        UPDATE tasks
        SET completed_sprints = completed_sprints + 1
        WHERE id = ?
      `).run(linkedTaskId);
      if (incInfo.changes > 0) {
        updatedTask = formatTaskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(linkedTaskId));
      }
    }

    const session = formatSessionRow(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    return res.json({ session, task: updatedTask });
  });

  // GET /api/notes
  app.get('/api/notes', (req, res) => {
    const videoId = typeof req.query.video_id === 'string' ? req.query.video_id.trim() : '';
    const notes = videoId
      ? db.prepare('SELECT * FROM notes WHERE video_id = ? ORDER BY timestamp_sec ASC, id ASC').all(videoId)
      : db.prepare('SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT 300').all();

    return res.json({ notes });
  });

  // POST /api/notes
  app.post('/api/notes', (req, res) => {
    const body = req.body || {};
    const videoId = typeof body.video_id === 'string' ? body.video_id.trim() : '';
    if (!VIDEO_ID_RE.test(videoId)) {
      return res.status(400).json({
        error: 'video_id must be 3–64 URL-safe characters (letters, digits, - or _).'
      });
    }

    const rawTitle = typeof body.video_title === 'string' ? body.video_title.trim() : '';
    const videoTitle = rawTitle ? rawTitle.slice(0, 200) : `Study Stream (${videoId})`;

    const timestampSec = body.timestamp_sec === undefined ? 0 : Number(body.timestamp_sec);
    if (!Number.isFinite(timestampSec) || timestampSec < 0 || timestampSec > 86400) {
      return res.status(400).json({
        error: 'timestamp_sec must be a number between 0 and 86400.'
      });
    }

    const noteText = typeof body.note_text === 'string' ? body.note_text.trim() : '';
    if (!noteText || noteText.length > 4000) {
      return res.status(400).json({
        error: 'note_text is required and must be 1–4000 characters.'
      });
    }

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO notes (video_id, video_title, timestamp_sec, note_text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(videoId, videoTitle, Math.floor(timestampSec), noteText, now);

    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({ note });
  });

  // DELETE /api/notes/:id
  app.delete('/api/notes/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid note id.' });
    }

    if (!deleteNote(db, id)) {
      return res.status(404).json({ error: 'Note not found.' });
    }

    return res.json({ deleted: true, id });
  });

  // GET /api/queue
  app.get('/api/queue', (req, res) => {
    const queue = db
      .prepare('SELECT * FROM study_queue ORDER BY completed ASC, id ASC LIMIT 200')
      .all()
      .map((row) => ({ ...row, completed: Boolean(row.completed) }));
    return res.json({ queue });
  });

  // POST /api/queue
  app.post('/api/queue', (req, res) => {
    const body = req.body || {};
    const rawCandidate =
      typeof body.video_id === 'string' && body.video_id.trim()
        ? body.video_id
        : typeof body.videoId === 'string' && body.videoId.trim()
          ? body.videoId
          : typeof body.url === 'string'
            ? body.url
            : '';

    const videoId = extractYouTubeId(rawCandidate) || extractYouTubeId(body.url);
    if (!videoId || !VIDEO_ID_RE.test(videoId)) {
      return res.status(400).json({
        error: 'Provide a valid YouTube URL or video_id (3–64 URL-safe characters).'
      });
    }

    const rawTitle =
      typeof body.video_title === 'string'
        ? body.video_title.trim()
        : typeof body.title === 'string'
          ? body.title.trim()
          : '';
    const videoTitle = rawTitle ? rawTitle.slice(0, 200) : `Study Stream (${videoId})`;

    const rawAuthor =
      typeof body.author_name === 'string'
        ? body.author_name.trim()
        : typeof body.author === 'string'
          ? body.author.trim()
          : '';
    const authorName = rawAuthor.slice(0, 120);

    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    const url = rawUrl && /^https?:\/\//i.test(rawUrl)
      ? rawUrl.slice(0, 1000)
      : `https://www.youtube.com/watch?v=${videoId}`;

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO study_queue (video_id, video_title, author_name, url, completed, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(videoId, videoTitle, authorName, url, now);

    const row = db.prepare('SELECT * FROM study_queue WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({ item: { ...row, completed: Boolean(row.completed) } });
  });

  // PATCH /api/queue/:id
  app.patch('/api/queue/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid queue item id.' });
    }

    const existing = db.prepare('SELECT * FROM study_queue WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Queue item not found.' });
    }

    const body = req.body || {};
    let completed = existing.completed;
    if (body.completed !== undefined) {
      if (typeof body.completed === 'boolean') {
        completed = body.completed ? 1 : 0;
      } else if (body.completed === 0 || body.completed === 1) {
        completed = body.completed;
      } else {
        return res.status(400).json({ error: 'completed must be a boolean or 0/1.' });
      }
    }

    let videoTitle = existing.video_title;
    if (body.video_title !== undefined) {
      if (typeof body.video_title !== 'string' || !body.video_title.trim() || body.video_title.trim().length > 200) {
        return res.status(400).json({ error: 'video_title must be 1–200 characters.' });
      }
      videoTitle = body.video_title.trim();
    }

    let authorName = existing.author_name;
    if (body.author_name !== undefined) {
      if (typeof body.author_name !== 'string' || body.author_name.trim().length > 120) {
        return res.status(400).json({ error: 'author_name must be up to 120 characters.' });
      }
      authorName = body.author_name.trim();
    }

    db.prepare(`
      UPDATE study_queue
      SET completed = ?, video_title = ?, author_name = ?
      WHERE id = ?
    `).run(completed, videoTitle, authorName, id);

    const row = db.prepare('SELECT * FROM study_queue WHERE id = ?').get(id);
    return res.json({ item: { ...row, completed: Boolean(row.completed) } });
  });

  // DELETE /api/queue/:id
  app.delete('/api/queue/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid queue item id.' });
    }

    const info = db.prepare('DELETE FROM study_queue WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Queue item not found.' });
    }

    return res.json({ deleted: true, id });
  });

  // GET /api/urges
  app.get('/api/urges', (req, res) => {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

    const urges = db
      .prepare('SELECT * FROM urges ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit);

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_urges,
        COALESCE(SUM(CASE WHEN outcome IN ('resisted', 'pivoted') THEN 1 ELSE 0 END), 0) AS urges_resisted
      FROM urges
    `).get();

    return res.json({ urges, summary });
  });

  // POST /api/urges
  app.post('/api/urges', (req, res) => {
    const body = req.body || {};
    const rawSource = typeof body.trigger_source === 'string' ? body.trigger_source.trim() : '';
    const triggerSource = rawSource ? rawSource.slice(0, 120) : 'Impulse Feed';

    const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : 'resisted';
    if (!VALID_URGE_OUTCOMES.has(outcome)) {
      return res.status(400).json({
        error: 'outcome must be one of: resisted, pivoted, yielded.'
      });
    }

    const cooldownSec = body.cooldown_sec === undefined ? 15 : Number(body.cooldown_sec);
    if (!Number.isInteger(cooldownSec) || cooldownSec < 0 || cooldownSec > 300) {
      return res.status(400).json({
        error: 'cooldown_sec must be an integer between 0 and 300.'
      });
    }

    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO urges (trigger_source, outcome, cooldown_sec, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(triggerSource, outcome, cooldownSec, note, now);

    const urge = db.prepare('SELECT * FROM urges WHERE id = ?').get(info.lastInsertRowid);
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_urges,
        COALESCE(SUM(CASE WHEN outcome IN ('resisted', 'pivoted') THEN 1 ELSE 0 END), 0) AS urges_resisted
      FROM urges
    `).get();

    return res.status(201).json({ urge, summary });
  });

  // GET /api/tasks
  app.get('/api/tasks', (req, res) => {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const tagFilter = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';

    if (statusFilter && !VALID_TASK_STATUSES.has(statusFilter)) {
      return res.status(400).json({ error: 'Invalid task status filter (todo or done).' });
    }
    if (tagFilter && !VALID_TASK_TAGS.has(tagFilter)) {
      return res.status(400).json({ error: 'Invalid task tag filter (Study, Build, or Personal).' });
    }

    const clauses = [];
    const params = [];
    if (statusFilter) {
      clauses.push('status = ?');
      params.push(statusFilter);
    }
    if (tagFilter) {
      clauses.push('tag = ?');
      params.push(tagFilter);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const tasks = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY status ASC, is_top3 DESC, id DESC LIMIT 200`)
      .all(...params)
      .map(formatTaskRow);

    return res.json({ tasks });
  });

  // POST /api/tasks
  app.post('/api/tasks', (req, res) => {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) {
      return res.status(400).json({ error: 'Task title is required and must be 1–200 characters.' });
    }

    const rawTag = typeof body.tag === 'string' ? body.tag.trim().toLowerCase() : '';
    const tag = !rawTag ? 'Study' : TASK_TAG_MAP.get(rawTag);
    if (!tag) {
      return res.status(400).json({ error: 'tag must be one of: Study, Build, Personal.' });
    }

    const rawPriority = typeof body.priority === 'string' ? body.priority.trim().toLowerCase() : '';
    const priority = rawPriority || 'medium';
    if (!VALID_TASK_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: 'priority must be one of: high, medium, low.' });
    }

    const rawEst = body.est_sprints;
    const estSprints = rawEst === undefined || rawEst === null || rawEst === ''
      ? 1
      : Number(rawEst);
    if (!Number.isInteger(estSprints) || estSprints < 1 || estSprints > 20) {
      return res.status(400).json({ error: 'est_sprints must be an integer between 1 and 20.' });
    }

    const isTop3 = body.is_top3 === true || body.is_top3 === 1 || body.is_top3 === '1' || body.is_top3 === 'true' ? 1 : 0;
    if (isTop3) {
      const { cnt } = db.prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE is_top3 = 1 AND status = 'todo'").get();
      if (cnt >= 3) {
        return res.status(400).json({ error: 'Daily Top-3 limit reached (max 3 active Top-3 tasks).' });
      }
    }

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO tasks (title, tag, priority, est_sprints, completed_sprints, is_top3, status, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 'todo', ?)
    `).run(title, tag, priority, estSprints, isTop3, now);

    const task = formatTaskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
    return res.status(201).json({ task });
  });

  // PATCH /api/tasks/:id
  app.patch('/api/tasks/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    const body = req.body || {};
    let title = existing.title;
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
        return res.status(400).json({ error: 'title must be 1–200 characters.' });
      }
      title = body.title.trim();
    }

    let tag = existing.tag;
    if (body.tag !== undefined) {
      if (typeof body.tag !== 'string' || !VALID_TASK_TAGS.has(body.tag.trim())) {
        return res.status(400).json({ error: 'tag must be Study, Build, or Personal.' });
      }
      tag = body.tag.trim();
    }

    let priority = existing.priority;
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'string' || !VALID_TASK_PRIORITIES.has(body.priority.trim().toLowerCase())) {
        return res.status(400).json({ error: 'priority must be high, medium, or low.' });
      }
      priority = body.priority.trim().toLowerCase();
    }

    let estSprints = existing.est_sprints;
    if (body.est_sprints !== undefined) {
      const parsed = Number(body.est_sprints);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        return res.status(400).json({ error: 'est_sprints must be an integer between 1 and 20.' });
      }
      estSprints = parsed;
    }

    let completedSprints = existing.completed_sprints;
    if (body.completed_sprints !== undefined) {
      const parsed = Number(body.completed_sprints);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
        return res.status(400).json({ error: 'completed_sprints must be a non-negative integer.' });
      }
      completedSprints = parsed;
    } else if (body.increment_sprint) {
      completedSprints += 1;
    }

    let status = existing.status;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_TASK_STATUSES.has(body.status.trim())) {
        return res.status(400).json({ error: 'status must be todo or done.' });
      }
      status = body.status.trim();
    }

    let isTop3 = existing.is_top3;
    if (body.is_top3 !== undefined) {
      isTop3 = body.is_top3 ? 1 : 0;
    }

    if (isTop3 === 1 && status === 'todo' && !(existing.is_top3 === 1 && existing.status === 'todo')) {
      const { cnt } = db.prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE is_top3 = 1 AND status = 'todo' AND id != ?").get(id);
      if (cnt >= 3) {
        return res.status(400).json({ error: 'Daily Top-3 limit reached (max 3 active Top-3 tasks).' });
      }
    }

    db.prepare(`
      UPDATE tasks
      SET title = ?, tag = ?, priority = ?, est_sprints = ?, completed_sprints = ?, is_top3 = ?, status = ?
      WHERE id = ?
    `).run(title, tag, priority, estSprints, completedSprints, isTop3, status, id);

    const task = formatTaskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    return res.json({ task });
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }

    const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    return res.json({ deleted: true, id });
  });

  // POST /api/coach (versioned v1 JSON contract with <120ms deterministic local fallback)
  app.post('/api/coach', (req, res) => {
    const body = req.body || {};
    const mode = typeof body.mode === 'string' ? body.mode.trim() : 'study_pack';
    if (!VALID_COACH_MODES.has(mode)) {
      return res.status(400).json({
        api_version: 'v1',
        error: {
          code: 'INVALID_MODE',
          message: 'mode must be one of: summary, quiz, study_pack.'
        }
      });
    }

    const videoId = typeof body.video_id === 'string' ? body.video_id.trim() : '';
    let videoTitle = typeof body.video_title === 'string' ? body.video_title.trim().slice(0, 200) : '';
    const intention = typeof body.intention === 'string' ? body.intention.trim().slice(0, 280) : '';

    let notes = Array.isArray(body.notes) ? body.notes : null;
    if ((!notes || notes.length === 0) && videoId) {
      notes = db
        .prepare('SELECT timestamp_sec, note_text, video_title FROM notes WHERE video_id = ? ORDER BY timestamp_sec ASC, id ASC')
        .all(videoId);
      if (!videoTitle && notes.length > 0) {
        videoTitle = notes[0].video_title;
      }
    }

    const validNotes = (notes || [])
      .filter((n) => n && typeof n.note_text === 'string' && n.note_text.trim().length > 0)
      .slice(0, 100)
      .map((n) => ({
        timestamp_sec: Math.max(0, Math.floor(Number(n.timestamp_sec) || 0)),
        note_text: n.note_text.trim().slice(0, 4000)
      }));

    if (validNotes.length === 0 && !intention && !videoTitle) {
      return res.status(400).json({
        api_version: 'v1',
        error: {
          code: 'EMPTY_CONTEXT',
          message: 'Provide notes, a video_id with saved notes, or an intention/video_title.'
        }
      });
    }

    const payload = runLocalStudyCoach({
      mode,
      video_id: videoId,
      video_title: videoTitle || (videoId ? `Study Stream (${videoId})` : 'FocusTube Study Session'),
      notes: validNotes,
      intention
    });

    return res.json(payload);
  });

  // Fallback for invalid JSON payloads
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON payload.' });
    }
    return next(err);
  });

  // Same-origin SPA fallback
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found.' });
    }
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  return { app, db };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = '0.0.0.0';
  const { app, db } = createApp();

  const server = app.listen(PORT, HOST, () => {
    console.log(`[DOSHE OS] Listening on http://${HOST}:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };

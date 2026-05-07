const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const r2 = require('./r2');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('R2 configured:', !!process.env.R2_ACCOUNT_ID);
console.log('Env vars with R2:', Object.keys(process.env).filter(k => k.includes('R2')));

// Local uploads dir as fallback when R2 is not configured
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const useR2 = !!process.env.R2_ACCOUNT_ID;

const storage = useR2
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: uploadsDir,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
if (!useR2) app.use('/uploads', express.static(uploadsDir));

// Expose R2 public URL to frontend
app.get('/api/config', (req, res) => {
  res.json({ videoBaseUrl: useR2 ? process.env.R2_PUBLIC_URL : '/uploads' });
});

// ── Sessions ──────────────────────────────────────────────────────────────────

app.post('/api/sessions', (req, res) => {
  const id = uuidv4().slice(0, 8);
  const { name } = req.body;
  db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name || 'Untitled Test');
  res.json({ id });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const sessionVideos = db.prepare('SELECT * FROM videos WHERE session_id = ? ORDER BY created_at').all(req.params.id);
  const libraryVideos = db.prepare(`
    SELECT lv.id, lv.filename, lv.original_name, 0 as is_test_video, lv.created_at
    FROM library_videos lv
    JOIN session_library_videos slv ON slv.library_video_id = lv.id
    WHERE slv.session_id = ?
    ORDER BY lv.created_at
  `).all(req.params.id);

  res.json({ ...session, videos: [...libraryVideos, ...sessionVideos] });
});

// ── Library ──────────────────────────────────────────────────────────────────

app.get('/api/library', (req, res) => {
  const videos = db.prepare('SELECT * FROM library_videos ORDER BY created_at DESC').all();
  res.json(videos);
});

app.post('/api/library', upload.single('video'), async (req, res) => {
  try {
    const id = uuidv4();
    const ext = path.extname(req.file.originalname);
    const filename = useR2 ? `${uuidv4()}${ext}` : req.file.filename;

    if (useR2) {
      await r2.uploadFile(filename, req.file.buffer, req.file.mimetype);
    }

    db.prepare('INSERT INTO library_videos (id, filename, original_name) VALUES (?, ?, ?)')
      .run(id, filename, req.file.originalname);
    res.json({ id, filename, original_name: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/library/:id', async (req, res) => {
  try {
    const video = db.prepare('SELECT * FROM library_videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    if (useR2) {
      await r2.deleteFile(video.filename);
    } else {
      const filePath = path.join(uploadsDir, video.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM library_videos WHERE id = ?').run(video.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Session Benchmarks ───────────────────────────────────────────────────────

app.post('/api/sessions/:id/benchmarks', (req, res) => {
  const { id } = req.params;
  const { library_video_ids } = req.body;
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM session_library_videos WHERE session_id = ?').run(id);
    const insert = db.prepare('INSERT INTO session_library_videos (session_id, library_video_id) VALUES (?, ?)');
    for (const vid of library_video_ids) {
      insert.run(id, vid);
    }
  });
  txn();
  res.json({ ok: true, count: library_video_ids.length });
});

// ── Videos ────────────────────────────────────────────────────────────────────

app.post('/api/sessions/:id/videos', upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const ext = path.extname(req.file.originalname);
    const filename = useR2 ? `${uuidv4()}${ext}` : req.file.filename;

    if (useR2) {
      await r2.uploadFile(filename, req.file.buffer, req.file.mimetype);
    }

    const videoId = uuidv4();
    db.prepare('INSERT INTO videos (id, session_id, filename, original_name, is_test_video) VALUES (?, ?, ?, ?, ?)')
      .run(videoId, id, filename, req.file.originalname, req.body.is_test_video === 'true' ? 1 : 0);

    res.json({ id: videoId, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:sessionId/videos/:videoId', async (req, res) => {
  try {
    const video = db.prepare('SELECT * FROM videos WHERE id = ? AND session_id = ?')
      .get(req.params.videoId, req.params.sessionId);
    if (!video) return res.status(404).json({ error: 'Not found' });

    if (useR2) {
      await r2.deleteFile(video.filename);
    } else {
      const filePath = path.join(uploadsDir, video.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Watch Events ──────────────────────────────────────────────────────────────

app.post('/api/sessions/:id/events', (req, res) => {
  const { video_id, viewer_id, watch_seconds, feed_position } = req.body;
  if (!video_id || !viewer_id || watch_seconds === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Only record the first impression — subsequent scrollbacks don't count
  const existing = db.prepare('SELECT id FROM watch_events WHERE video_id = ? AND viewer_id = ?')
    .get(video_id, viewer_id);

  if (!existing) {
    db.prepare('INSERT INTO watch_events (id, session_id, video_id, viewer_id, watch_seconds, feed_position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), req.params.id, video_id, viewer_id, watch_seconds, feed_position || 0);
  }

  res.json({ ok: true });
});

// ── Results ───────────────────────────────────────────────────────────────────

app.get('/api/sessions/:id/results', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  const sessionVideos = db.prepare('SELECT * FROM videos WHERE session_id = ?').all(req.params.id);
  const libraryVideos = db.prepare(`
    SELECT lv.id, lv.filename, lv.original_name, 0 as is_test_video, lv.created_at
    FROM library_videos lv
    JOIN session_library_videos slv ON slv.library_video_id = lv.id
    WHERE slv.session_id = ?
  `).all(req.params.id);
  const videos = [...libraryVideos, ...sessionVideos];

  const results = videos.map(video => {
    const events = db.prepare('SELECT watch_seconds FROM watch_events WHERE video_id = ?').all(video.id);
    const viewerCount = events.length;
    const avgWatch = viewerCount > 0
      ? events.reduce((s, e) => s + e.watch_seconds, 0) / viewerCount
      : 0;
    const maxWatch = viewerCount > 0 ? Math.max(...events.map(e => e.watch_seconds)) : 0;

    return {
      ...video,
      viewer_count: viewerCount,
      avg_watch_seconds: Math.round(avgWatch * 10) / 10,
      max_watch_seconds: Math.round(maxWatch * 10) / 10,
      watch_times: events.map(e => Math.round(e.watch_seconds * 10) / 10)
    };
  });

  res.json({ session, results });
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Scroll Stopper → http://localhost:${PORT}\n`);
});

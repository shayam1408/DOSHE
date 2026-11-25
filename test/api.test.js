const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doshe-test-'));
  const dbPath = path.join(tmpDir, 'doshe.db');
  const { app, db } = createApp({ dbPath });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              db.close();
              fs.rmSync(tmpDir, { recursive: true, force: true });
              done();
            });
          })
      });
    });
  });
}

test('DOSHE API lifecycle, validation, SQLite persistence, and v1 Coach (<120ms)', async () => {
  const srv = await startTestServer();
  try {
    // 1. Health & static assets
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.db, 'connected');

    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /DOSHE/);
    assert.match(html, /youtube-nocookie|FocusTube/i);

    // 2. Sessions CRUD + tab_switches Focus Integrity telemetry
    const badSess = await fetch(`${srv.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intention: '', target_minutes: 25 })
    });
    assert.equal(badSess.status, 400);

    const createSess = await fetch(`${srv.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intention: 'Architect SQLite persistence layer',
        target_minutes: 25,
        status: 'active',
        strict_mode: true
      })
    });
    assert.equal(createSess.status, 201);
    const { session } = await createSess.json();
    assert.equal(session.intention, 'Architect SQLite persistence layer');
    assert.equal(session.status, 'active');
    assert.equal(session.tab_switches, 0);
    assert.equal(session.strict_mode, true);
    assert.equal(session.breaches, 0);

    const patchSess = await fetch(`${srv.baseUrl}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actual_minutes: 25,
        status: 'completed',
        tab_switches: 2,
        breaches: 1,
        reflection: 'Minor doc lookup; clean schema.'
      })
    });
    assert.equal(patchSess.status, 200);
    const patched = await patchSess.json();
    assert.equal(patched.session.status, 'completed');
    assert.equal(patched.session.actual_minutes, 25);
    assert.equal(patched.session.tab_switches, 2);
    assert.equal(patched.session.breaches, 1);
    assert.equal(patched.session.reflection, 'Minor doc lookup; clean schema.');

    const listSess = await fetch(`${srv.baseUrl}/api/sessions`);
    assert.equal(listSess.status, 200);
    const listData = await listSess.json();
    assert.equal(listData.sessions.length, 1);
    assert.equal(listData.telemetry.total_deep_focus_minutes, 25);
    assert.equal(listData.telemetry.intent_completion_rate, 100);
    assert.equal(listData.telemetry.total_tab_switches, 2);
    assert.equal(listData.telemetry.total_breaches, 1);
    assert.equal(listData.telemetry.focus_integrity_pct, 75);

    // 3. FocusTube Notes CRUD + validation
    const badNote = await fetch(`${srv.baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: 'x', note_text: 'too short id' })
    });
    assert.equal(badNote.status, 400);

    const note1 = await fetch(`${srv.baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: 'c85dS_3P42U',
        video_title: 'Distributed Consensus Lecture',
        timestamp_sec: 145,
        note_text: '**Raft Leader Election**: Randomized election timeouts prevent split votes.'
      })
    });
    assert.equal(note1.status, 201);

    const note2 = await fetch(`${srv.baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: 'c85dS_3P42U',
        video_title: 'Distributed Consensus Lecture',
        timestamp_sec: 410,
        note_text: '`Log Replication`: Leader appends entries and commits after majority quorum ack.'
      })
    });
    assert.equal(note2.status, 201);

    const notesRes = await fetch(`${srv.baseUrl}/api/notes?video_id=c85dS_3P42U`);
    assert.equal(notesRes.status, 200);
    const notesData = await notesRes.json();
    assert.equal(notesData.notes.length, 2);
    assert.equal(notesData.notes[0].timestamp_sec, 145);

    // 4. AI Study Coach v1 contract + <120ms local fallback
    const t0 = performance.now();
    const coachRes = await fetch(`${srv.baseUrl}/api/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'study_pack',
        video_id: 'c85dS_3P42U'
      })
    });
    const wallMs = performance.now() - t0;
    assert.equal(coachRes.status, 200);
    const coach = await coachRes.json();
    assert.equal(coach.api_version, 'v1');
    assert.equal(coach.fallback_used, true);
    assert.ok(coach.latency_ms < 120, `Expected coach latency <120ms, got ${coach.latency_ms}ms`);
    assert.ok(wallMs < 120, `Expected round-trip <120ms, got ${wallMs}ms`);
    assert.ok(coach.summary.key_takeaways.length >= 2);
    assert.ok(coach.quiz.length >= 2);
    assert.equal(coach.quiz[0].options.length, 4);

    // 5. Note Deletion (DELETE /api/notes/:id)
    const badDelNote = await fetch(`${srv.baseUrl}/api/notes/not-an-id`, { method: 'DELETE' });
    assert.equal(badDelNote.status, 400);

    const noteIdToDelete = notesData.notes[0].id;
    const delNoteRes = await fetch(`${srv.baseUrl}/api/notes/${noteIdToDelete}`, { method: 'DELETE' });
    assert.equal(delNoteRes.status, 200);
    const delNoteJson = await delNoteRes.json();
    assert.equal(delNoteJson.deleted, true);
    assert.equal(delNoteJson.id, noteIdToDelete);

    const missingNoteRes = await fetch(`${srv.baseUrl}/api/notes/${noteIdToDelete}`, { method: 'DELETE' });
    assert.equal(missingNoteRes.status, 404);

    const afterDelNotes = await fetch(`${srv.baseUrl}/api/notes?video_id=c85dS_3P42U`);
    const afterDelData = await afterDelNotes.json();
    assert.equal(afterDelData.notes.length, 1);
  } finally {
    await srv.close();
  }
});

test('Study Queue (/api/queue) CRUD and validation', async () => {
  const srv = await startTestServer();
  try {
    // Validation check
    const badQueue = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: '!' })
    });
    assert.equal(badQueue.status, 400);

    // Create queue item via URL-only payload + null author_name (oEmbed/offline case)
    const q1Res = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=aircAruvnKk&si=tracking123',
        video_title: 'But what is a neural network?',
        author_name: null
      })
    });
    assert.equal(q1Res.status, 201);
    const { item: item1 } = await q1Res.json();
    assert.equal(item1.video_id, 'aircAruvnKk');
    assert.equal(item1.author_name, '');
    assert.equal(item1.completed, false);

    // Create queue item via raw video_id payload
    const q2Res = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: 'IHZwWFHWa-w',
        video_title: 'Gradient descent, how neural networks learn',
        author_name: '3Blue1Brown'
      })
    });
    assert.equal(q2Res.status, 201);
    const { item: item2 } = await q2Res.json();

    // Create queue item when youtu.be URL is passed directly as video_id
    const q3Res = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: 'https://youtu.be/eMlx5fFNoYc?t=42'
      })
    });
    assert.equal(q3Res.status, 201);
    const { item: item3 } = await q3Res.json();
    assert.equal(item3.video_id, 'eMlx5fFNoYc');
    assert.equal(item3.video_title, 'Study Stream (eMlx5fFNoYc)');

    // Create queue item via raw 11-char ID with omitted URL
    const q4Res = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: 'uv1T8ighqDj'
      })
    });
    assert.equal(q4Res.status, 201);
    const { item: item4 } = await q4Res.json();
    assert.equal(item4.video_id, 'uv1T8ighqDj');
    assert.equal(item4.url, 'https://www.youtube.com/watch?v=uv1T8ighqDj');

    // Create queue item when raw 11-char ID is passed in url field with empty video_id
    const q5Res = await fetch(`${srv.baseUrl}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: '',
        url: 'uv1T8ighqDj'
      })
    });
    assert.equal(q5Res.status, 201);
    const { item: item5 } = await q5Res.json();
    assert.equal(item5.video_id, 'uv1T8ighqDj');
    assert.equal(item5.url, 'https://www.youtube.com/watch?v=uv1T8ighqDj');

    // Mark item1 completed via PATCH
    const patchRes = await fetch(`${srv.baseUrl}/api/queue/${item1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true })
    });
    assert.equal(patchRes.status, 200);
    const { item: patched } = await patchRes.json();
    assert.equal(patched.completed, true);

    // List queue: incomplete items should sort ahead of completed items
    const listRes = await fetch(`${srv.baseUrl}/api/queue`);
    assert.equal(listRes.status, 200);
    const { queue } = await listRes.json();
    assert.equal(queue.length, 5);
    assert.equal(queue[0].id, item2.id);
    assert.equal(queue[4].id, item1.id);

    // Delete item2
    const delRes = await fetch(`${srv.baseUrl}/api/queue/${item2.id}`, {
      method: 'DELETE'
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.deleted, true);

    const missingDel = await fetch(`${srv.baseUrl}/api/queue/99999`, { method: 'DELETE' });
    assert.equal(missingDel.status, 404);
  } finally {
    await srv.close();
  }
});

test('Anti-Doomscroll Urge Shield (/api/urges) persistence and telemetry integration', async () => {
  const srv = await startTestServer();
  try {
    const badUrge = await fetch(`${srv.baseUrl}/api/urges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'unknown_outcome' })
    });
    assert.equal(badUrge.status, 400);

    const u1Res = await fetch(`${srv.baseUrl}/api/urges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_source: 'Instagram Reels',
        outcome: 'resisted',
        cooldown_sec: 15,
        note: 'Boredom trigger between tasks'
      })
    });
    assert.equal(u1Res.status, 201);
    const u1Data = await u1Res.json();
    assert.equal(u1Data.urge.outcome, 'resisted');
    assert.equal(u1Data.summary.urges_resisted, 1);

    const u2Res = await fetch(`${srv.baseUrl}/api/urges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_source: 'YouTube Home',
        outcome: 'pivoted',
        cooldown_sec: 15
      })
    });
    assert.equal(u2Res.status, 201);

    const u3Res = await fetch(`${srv.baseUrl}/api/urges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_source: 'News Feed',
        outcome: 'yielded',
        cooldown_sec: 15
      })
    });
    assert.equal(u3Res.status, 201);

    const listUrges = await fetch(`${srv.baseUrl}/api/urges`);
    assert.equal(listUrges.status, 200);
    const urgesData = await listUrges.json();
    assert.equal(urgesData.urges.length, 3);
    assert.equal(urgesData.summary.total_urges, 3);
    assert.equal(urgesData.summary.urges_resisted, 2);

    // Telemetry endpoint reflects urges_resisted
    const sessRes = await fetch(`${srv.baseUrl}/api/sessions`);
    const { telemetry } = await sessRes.json();
    assert.equal(telemetry.urges_resisted, 2);
    assert.equal(telemetry.total_urges, 3);
  } finally {
    await srv.close();
  }
});

test('Task Backlog & Daily Top-3 (/api/tasks) CRUD, max-3 Top-3 limit, and sprint increment', async () => {
  const srv = await startTestServer();
  try {
    // 1. Validation
    const badTask = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', tag: 'Study' })
    });
    assert.equal(badTask.status, 400);

    // 2. Create 3 Top-3 tasks + 1 backlog task (including string est_sprints & UI default payload)
    const uiDefaultTaskRes = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'UI backlog task payload',
        tag: 'study',
        priority: 'medium',
        est_sprints: '3',
        is_top3: 'false'
      })
    });
    assert.equal(uiDefaultTaskRes.status, 201);
    const uiDefaultTask = await uiDefaultTaskRes.json();
    assert.equal(uiDefaultTask.task.tag, 'Study');
    assert.equal(uiDefaultTask.task.est_sprints, 3);
    assert.equal(uiDefaultTask.task.is_top3, false);

    const createdIds = [];
    for (const [title, tag, is_top3] of [
      ['Derive transformer self-attention', 'Study', true],
      ['Ship DOSHE SQLite tasks module', 'Build', true],
      ['Evening 5km recovery run', 'Personal', true],
      ['Clean up old study notes', 'Study', false]
    ]) {
      const res = await fetch(`${srv.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, tag, est_sprints: 2, is_top3 })
      });
      assert.equal(res.status, 201);
      const { task } = await res.json();
      createdIds.push(task.id);
    }

    // 3. Enforces max 3 active Top-3 tasks
    const fourthTop3 = await fetch(`${srv.baseUrl}/api/tasks/${createdIds[3]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_top3: true })
    });
    assert.equal(fourthTop3.status, 400);

    // 4. Direct sprint increment via PATCH /api/tasks/:id
    const incTaskRes = await fetch(`${srv.baseUrl}/api/tasks/${createdIds[0]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ increment_sprint: true })
    });
    assert.equal(incTaskRes.status, 200);
    const incTask = await incTaskRes.json();
    assert.equal(incTask.task.completed_sprints, 1);

    // 5. Completing a linked session automatically increments task.completed_sprints
    const sessRes = await fetch(`${srv.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intention: 'Derive transformer self-attention',
        target_minutes: 25,
        status: 'active',
        task_id: createdIds[0]
      })
    });
    assert.equal(sessRes.status, 201);
    const { session } = await sessRes.json();

    const finishRes = await fetch(`${srv.baseUrl}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', actual_minutes: 25 })
    });
    assert.equal(finishRes.status, 200);
    const finished = await finishRes.json();
    assert.ok(finished.task);
    assert.equal(finished.task.completed_sprints, 2);

    // 6. Filter & delete
    const studyRes = await fetch(`${srv.baseUrl}/api/tasks?tag=Study`);
    assert.equal(studyRes.status, 200);
    const { tasks: studyTasks } = await studyRes.json();
    assert.equal(studyTasks.length, 3);

    const delRes = await fetch(`${srv.baseUrl}/api/tasks/${createdIds[3]}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const missingDel = await fetch(`${srv.baseUrl}/api/tasks/99999`, { method: 'DELETE' });
    assert.equal(missingDel.status, 404);
  } finally {
    await srv.close();
  }
});

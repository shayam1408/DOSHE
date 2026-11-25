const { performance } = require('node:perf_hooks');

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'your', 'about',
  'what', 'when', 'where', 'which', 'while', 'have', 'has', 'had', 'were', 'was',
  'are', 'been', 'being', 'will', 'would', 'could', 'should', 'can', 'may',
  'not', 'but', 'also', 'than', 'then', 'them', 'they', 'their', 'there', 'these',
  'those', 'some', 'such', 'more', 'most', 'only', 'very', 'just', 'like', 'how',
  'why', 'who', 'each', 'other', 'between', 'through', 'during', 'before', 'after',
  'above', 'below', 'under', 'over', 'again', 'further', 'here', 'both', 'each',
  'using', 'used', 'make', 'makes', 'made', 'need', 'needs', 'note', 'notes',
  'video', 'lecture', 'part', 'section', 'example', 'thing', 'things'
]);

/**
 * Format seconds into MM:SS or HH:MM:SS.
 */
function formatTimestamp(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
}

/**
 * Strip lightweight Markdown syntax so summaries/questions read cleanly.
 */
function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>-]{1,3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic 32-bit FNV-1a hash for stable option placement without randomness.
 */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Extract structured concept candidates from a single note.
 */
function extractConceptsFromNote(note) {
  const raw = String(note.note_text || '');
  const clean = stripMarkdown(raw);
  const ts = Math.max(0, Math.floor(Number(note.timestamp_sec) || 0));
  const tsLabel = formatTimestamp(ts);

  // Look for explicit "Term: explanation" or "Term - explanation" or "Term -> explanation"
  const defMatch = clean.match(/^([A-Za-z0-9][A-Za-z0-9\s/+._-]{1,42}?)\s*(?::|->|=>|=|—|\s-\s)\s+(.{8,})$/);
  if (defMatch) {
    return {
      term: defMatch[1].trim(),
      context: defMatch[2].trim(),
      clean,
      timestamp_sec: ts,
      timestamp_label: tsLabel
    };
  }

  // Look for backticked term
  const codeMatch = raw.match(/`([^`]{2,40})`/);
  if (codeMatch) {
    return {
      term: codeMatch[1].trim(),
      context: clean,
      clean,
      timestamp_sec: ts,
      timestamp_label: tsLabel
    };
  }

  // Fallback to strongest keyword or opening noun phrase
  const words = clean
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w.toLowerCase()));

  const term = words[0]
    ? words[0].charAt(0).toUpperCase() + words[0].slice(1)
    : `Segment ${tsLabel}`;

  return {
    term,
    context: clean,
    clean,
    timestamp_sec: ts,
    timestamp_label: tsLabel
  };
}

/**
 * Rank top keywords across all notes by term frequency.
 */
function extractTopKeywords(notes, limit = 6) {
  const counts = new Map();
  for (const n of notes) {
    const clean = stripMarkdown(n.note_text).toLowerCase();
    const tokens = clean.match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
    for (const token of tokens) {
      if (STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Truncate string gracefully at word boundary.
 */
function truncateText(text, maxLen = 140) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const spaceIdx = cut.lastIndexOf(' ');
  return `${spaceIdx > 40 ? cut.slice(0, spaceIdx) : cut}…`;
}

/**
 * Deterministically rotate an array by an offset and return the new index of item 0.
 */
function rotateOptions(correct, distractors, seedKey) {
  const unique = [correct];
  for (const d of distractors) {
    if (d && !unique.includes(d)) unique.push(d);
    if (unique.length === 4) break;
  }
  const fallbackPool = [
    'Deferred for later review without active verification',
    'Unrelated background noise outside the stated objective',
    'Passive consumption without timestamped synthesis',
    'Skipped segment lacking an explicit cognitive anchor'
  ];
  for (const fb of fallbackPool) {
    if (unique.length === 4) break;
    if (!unique.includes(fb)) unique.push(fb);
  }

  const shift = hashString(seedKey) % unique.length;
  const rotated = unique.map((_, idx) => unique[(idx + shift) % unique.length]);
  const answerIndex = rotated.indexOf(correct);
  return { options: rotated, answerIndex };
}

/**
 * Build deterministic quiz items from extracted concepts.
 */
function buildQuizQuestions(concepts, videoTitle, topKeywords) {
  const questions = [];
  const maxQuestions = Math.min(5, Math.max(1, concepts.length));

  for (let i = 0; i < maxQuestions; i += 1) {
    const item = concepts[i];
    const otherConcepts = concepts.filter((_, idx) => idx !== i);

    if (i % 2 === 0 || concepts.length === 1) {
      // Concept -> explanation recall
      const correct = truncateText(item.context, 110);
      const distractors = otherConcepts.map((c) => truncateText(c.context, 110));
      if (distractors.length < 3 && topKeywords.length > 0) {
        distractors.push(
          `Focuses exclusively on unrelated ${topKeywords[0]} benchmarks without ${item.term} context`
        );
      }
      const { options, answerIndex } = rotateOptions(
        correct,
        distractors,
        `${item.term}:${item.timestamp_sec}:exp`
      );
      questions.push({
        id: `q${i + 1}`,
        type: 'concept_recall',
        timestamp_sec: item.timestamp_sec,
        timestamp_label: item.timestamp_label,
        prompt: `At ${item.timestamp_label} in "${truncateText(videoTitle, 48)}", what key insight is captured for "${item.term}"?`,
        options,
        answer_index: answerIndex,
        explanation: `Anchored at ${item.timestamp_label}: ${truncateText(item.clean, 160)}`
      });
    } else {
      // Timestamp -> concept anchor recall
      const correct = `${item.term} (${item.timestamp_label})`;
      const distractors = otherConcepts.map((c) => `${c.term} (${c.timestamp_label})`);
      const { options, answerIndex } = rotateOptions(
        correct,
        distractors,
        `${item.term}:${item.timestamp_sec}:ts`
      );
      questions.push({
        id: `q${i + 1}`,
        type: 'timestamp_anchor',
        timestamp_sec: item.timestamp_sec,
        timestamp_label: item.timestamp_label,
        prompt: `Which concept corresponds to this study note: "${truncateText(item.context, 100)}"?`,
        options,
        answer_index: answerIndex,
        explanation: `This note belongs to "${item.term}" logged at ${item.timestamp_label}.`
      });
    }
  }

  return questions;
}

/**
 * Execute the DOSHE AI Study Coach v1 deterministic local engine (<120ms, zero network).
 */
function runLocalStudyCoach({
  mode = 'study_pack',
  video_id = '',
  video_title = 'FocusTube Study Session',
  notes = [],
  intention = ''
}) {
  const t0 = performance.now();

  const sortedNotes = [...notes]
    .filter((n) => n && String(n.note_text || '').trim().length > 0)
    .sort((a, b) => (Number(a.timestamp_sec) || 0) - (Number(b.timestamp_sec) || 0));

  const concepts = sortedNotes.map(extractConceptsFromNote);
  const topKeywords = extractTopKeywords(sortedNotes, 6);

  // If caller provided only title + intention with zero notes, synthesize 1 anchor concept
  if (concepts.length === 0) {
    const fallbackText = intention
      ? `Primary study objective: ${intention}`
      : `Structured review session for ${video_title}`;
    concepts.push({
      term: topKeywords[0] || 'Core Objective',
      context: fallbackText,
      clean: fallbackText,
      timestamp_sec: 0,
      timestamp_label: '00:00'
    });
  }

  const minTs = concepts[0].timestamp_sec;
  const maxTs = concepts[concepts.length - 1].timestamp_sec;
  const spanSec = Math.max(0, maxTs - minTs);

  const keywordSummary = topKeywords.length > 0
    ? topKeywords.slice(0, 4).join(', ')
    : concepts.slice(0, 3).map((c) => c.term).join(', ');

  const summary = {
    headline: `${truncateText(video_title, 64)} — Cognitive Synthesis`,
    executive_brief:
      `Captured ${sortedNotes.length || 1} timestamped anchor${sortedNotes.length === 1 ? '' : 's'} ` +
      `spanning ${formatTimestamp(minTs)} to ${formatTimestamp(maxTs)}. ` +
      `Core conceptual clusters: ${keywordSummary || 'primary study objective'}.` +
      (intention ? ` Aligned with intention: "${truncateText(intention, 90)}".` : ''),
    key_takeaways: concepts
      .slice(0, 6)
      .map((c) => `[${c.timestamp_label}] ${c.term}: ${truncateText(c.context, 130)}`),
    concept_map: concepts.slice(0, 8).map((c) => ({
      term: c.term,
      timestamp_sec: c.timestamp_sec,
      timestamp_label: c.timestamp_label,
      context: truncateText(c.context, 120)
    })),
    action_items: [
      `Re-verify ${concepts[0].term} at ${concepts[0].timestamp_label} using active recall without looking at notes.`,
      concepts.length > 1
        ? `Connect ${concepts[0].term} (${concepts[0].timestamp_label}) to ${concepts[concepts.length - 1].term} (${concepts[concepts.length - 1].timestamp_label}) in a 2-sentence Feynman explanation.`
        : `Add 2+ follow-up timestamped examples to sharpen retention density.`,
      'Export the Markdown study pack to Telemetry Vault before closing this FocusTube session.'
    ]
  };

  const quiz = buildQuizQuestions(concepts, video_title, topKeywords);

  const response = {
    api_version: 'v1',
    engine: 'doshe-local-coach-v1',
    fallback_used: true,
    latency_ms: 0,
    mode,
    context: {
      video_id: video_id || null,
      video_title,
      note_count: sortedNotes.length,
      total_span_sec: spanSec,
      keywords: topKeywords
    }
  };

  if (mode === 'summary') {
    response.summary = summary;
  } else if (mode === 'quiz') {
    response.quiz = quiz;
  } else {
    response.summary = summary;
    response.quiz = quiz;
  }

  response.latency_ms = Number((performance.now() - t0).toFixed(2));
  return response;
}

module.exports = {
  runLocalStudyCoach,
  formatTimestamp
};

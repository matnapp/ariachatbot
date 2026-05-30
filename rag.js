require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS = 768;
const embedModel = genai.getGenerativeModel({ model: EMBED_MODEL });

// Tunables
const CHUNK_SIZE = 1500;        // target characters per chunk
const CHUNK_OVERLAP = 200;      // characters carried into the next chunk for continuity
const EMBED_CONCURRENCY = 5;    // parallel embedding requests
const TOP_K = 30;               // max chunks retrieved per question
const RETRIEVAL_CHAR_BUDGET = 60000; // cap on retrieved context size

// In-memory index — no database, per the project's design
let chunks = [];                // [{ fileName, text, embedding:[...] }]
const fileMeta = {};            // fileName -> { modifiedTime }
let lastIndexed = null;
let isIndexing = false;

// Split a markdown document into ~CHUNK_SIZE chunks, preferring paragraph breaks
function chunkText(text) {
  if (!text || !text.trim()) return [];
  const paragraphs = text.split(/\n\s*\n/);
  const out = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > CHUNK_SIZE && current) {
      out.push(current.trim());
      const tail = current.slice(-CHUNK_OVERLAP);
      current = `${tail}\n\n${para}`;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current.trim());

  // Hard-split anything still oversized (e.g. a giant single paragraph)
  const final = [];
  for (const c of out) {
    if (c.length <= CHUNK_SIZE * 1.5) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += CHUNK_SIZE) {
        final.push(c.slice(i, i + CHUNK_SIZE));
      }
    }
  }
  return final;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function embedOne(text, taskType, attempt = 0) {
  try {
    const res = await embedModel.embedContent({
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBED_DIMS,
    });
    return res.embedding.values;
  } catch (err) {
    // Retry on rate-limit / transient errors with exponential backoff
    const retryable = /429|rate|quota|503|500|deadline|timeout/i.test(err.message || '');
    if (retryable && attempt < 5) {
      const wait = Math.min(2000 * 2 ** attempt, 30000);
      await new Promise(r => setTimeout(r, wait));
      return embedOne(text, taskType, attempt + 1);
    }
    throw err;
  }
}

// Embed many texts with bounded concurrency to balance speed and rate limits
async function embedTexts(texts, taskType) {
  const vectors = new Array(texts.length);
  let next = 0;

  async function worker() {
    while (next < texts.length) {
      const i = next++;
      try {
        vectors[i] = await embedOne(texts[i], taskType);
      } catch (err) {
        console.error('[RAG] Embedding failed for one chunk, skipping:', err.message);
        vectors[i] = null;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(EMBED_CONCURRENCY, texts.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return vectors;
}

// Upsert a set of files into the index (add/update only — never deletes others).
// Safe to call repeatedly with small batches so the vault becomes searchable
// progressively during a long first load. Only new/changed files are re-embedded.
// Files are keyed by Drive id (not name) so duplicate basenames across folders
// (many README.md / CHANGELOG.md) don't collide and evict each other.
async function upsertFiles(files) {
  const changed = files.filter(f => {
    const meta = fileMeta[f.id];
    return !meta || meta.modifiedTime !== f.modifiedTime;
  });
  if (changed.length === 0) return;

  isIndexing = true;
  try {
    // Remove stale chunks for changed files before re-adding
    const changedIds = new Set(changed.map(f => f.id));
    chunks = chunks.filter(c => !changedIds.has(c.id));

    // Build chunk list for changed files
    const pending = [];
    for (const file of changed) {
      for (const text of chunkText(file.content)) {
        pending.push({ id: file.id, fileName: file.name, text });
      }
    }

    if (pending.length > 0) {
      const vectors = await embedTexts(pending.map(p => p.text), 'RETRIEVAL_DOCUMENT');
      for (let i = 0; i < pending.length; i++) {
        if (!vectors[i]) continue; // skip chunks whose embedding failed
        chunks.push({ id: pending[i].id, fileName: pending[i].fileName, text: pending[i].text, embedding: vectors[i] });
      }
    }

    for (const file of changed) {
      fileMeta[file.id] = { modifiedTime: file.modifiedTime, name: file.name };
    }

    lastIndexed = new Date();
    console.log(`[RAG] Indexed ${changed.length} file(s) — now ${chunks.length} chunk(s) across ${Object.keys(fileMeta).length} file(s).`);
  } catch (err) {
    console.error('[RAG] Upsert failed:', err.message);
  } finally {
    isIndexing = false;
  }
}

// Remove chunks/meta for files that are no longer in the vault.
// liveIds = Set or Array of current Drive file ids.
function pruneFiles(liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  chunks = chunks.filter(c => live.has(c.id));
  for (const id of Object.keys(fileMeta)) {
    if (!live.has(id)) delete fileMeta[id];
  }
}

// Return the most relevant chunks for a query, within the char budget
async function retrieve(query) {
  if (chunks.length === 0) return [];
  const [queryVec] = await embedTexts([query], 'RETRIEVAL_QUERY');

  const scored = chunks
    .map(c => ({ fileName: c.fileName, text: c.text, score: cosineSimilarity(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let chars = 0;
  for (const c of scored) {
    if (picked.length >= TOP_K) break;
    if (chars + c.text.length > RETRIEVAL_CHAR_BUDGET) continue;
    picked.push(c);
    chars += c.text.length;
  }
  return picked;
}

function getIndexStatus() {
  return {
    fileCount: Object.keys(fileMeta).length,
    chunkCount: chunks.length,
    lastIndexed,
    isIndexing,
    fileNames: Object.values(fileMeta).map(m => m.name),
  };
}

module.exports = { upsertFiles, pruneFiles, retrieve, getIndexStatus };

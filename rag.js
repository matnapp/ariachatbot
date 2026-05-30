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

// Incrementally (re)index the vault. files = [{ name, content, modifiedTime }]
// Only changed/new files are re-embedded; deleted files are dropped.
async function indexFiles(files) {
  if (isIndexing) {
    console.log('[RAG] Index already in progress, skipping.');
    return;
  }
  isIndexing = true;
  try {
    const incomingNames = new Set(files.map(f => f.name));

    // Drop chunks + meta for files that no longer exist
    chunks = chunks.filter(c => incomingNames.has(c.fileName));
    for (const name of Object.keys(fileMeta)) {
      if (!incomingNames.has(name)) delete fileMeta[name];
    }

    // Which files are new or modified since last index?
    const changed = files.filter(f => {
      const meta = fileMeta[f.name];
      return !meta || meta.modifiedTime !== f.modifiedTime;
    });

    if (changed.length === 0) {
      console.log('[RAG] No file changes — index already current.');
      lastIndexed = new Date();
      return;
    }

    console.log(`[RAG] Re-indexing ${changed.length} new/changed file(s)...`);

    // Remove stale chunks for changed files before re-adding
    const changedNames = new Set(changed.map(f => f.name));
    chunks = chunks.filter(c => !changedNames.has(c.fileName));

    // Build the chunk list for changed files
    const pending = [];
    for (const file of changed) {
      for (const text of chunkText(file.content)) {
        pending.push({ fileName: file.name, text });
      }
    }

    // Embed in batches and attach vectors
    if (pending.length > 0) {
      const vectors = await embedTexts(pending.map(p => p.text), 'RETRIEVAL_DOCUMENT');
      for (let i = 0; i < pending.length; i++) {
        if (!vectors[i]) continue; // skip chunks whose embedding failed
        chunks.push({ fileName: pending[i].fileName, text: pending[i].text, embedding: vectors[i] });
      }
    }

    // Update meta
    for (const file of changed) {
      fileMeta[file.name] = { modifiedTime: file.modifiedTime };
    }

    lastIndexed = new Date();
    console.log(`[RAG] Index updated — ${chunks.length} chunk(s) across ${Object.keys(fileMeta).length} file(s).`);
  } catch (err) {
    console.error('[RAG] Indexing failed:', err.message);
  } finally {
    isIndexing = false;
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
    fileNames: Object.keys(fileMeta),
  };
}

module.exports = { indexFiles, retrieve, getIndexStatus };

require('dotenv').config();
const { google } = require('googleapis');
const { upsertFiles, pruneFiles } = require('./rag');

const API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '3600000', 10);

const drive = google.drive({ version: 'v3', auth: API_KEY });

// Cache file content keyed by Drive fileId so we only re-download what changed
const contentCache = {}; // fileId -> { name, content, modifiedTime }
let lastRefresh = null;
let isRefreshing = false;
let downloadProgress = { done: 0, total: 0, failed: 0 };

// BFS folder traversal — one folder at a time to avoid rate limiting
async function listMarkdownFiles(rootFolderId) {
  const mdFiles = [];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift();
    let pageToken = null;

    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      });

      const files = res.data.files || [];
      pageToken = res.data.nextPageToken || null;

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          queue.push(file.id);
        } else if (file.name.endsWith('.md') || file.mimeType === 'text/plain') {
          mdFiles.push(file);
        }
      }
    } while (pageToken);
  }

  return mdFiles;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isThrottle(err) {
  return /rate|429|403|quota|sorry|automated|503|500|ECONN|socket|timeout/i.test(err.message || '');
}

// Single download attempt. Google sometimes returns a 200 with a
// "We're sorry... automated queries" HTML page instead of an error,
// so we detect that and surface it as a throttle.
async function downloadOnce(file) {
  const res = await drive.files.get(
    { fileId: file.id, alt: 'media' },
    { responseType: 'text' }
  );
  const data = res.data;
  if (typeof data === 'string' &&
      data.includes("We're sorry") &&
      data.includes('automated queries')) {
    throw new Error('Drive rate-limit page returned');
  }
  return data;
}

async function refreshVault() {
  if (isRefreshing) {
    console.log('[Aria] Refresh already in progress, skipping.');
    return;
  }
  isRefreshing = true;
  try {
    console.log('[Aria] Listing vault files from Google Drive...');
    const mdFiles = await listMarkdownFiles(FOLDER_ID);
    console.log(`[Aria] Found ${mdFiles.length} markdown file(s)`);

    if (mdFiles.length === 0) {
      console.warn('[Aria] No markdown files found. Check folder sharing is set to "Anyone with the link".');
      return;
    }

    // Drop chunks + cache entries for files that no longer exist
    const liveIds = new Set(mdFiles.map(f => f.id));
    for (const id of Object.keys(contentCache)) {
      if (!liveIds.has(id)) delete contentCache[id];
    }
    pruneFiles(mdFiles.map(f => f.id));

    // Index anything already cached (instant on warm restarts)
    const cachedFiles = mdFiles.map(f => contentCache[f.id]).filter(Boolean);
    if (cachedFiles.length > 0) await upsertFiles(cachedFiles);

    // Download only new or modified files
    const toDownload = mdFiles.filter(f => {
      const cached = contentCache[f.id];
      return !cached || cached.modifiedTime !== f.modifiedTime;
    });
    console.log(`[Aria] ${toDownload.length} file(s) new or changed since last refresh.`);

    let downloaded = 0;
    let failed = 0;
    downloadProgress = { done: 0, total: toDownload.length, failed: 0 };

    const BATCH = 25;        // index after each batch so the vault is searchable progressively
    const STEADY_PAUSE = 60; // ms between files to soften the request rate
    const COOLDOWN_MS = 60000;
    const MAX_COOLDOWNS = 30;
    let cooldowns = 0;
    let batch = [];

    let i = 0;
    while (i < toDownload.length) {
      const file = toDownload[i];
      try {
        const content = await downloadOnce(file);
        contentCache[file.id] = { id: file.id, name: file.name, content, modifiedTime: file.modifiedTime };
        batch.push(contentCache[file.id]);
        downloaded++;
        i++;
      } catch (err) {
        if (isThrottle(err) && cooldowns < MAX_COOLDOWNS) {
          // Throttled — index what we have, wait once for the quota window to
          // reset, then retry the SAME file (don't advance i)
          cooldowns++;
          console.warn(`[Aria] Drive throttled at ${i}/${toDownload.length}. Cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns})...`);
          if (batch.length > 0) { await upsertFiles(batch); batch = []; }
          await sleep(COOLDOWN_MS);
          continue;
        }
        failed++;
        i++;
        console.error(`[Aria] Giving up on "${file.name}":`, err.message);
      }

      downloadProgress = { done: i, total: toDownload.length, failed };

      // Index each batch as it completes
      if (batch.length >= BATCH) {
        await upsertFiles(batch);
        batch = [];
      }
      await sleep(STEADY_PAUSE);
    }

    // Index the final partial batch
    if (batch.length > 0) await upsertFiles(batch);

    console.log(`[Aria] Downloaded ${downloaded} file(s), ${failed} failed, ${cooldowns} cooldown(s).`);

    lastRefresh = new Date();
    console.log(`[Aria] Refresh complete at ${lastRefresh.toISOString()}`);
  } catch (err) {
    console.error('[Aria] Vault refresh failed:', err.message);
    console.error('[Aria] Keeping last good index.');
  } finally {
    isRefreshing = false;
  }
}

function getVaultStatus() {
  return { lastRefresh, isRefreshing, downloadProgress };
}

function startRefreshInterval() {
  refreshVault();
  setInterval(refreshVault, REFRESH_INTERVAL_MS);
}

module.exports = { getVaultStatus, refreshVault, startRefreshInterval };

require('dotenv').config();
const { google } = require('googleapis');
const { indexFiles } = require('./rag');

const API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '3600000', 10);

const drive = google.drive({ version: 'v3', auth: API_KEY });

// Cache file content keyed by Drive fileId so we only re-download what changed
const contentCache = {}; // fileId -> { name, content, modifiedTime }
let lastRefresh = null;
let isRefreshing = false;

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

    // Drop cache entries for files that no longer exist
    const liveIds = new Set(mdFiles.map(f => f.id));
    for (const id of Object.keys(contentCache)) {
      if (!liveIds.has(id)) delete contentCache[id];
    }

    // Download only new or modified files
    const toDownload = mdFiles.filter(f => {
      const cached = contentCache[f.id];
      return !cached || cached.modifiedTime !== f.modifiedTime;
    });
    console.log(`[Aria] ${toDownload.length} file(s) new or changed since last refresh.`);

    let downloaded = 0;
    for (let i = 0; i < toDownload.length; i++) {
      const file = toDownload[i];
      try {
        const contentRes = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'text' }
        );
        contentCache[file.id] = {
          name: file.name,
          content: contentRes.data,
          modifiedTime: file.modifiedTime,
        };
        downloaded++;
      } catch (err) {
        console.error(`[Aria] Failed to fetch "${file.name}":`, err.message);
      }
      // Brief pause every 10 downloads to respect Drive rate limits
      if ((i + 1) % 10 === 0) {
        await new Promise(r => setTimeout(r, 300));
        console.log(`[Aria] Downloaded ${i + 1}/${toDownload.length}...`);
      }
    }
    console.log(`[Aria] Downloaded ${downloaded} file(s).`);

    // Hand the full current file set to the RAG indexer (it embeds incrementally)
    const files = mdFiles
      .map(f => contentCache[f.id])
      .filter(Boolean);
    await indexFiles(files);

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
  return { lastRefresh, isRefreshing };
}

function startRefreshInterval() {
  refreshVault();
  setInterval(refreshVault, REFRESH_INTERVAL_MS);
}

module.exports = { getVaultStatus, refreshVault, startRefreshInterval };

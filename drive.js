require('dotenv').config();
const { google } = require('googleapis');

const API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '3600000', 10);

const drive = google.drive({ version: 'v3', auth: API_KEY });

let vaultCache = [];
let lastRefresh = null;

// Returns all .md files under folderId, recursing into subfolders in parallel
async function listMarkdownFiles(folderId) {
  const mdFiles = [];
  const subfolderIds = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });

    const files = res.data.files || [];
    pageToken = res.data.nextPageToken || null;

    for (const file of files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        subfolderIds.push(file.id);
      } else if (file.name.endsWith('.md') || file.mimeType === 'text/plain') {
        mdFiles.push(file);
      }
    }
  } while (pageToken);

  // Recurse into all subfolders in parallel
  if (subfolderIds.length > 0) {
    const nested = await Promise.all(subfolderIds.map(id => listMarkdownFiles(id)));
    for (const files of nested) mdFiles.push(...files);
  }

  return mdFiles;
}

async function refreshVault() {
  try {
    console.log('[Aria] Fetching vault from Google Drive...');

    const mdFiles = await listMarkdownFiles(FOLDER_ID);
    console.log(`[Aria] Found ${mdFiles.length} markdown file(s)`);

    if (mdFiles.length === 0) {
      console.warn('[Aria] No markdown files found. Check folder sharing is set to "Anyone with the link".');
      return;
    }

    // Fetch sequentially with a small delay to avoid triggering Google's rate limits
    const fetched = [];
    for (let i = 0; i < mdFiles.length; i++) {
      const file = mdFiles[i];
      try {
        const contentRes = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'text' }
        );
        fetched.push({ name: file.name, content: contentRes.data });
      } catch (err) {
        console.error(`[Aria] Failed to fetch "${file.name}":`, err.message);
      }
      // Brief pause every 10 files to stay within Drive API rate limits
      if ((i + 1) % 10 === 0) {
        await new Promise(r => setTimeout(r, 300));
        console.log(`[Aria] Progress: ${i + 1}/${mdFiles.length} files loaded...`);
      }
    }

    if (fetched.length > 0) {
      vaultCache = fetched;
      lastRefresh = new Date();
      console.log(`[Aria] Vault loaded — ${fetched.length} file(s) cached at ${lastRefresh.toISOString()}`);
    } else {
      console.warn('[Aria] All file fetches failed. Keeping last cache.');
    }
  } catch (err) {
    console.error('[Aria] Vault refresh failed:', err.message);
    console.error('[Aria] Keeping last good cache.');
  }
}

function getVaultContent() {
  return vaultCache;
}

function startRefreshInterval() {
  refreshVault();
  setInterval(refreshVault, REFRESH_INTERVAL_MS);
}

module.exports = { getVaultContent, refreshVault, startRefreshInterval };

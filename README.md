# Aria — Ghost Noise Staff Assistant

Aria is the internal AI assistant for Ghost Noise, a music community, creative studio, and event space based in Dalton, Georgia. She reads from an Obsidian knowledge vault stored in a shared Google Drive folder and answers staff questions based on that content — no logins, no databases, no external user tracking. Just open the URL and ask.

---

## Local Development

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd aria

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Open .env and fill in all four values (see sections below)

# 4. Start the server
npm start
# → Aria is now running at http://localhost:3000
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (console.anthropic.com) |
| `GOOGLE_DRIVE_API_KEY` | Google Cloud API key with Drive API enabled |
| `GOOGLE_DRIVE_FOLDER_ID` | The ID of the shared Drive folder containing your vault |
| `PORT` | Port to run the server on (default: 3000) |
| `REFRESH_INTERVAL_MS` | How often to re-fetch the vault in ms (default: 3600000 = 1 hour) |

---

## Getting a Google Drive API Key and Folder ID

### API Key

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**, search for **Google Drive API**, and enable it
4. Go to **APIs & Services → Credentials**
5. Click **Create Credentials → API key**
6. Copy the key — paste it into `.env` as `GOOGLE_DRIVE_API_KEY`
7. Optional but recommended: click **Restrict key**, limit it to the Drive API, and restrict by IP or HTTP referrer if you know your deployment IP

### Folder ID

1. Open the Google Drive folder that contains your Obsidian vault `.md` files
2. Look at the URL: `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv`
3. The long string at the end (`1AbCdEfGhIjKlMnOpQrStUv`) is your Folder ID
4. Paste it into `.env` as `GOOGLE_DRIVE_FOLDER_ID`
5. Make sure the folder's sharing is set to **"Anyone with the link can view"** — this lets the API key work without OAuth

---

## Deploying to Railway

1. Push your code to a GitHub repo
2. Go to [railway.app](https://railway.app) and create a new project from your GitHub repo
3. In the Railway project settings, add all environment variables from `.env`:
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_DRIVE_API_KEY`
   - `GOOGLE_DRIVE_FOLDER_ID`
   - `REFRESH_INTERVAL_MS` (optional, defaults to 3600000)
4. Railway will auto-detect the `Procfile` and run `node server.js`
5. Once deployed, Railway gives you a `.railway.app` URL — test it before pointing your domain

See [Railway docs](https://docs.railway.app) for more details.

---

## Pointing aria.ghostnoise.co at Railway

1. In your Railway project, go to **Settings → Networking → Custom Domain**
2. Add `aria.ghostnoise.co` — Railway will show you a CNAME target (something like `<your-app>.up.railway.app`)
3. Log in to Hostinger and go to **Domains → Manage → DNS / Nameservers**
4. Add a CNAME record:
   - **Host:** `aria`
   - **Points to:** the Railway CNAME value from step 2
   - **TTL:** 3600 (or lowest available)
5. Save and wait up to 30 minutes for DNS propagation
6. Railway handles HTTPS automatically once the CNAME resolves

---

## Manually Refreshing the Vault

By default, Aria re-fetches the vault from Google Drive every hour. To force an immediate refresh after updating the vault, hit the refresh endpoint:

```bash
curl -X POST https://aria.ghostnoise.co/api/refresh
```

Response:
```json
{ "success": true, "fileCount": 12 }
```

You can also call this from a script or a button in any internal tool.

---

## Updating Aria's Personality or Knowledge Boundaries

Open `context.js`. The `buildSystemPrompt()` function builds the full system prompt that Aria receives before every conversation. The intro paragraph at the top defines her identity, tone, and instructions. Edit it to:

- Change her name or description
- Adjust her tone (currently: warm, direct, community-first, creative, no-nonsense)
- Tighten or loosen what she's allowed to answer
- Add standing instructions (e.g., "always recommend contacting Mat for booking questions")

The vault content is appended automatically after the intro — you don't need to touch anything else.

---

## How It Works

```
Browser → POST /api/chat (full message history)
  → server.js fetches vault from in-memory cache
  → context.js builds system prompt with all vault files
  → Anthropic API (claude-sonnet-4-5) streams response
  → SSE chunks flow back to browser in real time
  → Frontend renders markdown and appends to chat
```

Vault refresh: `drive.js` fetches all `.md` files from the shared Google Drive folder on startup and every `REFRESH_INTERVAL_MS` milliseconds. If a refresh fails, the last good cache is kept.

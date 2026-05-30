require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getVaultContent, getVaultStatus, refreshVault, startRefreshInterval } = require('./drive');
const { buildSystemPrompt } = require('./context');

const app = express();
const PORT = process.env.PORT || 3000;
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const vaultFiles = getVaultContent();
  const systemPrompt = buildSystemPrompt(vaultFiles);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Convert Anthropic-format history to Gemini format
    // Gemini uses 'model' instead of 'assistant', and parts[] instead of content string
    const geminiHistory = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const latestMessage = messages[messages.length - 1].content;

    const model = genai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(latestMessage);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[Aria] Chat error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.post('/api/refresh', (req, res) => {
  // Fire and forget — don't wait for the full load (can take minutes for large vaults)
  refreshVault().catch(err => console.error('[Aria] Manual refresh error:', err.message));
  res.json({ success: true, message: 'Vault refresh started in background. Check /api/status for progress.' });
});

app.get('/api/status', (req, res) => {
  const files = getVaultContent();
  const status = getVaultStatus();
  const totalChars = files.reduce((sum, f) => sum + (f.content ? f.content.length : 0), 0);
  const CONTEXT_CAP = 2500000;
  res.json({
    fileCount: files.length,
    totalChars,
    contextCapChars: CONTEXT_CAP,
    fitsInContext: totalChars <= CONTEXT_CAP,
    lastRefresh: status.lastRefresh,
    isRefreshing: status.isRefreshing,
    fileNames: files.map(f => f.name),
  });
});

app.listen(PORT, () => {
  console.log(`[Aria] Server running on port ${PORT}`);
  startRefreshInterval();
});

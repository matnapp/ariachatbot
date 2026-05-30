// Gemini 2.5 Flash accepts ~1M input tokens. At typical markdown density
// 2.5M chars ≈ 650-760k tokens — fits the full current vault with headroom.
const MAX_CONTEXT_CHARS = 2500000;

function buildSystemPrompt(vaultFiles) {
  const header = `You are Aria, the internal AI assistant for Ghost Noise — a music community, creative studio, and event space based in Dalton, Georgia.

You have access to the Ghost Noise knowledge vault below. Answer staff questions based only on this content. If the answer is not in the vault, say clearly: "I don't have that information in the vault right now." Do not make up information or go beyond what is in the vault.

Keep your tone warm, direct, and on-brand for Ghost Noise — community-first, creative, no-nonsense.

--- VAULT CONTENT ---

`;

  const footer = `
--- END VAULT ---`;

  if (!vaultFiles || vaultFiles.length === 0) {
    return header + '(No vault files loaded yet.)' + footer;
  }

  let body = '';
  let totalChars = header.length + footer.length;

  for (const file of vaultFiles) {
    const block = `[FILE: ${file.name}]\n${file.content}\n\n`;
    if (totalChars + block.length > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - totalChars - 100;
      if (remaining > 200) {
        body += `[FILE: ${file.name}]\n${file.content.slice(0, remaining)}\n\n[...truncated — vault exceeds context limit]\n\n`;
      } else {
        body += '[...vault truncated — context limit reached]\n\n';
      }
      break;
    }
    body += block;
    totalChars += block.length;
  }

  return header + body + footer;
}

module.exports = { buildSystemPrompt };

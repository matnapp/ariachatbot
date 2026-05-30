// Builds Aria's system prompt from the chunks retrieved for the current question.
// retrieved = [{ fileName, text, score }]
function buildSystemPrompt(retrieved) {
  const header = `You are Aria, the internal AI assistant for Ghost Noise — a music community, creative studio, and event space based in Dalton, Georgia.

You have access to relevant excerpts from the Ghost Noise knowledge vault below, retrieved for the current question. Answer staff questions based only on this content. If the answer is not in the excerpts, say clearly: "I don't have that information in the vault right now." Do not make up information or go beyond what is provided.

Keep your tone warm, direct, and on-brand for Ghost Noise — community-first, creative, no-nonsense.

--- RELEVANT VAULT EXCERPTS ---

`;

  const footer = `
--- END EXCERPTS ---`;

  if (!retrieved || retrieved.length === 0) {
    return header + '(No relevant excerpts were found in the vault for this question.)' + footer;
  }

  // Group excerpts by source file for readability
  const byFile = new Map();
  for (const c of retrieved) {
    if (!byFile.has(c.fileName)) byFile.set(c.fileName, []);
    byFile.get(c.fileName).push(c.text);
  }

  let body = '';
  for (const [fileName, texts] of byFile) {
    body += `[FILE: ${fileName}]\n${texts.join('\n...\n')}\n\n`;
  }

  return header + body + footer;
}

module.exports = { buildSystemPrompt };

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 10_000;
const ALLOWED_ROLES = new Set(['user', 'assistant', 'model']);

function textFromMessage(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.parts)) return '';
  return message.parts.map(part => typeof part?.text === 'string' ? part.text : '').join('');
}

export function normalizeChatRequest(message, history) {
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
    throw new TypeError('Invalid chat message');
  }
  if (history != null && !Array.isArray(history)) throw new TypeError('Invalid chat history');
  const normalized = [];
  for (const item of (history || []).slice(-MAX_HISTORY_MESSAGES)) {
    if (!item || !ALLOWED_ROLES.has(item.role)) throw new TypeError('Invalid chat history role');
    const content = textFromMessage(item);
    if (!content || content.length > MAX_MESSAGE_CHARS) throw new TypeError('Invalid chat history content');
    normalized.push({ role: item.role === 'model' ? 'assistant' : item.role, content });
  }
  return { message: message.trim(), history: normalized };
}

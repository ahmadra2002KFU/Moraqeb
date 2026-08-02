const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

function partialTagSuffixLength(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

class ThinkingFilter {
  constructor() {
    this.buffer = '';
    this.insideThink = false;
  }

  push(text) {
    this.buffer += text || '';
    let visible = '';

    while (this.buffer) {
      const tag = this.insideThink ? CLOSE_TAG : OPEN_TAG;
      const index = this.buffer.indexOf(tag);
      if (index !== -1) {
        if (!this.insideThink) visible += this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + tag.length);
        this.insideThink = !this.insideThink;
        continue;
      }

      const keep = partialTagSuffixLength(this.buffer, tag);
      if (!this.insideThink) {
        visible += keep ? this.buffer.slice(0, -keep) : this.buffer;
      }
      this.buffer = keep ? this.buffer.slice(-keep) : '';
      break;
    }

    return visible;
  }

  flush() {
    const visible = this.insideThink ? '' : this.buffer;
    this.buffer = '';
    this.insideThink = false;
    return visible;
  }
}

/**
 * Parse and relay an OpenAI-compatible SSE response body.
 * Reasoning fields and <think> blocks are never forwarded.
 */
export async function relayOpenAIStream(body, { onText } = {}) {
  if (!body?.getReader) throw new Error('LLM stream body is unavailable');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const thinking = new ThinkingFilter();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  const processLine = line => {
    const normalized = line.trimEnd();
    if (!normalized.startsWith('data:')) return;
    const payload = normalized.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    try {
      const parsed = JSON.parse(payload);
      const text = parsed.choices?.[0]?.delta?.content || '';
      if (text) {
        const visible = thinking.push(text);
        if (visible) onText?.(visible);
      }
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens || inputTokens;
        outputTokens = parsed.usage.completion_tokens || outputTokens;
      }
    } catch {
      // Ignore malformed upstream events while keeping the stream alive.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    const finalText = thinking.flush();
    if (finalText) onText?.(finalText);
  } finally {
    reader.releaseLock();
  }

  return { inputTokens, outputTokens };
}

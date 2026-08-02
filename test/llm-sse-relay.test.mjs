import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { relayOpenAIStream } from '../lib/llm/sse-relay.mjs';

function fragmentedStream(text, cuts) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let start = 0;
  const chunks = [];
  for (const end of cuts) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  chunks.push(bytes.slice(start));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('relayOpenAIStream', () => {
  it('handles fragmented SSE frames, split think tags, and usage', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Visible "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>secret</thi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>answer"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const output = [];
    const usage = await relayOpenAIStream(
      fragmentedStream(sse, [7, 19, 57, 103, 161, 205]),
      { onText: text => output.push(text) },
    );

    assert.equal(output.join(''), 'Visible answer');
    assert.deepEqual(usage, { inputTokens: 11, outputTokens: 7 });
  });

  it('ignores provider reasoning_content and malformed events', async () => {
    const sse = [
      'data: not-json\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"private","content":"OK"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const output = [];
    const usage = await relayOpenAIStream(fragmentedStream(sse, [3, 29]), {
      onText: text => output.push(text),
    });

    assert.equal(output.join(''), 'OK');
    assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0 });
  });
});

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createLLMProvider, OmniRouteProvider } from '../lib/llm/index.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OmniRouteProvider', () => {
  it('uses the configured model, base URL, and low reasoning effort', async () => {
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = mock.fn(async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify({
        model: 'gpt-5.6-luna',
        choices: [{ message: { content: 'MORAQEB_OK' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = new OmniRouteProvider({
      apiKey: 'test-key',
      model: 'cx/gpt-5.6-luna',
      baseUrl: 'http://host.docker.internal:20128/v1/',
      reasoningEffort: 'low',
    });
    const result = await provider.complete('System', 'User', { maxTokens: 64 });

    assert.equal(capturedUrl, 'http://host.docker.internal:20128/v1/chat/completions');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'cx/gpt-5.6-luna');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.max_completion_tokens, 64);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User' },
    ]);
    assert.equal(result.text, 'MORAQEB_OK');
    assert.equal(result.model, 'gpt-5.6-luna');
  });

  it('streams arbitrary chat history with the same reasoning setting', async () => {
    globalThis.fetch = mock.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      assert.equal(body.reasoning_effort, 'low');
      assert.deepEqual(body.messages, [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Question' },
      ]);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const provider = new OmniRouteProvider({
      apiKey: 'test-key',
      model: 'cx/gpt-5.6-luna',
      baseUrl: 'http://localhost:20128/v1',
      reasoningEffort: 'low',
    });
    const response = await provider.streamMessages([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
    ]);

    assert.equal(response.status, 200);
  });

  it('is available through the provider factory', () => {
    const provider = createLLMProvider({
      provider: 'omniroute',
      apiKey: 'test-key',
      model: 'cx/gpt-5.6-luna',
      baseUrl: 'http://localhost:20128/v1',
      reasoningEffort: 'low',
    });

    assert.ok(provider instanceof OmniRouteProvider);
    assert.equal(provider.name, 'omniroute');
    assert.equal(provider.model, 'cx/gpt-5.6-luna');
    assert.equal(provider.reasoningEffort, 'low');
  });
});

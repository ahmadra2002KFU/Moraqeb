import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLLMConfig } from '../lib/llm/config.mjs';

describe('resolveLLMConfig', () => {
  it('defaults a fresh installation to OmniRoute Luna with low reasoning', () => {
    assert.deepEqual(resolveLLMConfig({}), {
      provider: 'omniroute',
      apiKey: 'local-moraqeb',
      model: 'cx/gpt-5.6-luna',
      baseUrl: 'http://localhost:20128/v1',
      reasoningEffort: 'low',
    });
  });

  it('allows the default provider to be explicitly disabled', () => {
    assert.deepEqual(resolveLLMConfig({ LLM_PROVIDER: 'disabled' }), {
      provider: null,
      apiKey: null,
      model: null,
      baseUrl: null,
      reasoningEffort: null,
    });
  });

  it('does not leak OmniRoute credentials or URL into OpenAI', () => {
    const config = resolveLLMConfig({
      LLM_PROVIDER: 'openai',
      OMNIROUTE_API_KEY: 'omni-secret',
      OMNIROUTE_BASE_URL: 'http://omniroute.invalid/v1',
    });
    assert.equal(config.provider, 'openai');
    assert.equal(config.apiKey, null);
    assert.equal(config.baseUrl, null);
  });

  it('keeps provider-specific URLs isolated', () => {
    const config = resolveLLMConfig({
      LLM_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OMNIROUTE_BASE_URL: 'http://omniroute:20128/v1',
    });
    assert.equal(config.baseUrl, 'http://ollama:11434');
  });

  it('preserves a legacy MiniMax-only installation', () => {
    const config = resolveLLMConfig({ MINIMAX_API_KEY: 'legacy-minimax-key' });
    assert.equal(config.provider, 'minimax');
    assert.equal(config.apiKey, 'legacy-minimax-key');
    assert.equal(config.model, 'MiniMax-M2.7');
    assert.equal(config.baseUrl, null);
  });

  it('uses only the generic key for providers without a dedicated fallback', () => {
    const config = resolveLLMConfig({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'openai-key',
      MINIMAX_API_KEY: 'minimax-key',
      OMNIROUTE_API_KEY: 'omni-key',
    });
    assert.equal(config.apiKey, 'openai-key');
  });
});

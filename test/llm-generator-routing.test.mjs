import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateSITREP } from '../lib/blog/generator.mjs';
import { generatePost } from '../lib/posts/generator.mjs';

function mockProvider() {
  const calls = [];
  return {
    name: 'mock',
    model: 'mock-model',
    isConfigured: true,
    calls,
    async complete(systemPrompt, userMessage, opts) {
      calls.push({ systemPrompt, userMessage, opts });
      const id = `${systemPrompt}\n${userMessage}`.match(/\[(E\d+)\]/)?.[1] || 'E999';
      const arabic = systemPrompt.trim().startsWith('أنت') || systemPrompt.includes('in Arabic (العربية)') || systemPrompt.includes('باللغة العربية');
      return {
        text: arabic
          ? `# استخبارات مولدة\n\n[OBSERVED] محتوى استخباراتي موثق ومولد عبر المزود المحدد [${id}].`
          : `# Generated Intelligence\n\n[OBSERVED] Verified provider-routed content [${id}].`,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'mock-model',
      };
    },
  };
}

const fixture = {
  meta: {
    timestamp: '2026-08-02T00:00:00.000Z',
    sourcesOk: 1,
    sourcesQueried: 1,
  },
  news: [{
    title: 'Verified provider-routed content', source: 'Test Wire',
    url: 'https://example.com/evidence', date: '2026-08-02T00:00:00.000Z',
  }],
};

describe('configured-provider generators', () => {
  it('routes bilingual post generation through the configured provider', async () => {
    const provider = mockProvider();
    const result = await generatePost(provider, fixture, null, [], null);

    assert.equal(provider.calls.length, 2);
    assert.equal(result.post.en.title, 'Generated Intelligence');
    assert.equal(result.post.ar.title, 'استخبارات مولدة');
    assert.deepEqual(result.tokenUsage.post, { inputTokens: 20, outputTokens: 10 });
    assert.equal(result.post.en.evidence[0].url, 'https://example.com/evidence');
  });

  it('routes SITREP and summary generation through the configured provider', async () => {
    const provider = mockProvider();
    const result = await generateSITREP(provider, fixture, null, null);

    assert.equal(provider.calls.length, 4);
    assert.equal(result.sitrep.en.title, 'Generated Intelligence');
    assert.equal(result.sitrep.ar.title, 'استخبارات مولدة');
    assert.match(result.sitrep.en.summary, /Verified provider-routed content/);
    assert.match(result.sitrep.ar.summary, /محتوى استخباراتي/);
    assert.equal(result.sitrep.en.evidence[0].url, 'https://example.com/evidence');
  });
});

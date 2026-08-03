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
      const blog = systemPrompt.includes('## Decision Board') || systemPrompt.includes('canonical SITREP');
      const binding = systemPrompt.match(/<!--MORAQEB_BIND_[A-P]+-->/)?.[0] || '';
      const text = blog
        ? (arabic
          ? `# استخبارات مولدة\n\n## التقييم التنفيذي\n[OBSERVED] محتوى استخباراتي موثق ومولد عبر المزود المحدد [${id}].\n[INFERENCE] يتطلب هذا التطور مراقبة مستمرة.\n\n## التطورات الرئيسية\n### حدث موثق\n[OBSERVED] محتوى استخباراتي موثق ومولد عبر المزود المحدد [${id}].\n[INFERENCE] قد يؤثر ذلك في القرارات القريبة.\n\n## لوحة القرار\n- [INFERENCE] راقب التطور خلال أربع وعشرين ساعة.\n\n## قائمة المراقبة\n- [INFERENCE] تحقق من مصدر مستقل.\n\n## حدود الأدلة\n- [INFERENCE] لا يتوفر تأكيد مستقل بعد.`
          : `# Generated Intelligence\n\n## Executive Assessment\n[OBSERVED] Verified provider-routed content [${id}].\n[INFERENCE] This development warrants continued monitoring.\n\n## Key Developments\n### Verified event\n[OBSERVED] Verified provider-routed content [${id}].\n[INFERENCE] It may affect near-term decisions.\n\n## Decision Board\n- [INFERENCE] Monitor the development over the next day.\n\n## Watchlist\n- [INFERENCE] Seek independent source confirmation.\n\n## Evidence Limits\n- [INFERENCE] Independent confirmation is not yet available.`)
        : (arabic
          ? `# استخبارات مولدة\n\n[OBSERVED] محتوى استخباراتي موثق ومولد عبر المزود المحدد [${id}].`
          : `# Generated Intelligence\n\n[OBSERVED] Verified provider-routed content [${id}].`);
      return {
        text: arabic && binding ? `${text}\n${binding}` : text,
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
    assert.equal(result.post.ar.title, 'تحديث استخباراتي');
    assert.deepEqual(result.tokenUsage.post, { inputTokens: 20, outputTokens: 10 });
    assert.equal(result.post.en.evidence[0].url, 'https://example.com/evidence');
  });

  it('routes concise canonical SITREP generation and translation through the configured provider', async () => {
    const provider = mockProvider();
    const result = await generateSITREP(provider, fixture, null, null);

    assert.equal(provider.calls.length, 2);
    assert.equal(result.sitrep.en.title, 'Generated Intelligence');
    assert.equal(result.sitrep.ar.title, 'إحاطة استخباراتية');
    assert.match(result.sitrep.en.summary, /Verified provider-routed content/);
    assert.match(result.sitrep.ar.summary, /بحسب النسخة المرجعية الإنجليزية/);
    assert.equal(result.sitrep.en.evidence[0].url, 'https://example.com/evidence');
  });
});

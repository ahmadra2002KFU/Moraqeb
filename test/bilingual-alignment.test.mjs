import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generatePost } from '../lib/posts/generator.mjs';
import { generateSITREP } from '../lib/blog/generator.mjs';

const fixture = {
  meta: { timestamp: '2026-08-02T00:00:00.000Z', sourcesOk: 1, sourcesQueried: 1 },
  news: [{ title: 'Verified event', source: 'Test Wire', url: 'https://example.com/evidence', date: '2026-08-02T00:00:00.000Z' }],
};

function driftingProvider() {
  let calls = 0;
  return {
    name: 'mock', model: 'mock',
    async complete(systemPrompt) {
      calls += 1;
      const id = systemPrompt.match(/\[(E\d+)\]/)?.[1] || 'E999';
      const binding = systemPrompt.match(/<!--MORAQEB_BIND_[A-P]+-->/)?.[0] || '';
      const blog = systemPrompt.includes('canonical SITREP') || systemPrompt.includes('## Decision Board') || systemPrompt.includes('CANONICAL ENGLISH SITREP');
      const english = blog
        ? `# Verified event\n\n## Executive Assessment\n[OBSERVED] Verified event [${id}].\n[INFERENCE] This may affect decisions.\n\n## Key Developments\n[OBSERVED] Verified event [${id}].\n\n## Decision Board\n- [INFERENCE] Monitor the event.\n\n## Watchlist\n- [INFERENCE] Seek confirmation.\n\n## Evidence Limits\n- [INFERENCE] Verification remains incomplete.`
        : `# Verified event\n\n[OBSERVED] Verified event [${id}].`;
      const arabic = blog
        ? `# حدث موثق\n\n## التقييم التنفيذي\n[OBSERVED] حدث مختلف من دون الاستشهاد المطلوب.\n[INFERENCE] قد يؤثر ذلك في القرارات.\n\n## التطورات الرئيسية\n[OBSERVED] حدث مختلف من دون الاستشهاد المطلوب.\n\n## لوحة القرار\n- [INFERENCE] راقب الحدث.\n\n## قائمة المراقبة\n- [INFERENCE] تحقق من مصدر مستقل.\n\n## حدود الأدلة\n- [INFERENCE] لا يزال التحقق غير مكتمل.\n${binding}`
        : `# حدث موثق\n\n[OBSERVED] حدث موثق لكن من دون الاستشهاد المطلوب.\n${binding}`;
      return {
        text: calls === 1 ? english : arabic,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe('bilingual generation alignment', () => {
  it('replaces Arabic observed claims with the canonical evidence-bound claim', async () => {
    const result = await generatePost(driftingProvider(), fixture, null);
    assert.match(result.post.ar.content, /Verified event \[E\d+\]/);
    assert.doesNotMatch(result.post.ar.content, /من دون الاستشهاد/);
  });

  it('replaces Arabic SITREP observed claims with the canonical evidence-bound claim', async () => {
    const result = await generateSITREP(driftingProvider(), fixture, null);
    assert.match(result.sitrep.ar.content, /Verified event \[E\d+\]/);
    assert.doesNotMatch(result.sitrep.ar.content, /من دون الاستشهاد/);
  });

  it('rejects an uncited canonical post instead of publishing it', async () => {
    let calls = 0;
    const provider = {
      name: 'mock', model: 'mock',
      async complete(systemPrompt) {
        calls += 1;
        const binding = systemPrompt.match(/<!--MORAQEB_BIND_[A-P]+-->/)?.[0] || '';
        return {
          text: calls === 1
            ? '# Security update\n\n[OBSERVED] A material security event occurred.'
            : `# تحديث أمني\n\n[OBSERVED] وقع حدث أمني جوهري.\n${binding}`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await assert.rejects(generatePost(provider, fixture, null), /Canonical post citation validation failed/);
  });
});

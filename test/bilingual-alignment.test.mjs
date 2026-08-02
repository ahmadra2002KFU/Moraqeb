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
      return {
        text: calls === 1
          ? `# Verified event\n\n[OBSERVED] Verified event [${id}].`
          : '# حدث موثق\n\n[OBSERVED] حدث موثق لكن من دون الاستشهاد المطلوب.',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe('bilingual generation alignment', () => {
  it('rejects an Arabic post that drops canonical evidence IDs', async () => {
    await assert.rejects(generatePost(driftingProvider(), fixture, null), /Bilingual post generation failed validation/);
  });

  it('rejects an Arabic SITREP that drops canonical evidence IDs', async () => {
    await assert.rejects(generateSITREP(driftingProvider(), fixture, null), /Arabic SITREP alignment validation failed/);
  });

  it('rejects an uncited canonical post instead of publishing it', async () => {
    let calls = 0;
    const provider = {
      name: 'mock', model: 'mock',
      async complete() {
        calls += 1;
        return {
          text: calls === 1
            ? '# Security update\n\n[OBSERVED] A material security event occurred.'
            : '# تحديث أمني\n\n[OBSERVED] وقع حدث أمني جوهري.',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await assert.rejects(generatePost(provider, fixture, null), /Canonical post citation validation failed/);
  });
});

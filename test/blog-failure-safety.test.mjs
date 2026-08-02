import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSITREP } from '../lib/blog/generator.mjs';

const fixture = { meta: { timestamp: '2026-08-02T12:00:00Z' }, news: [{ title: 'Event', source: 'Wire', url: 'https://example.com/e', date: '2026-08-02T11:00:00Z' }] };

describe('SITREP failure safety', () => {
  it('rejects provider failures without publishing upstream error bodies', async () => {
    const provider = { name: 'mock', model: 'mock', async complete() { throw new Error('401 upstream-secret-body token=abc123'); } };
    await assert.rejects(generateSITREP(provider, fixture, null), error => {
      assert.equal(String(error).includes('upstream-secret-body'), false);
      assert.match(error.message, /SITREP generation failed/);
      return true;
    });
  });
});

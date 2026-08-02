import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../apis/briefing.mjs';

describe('source-run health semantics', () => {
  it('does not count a structured no-credentials response as usable', async () => {
    const result = await runSource('ACLED', async () => ({ status: 'no_credentials', totalEvents: 0 }));
    assert.equal(result.status, 'degraded');
    assert.equal(result.usable, false);
    assert.equal(result.returned, true);
  });

  it('distinguishes a usable response from merely returning', async () => {
    const result = await runSource('Test', async () => ({ timestamp: '2026-08-02T12:00:00Z', items: [] }));
    assert.equal(result.status, 'usable');
    assert.equal(result.usable, true);
  });
});

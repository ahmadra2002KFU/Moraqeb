import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvidenceFreshness } from '../lib/evidence/index.mjs';

describe('source-specific evidence freshness', () => {
  const collectedAt = '2026-08-02T12:00:00Z';

  it('expires social reports quickly', () => {
    const result = classifyEvidenceFreshness({ type: 'social', timestamp: '2026-08-02T04:00:00Z' }, collectedAt);
    assert.equal(result.stale, true);
    assert.equal(result.freshness, 'stale');
  });

  it('allows a Friday market close through a weekend without pretending it was collected Sunday', () => {
    const result = classifyEvidenceFreshness({ type: 'market', timestamp: '2026-07-31T20:00:00Z' }, collectedAt);
    assert.equal(result.stale, false);
    assert.equal(result.freshness, 'fresh');
  });

  it('marks missing observation time as unknown', () => {
    const result = classifyEvidenceFreshness({ type: 'air', timestamp: null }, collectedAt);
    assert.equal(result.freshness, 'unknown');
    assert.equal(result.ageMs, null);
  });

  it('ages FIRMS after six hours and expires it after 24 hours', () => {
    const aging = classifyEvidenceFreshness({ type: 'thermal_unique', timestamp: '2026-08-02T05:00:00Z' }, collectedAt);
    const stale = classifyEvidenceFreshness({ type: 'thermal_unique', timestamp: '2026-08-01T10:00:00Z' }, collectedAt);
    assert.equal(aging.freshness, 'aging');
    assert.equal(aging.stale, false);
    assert.equal(stale.freshness, 'stale');
  });

  it('rejects observation times more than five minutes in the future', () => {
    const result = classifyEvidenceFreshness({ type: 'air', timestamp: '2026-08-02T12:06:00Z' }, collectedAt);
    assert.equal(result.invalidFuture, true);
    assert.equal(result.stale, true);
  });
});

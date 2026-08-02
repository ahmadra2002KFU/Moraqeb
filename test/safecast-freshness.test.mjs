import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessMeasurementFreshness } from '../apis/sources/safecast.mjs';

describe('Safecast freshness', () => {
  it('does not classify an elevated stale reading as a current anomaly', () => {
    const result = assessMeasurementFreshness(150, '2023-07-18T12:46:47Z', new Date('2026-08-02T12:00:00Z'));
    assert.equal(result.stale, true);
    assert.equal(result.anomaly, false);
  });

  it('allows a fresh elevated reading to become an anomaly', () => {
    const result = assessMeasurementFreshness(150, '2026-08-02T10:00:00Z', new Date('2026-08-02T12:00:00Z'));
    assert.equal(result.stale, false);
    assert.equal(result.anomaly, true);
  });
});

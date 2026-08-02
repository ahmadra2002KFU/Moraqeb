import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta, contentHash } from '../lib/delta/engine.mjs';

const base = { meta: { timestamp: '2026-08-02T11:45:00Z' }, tg: { urgent: [] }, thermal: [], air: [], who: [], fred: [], health: [] };

describe('delta correctness', () => {
  it('deduplicates identical urgent posts within one sweep', () => {
    const post = { text: 'Breaking duplicate signal 123 at 12:30', date: '2026-08-02T12:00:00Z' };
    const delta = computeDelta({ ...base, meta: { timestamp: '2026-08-02T12:00:00Z' }, tg: { urgent: [post, { ...post }] } }, base);
    assert.equal(delta.signals.new.length, 1);
    assert.equal(delta.summary.criticalChanges, 1);
    assert.ok(delta.summary.criticalChanges <= delta.summary.totalChanges);
  });

  it('uses persisted hashes despite compacted display text', () => {
    const text = 'A long recurring intelligence report whose meaningful normalized content extends well beyond eighty characters and must remain stable';
    const previous = { ...base, tg: { urgent: [{ text: text.slice(0, 80), hash: contentHash(text) }] } };
    const current = { ...base, meta: { timestamp: '2026-08-02T12:00:00Z' }, tg: { urgent: [{ text }] } };
    assert.equal(computeDelta(current, previous).signals.new.length, 0);
  });
});

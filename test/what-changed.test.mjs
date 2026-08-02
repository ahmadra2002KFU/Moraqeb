import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWhatChanged } from '../lib/delta/briefing.mjs';

const data = {
  meta: { timestamp: '2026-08-02T12:00:00.000Z', sourcesOk: 27, sourcesQueried: 29 },
  news: [{ title: 'New event', source: 'Wire', url: 'https://example.com/event', date: '2026-08-02T11:59:00Z' }],
};
const delta = {
  timestamp: '2026-08-02T12:00:00.000Z',
  previous: '2026-08-02T11:45:00.000Z',
  summary: { totalChanges: 3, criticalChanges: 1, direction: 'risk-off', signalBreakdown: { new: 1, escalated: 1, deescalated: 1, unchanged: 4 } },
  signals: {
    new: [{ key: 'tg_urgent:1', reason: 'New event', severity: 'critical', item: { text: 'New event', url: 'https://example.com/event' } }],
    escalated: [{ key: 'wti', label: 'WTI Crude', from: 80, to: 85, pctChange: 6.25, severity: 'high' }],
    deescalated: [{ key: 'vix', label: 'VIX', from: 20, to: 17, pctChange: -15, severity: 'moderate' }],
    unchanged: ['sources_ok'],
  },
};

describe('buildWhatChanged', () => {
  it('returns a prioritized, evidence-linked delta briefing', () => {
    const result = buildWhatChanged(data, delta);
    assert.equal(result.direction, 'risk-off');
    assert.equal(result.topChanges[0].severity, 'critical');
    assert.equal(result.new[0].evidence[0].url, 'https://example.com/event');
    assert.equal(result.counts.total, 3);
    assert.match(result.summary, /3 material changes/i);
  });

  it('returns an explicit no-change state', () => {
    const result = buildWhatChanged(data, null);
    assert.equal(result.hasChanges, false);
    assert.match(result.summary, /baseline|no prior/i);
  });

  it('maps a Telegram change only to its matching social record', () => {
    const current = {
      meta: data.meta,
      tg: { urgent: [
        { channel: 'A', text: 'UNRELATED FIRST signal', date: '2026-08-02T11:55:00Z' },
        { channel: 'B', text: 'TARGET SECOND signal', date: '2026-08-02T11:56:00Z' },
      ] },
    };
    const d = { ...delta, signals: { new: [{ key: 'tg_urgent:target', text: 'TARGET SECOND signal', severity: 'critical' }], escalated: [], deescalated: [], unchanged: [] } };
    const result = buildWhatChanged(current, d);
    assert.equal(result.new[0].evidence.length, 1);
    assert.match(result.new[0].evidence[0].observation, /TARGET SECOND/);
    assert.doesNotMatch(result.new[0].evidence[0].observation, /UNRELATED/);
  });
});

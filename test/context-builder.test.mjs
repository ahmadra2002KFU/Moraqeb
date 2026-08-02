import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIntelligenceContext } from '../lib/context/builder.mjs';

const data = {
  meta: { timestamp: '2026-08-02T12:00:00Z', sourcesOk: 5, sourcesQueried: 7 },
  acled: { available: true, totalEvents: 12, totalFatalities: 3, deadliestEvents: [{ country: 'X', type: 'Battles', fatalities: 3 }] },
  markets: { indexes: [{ symbol: 'SPY', price: 500, changePct: 1.5 }], rates: [], commodities: [], crypto: [] },
  treasury: { totalDebt: '38000000000000' }, defense: [{ recipient: 'Vendor', amount: 1000000, desc: 'Contract description' }],
  space: { recentLaunches: [{ name: 'Launch A' }], militarySats: 12 },
  nuke: [{ site: 'Old monitor', anom: false, stale: true, cpm: 150, lastReading: '2023-01-01T00:00:00Z' }],
};
const delta = { summary: { direction: 'mixed', totalChanges: 1, criticalChanges: 0 }, signals: { escalated: [{ label: 'VIX', from: 15, to: 18, pctChange: 20 }], new: [], deescalated: [] } };

describe('context shape contract', () => {
  it('renders actual synthesized field names and labels stale radiation', () => {
    const text = buildIntelligenceContext(data, delta);
    assert.match(text, /Total events \(7-day\): 12/);
    assert.match(text, /SPY: \$500 \(\+1\.50%\)/);
    assert.match(text, /Total National Debt: \$38000000000000/);
    assert.match(text, /Contract description/);
    assert.match(text, /Launch A/);
    assert.match(text, /VIX: 15 → 18 \(\+20\.0%\)/);
    assert.doesNotMatch(text, /Old monitor: 150 CPM \(anomaly detected\)/);
    assert.match(text, /stale radiation/i);
  });
});

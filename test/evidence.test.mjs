import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEvidenceCatalog, formatEvidenceCatalog, resolveEvidence, sanitizeCitations, validateCitationCoverage, markUnsupportedClaims } from '../lib/evidence/index.mjs';

const fixture = {
  meta: { timestamp: '2026-08-02T12:00:00.000Z' },
  news: [{
    title: 'Verified headline', source: 'Test Wire', date: '2026-08-02T11:55:00Z',
    url: 'https://example.com/report', region: 'Middle East',
  }, {
    title: 'Unsafe link', source: 'Bad Feed', url: 'javascript:alert(1)',
  }],
  fred: [{ id: 'VIXCLS', label: 'VIX', value: 17.2, date: '2026-08-01' }],
  thermal: [{ region: 'Middle East', det: 100, night: 40, hc: 5 }],
  air: [{ region: 'Middle East', total: 50 }],
};

describe('evidence catalog', () => {
  it('builds auditable source records with safe URLs', () => {
    const catalog = buildEvidenceCatalog(fixture, null);
    const news = catalog.find(item => item.title === 'Verified headline');
    const fred = catalog.find(item => item.source === 'FRED');
    assert.ok(news?.id);
    assert.equal(news.url, 'https://example.com/report');
    assert.ok(fred?.url.includes('VIXCLS'));
    assert.equal(catalog.some(item => item.url?.startsWith('javascript:')), false);
    assert.match(formatEvidenceCatalog(catalog), new RegExp(`\\[${news.id}\\].*Verified headline`));
  });

  it('resolves only citations actually used by the model', () => {
    const catalog = buildEvidenceCatalog(fixture, null);
    const first = catalog[0];
    const second = catalog[1];
    const resolved = resolveEvidence(`Observed change [${first.id}] and inference [${second.id}]. [E999]`, catalog);
    assert.deepEqual(resolved.map(item => item.id), [first.id, second.id]);
  });

  it('marks invented evidence IDs as unsupported', () => {
    const catalog = buildEvidenceCatalog(fixture, null);
    assert.equal(sanitizeCitations(`Valid [${catalog[0].id}] invalid [E999] malformed [E123?] open [E86`, catalog), `Valid [${catalog[0].id}] invalid [UNSUPPORTED] malformed [UNSUPPORTED] open [UNSUPPORTED]`);
  });

  it('removes credential-bearing evidence URLs', () => {
    const catalog = buildEvidenceCatalog({ meta: { timestamp: '2026-08-02T12:00:00Z' }, news: [
      { title: 'Unsafe', source: 'Test', url: 'https://user:password@example.com/a?token=secret&view=1' },
      { title: 'Query secret', source: 'Test', url: 'https://example.com/a?api_key=secret&view=1' },
    ] });
    assert.equal(catalog[0].url, null);
    assert.equal(catalog[1].url, 'https://example.com/a?view=1');
  });

  it('covers operational market, government, maritime, environmental, space, communications, and defense domains', () => {
    const catalog = buildEvidenceCatalog({
      meta: { timestamp: '2026-08-02T12:00:00Z' },
      markets: { indexes: [{ symbol: '^GSPC', name: 'S&P 500', price: 6500, changePct: 1, observedAt: '2026-08-02T11:59:00Z' }] },
      bls: [{ id: 'UNRATE', label: 'Unemployment', value: 4.2, date: '2026-07-01' }],
      treasury: { totalDebt: '38T', date: '2026-08-01' }, gscpi: { value: 0.2, date: '2026-07-01' },
      chokepoints: [{ label: 'Hormuz', note: 'Monitored' }], noaa: { alerts: [{ event: 'Storm', headline: 'Storm warning' }] },
      epa: { stations: [{ location: 'A', analyte: 'Gamma', result: 1, unit: 'uR/h' }] },
      space: { recentLaunches: [{ name: 'Object A', epoch: '2026-08-01T00:00:00Z' }] },
      sdr: { online: 10, total: 12 }, defense: [{ recipient: 'Vendor', amount: 1000, desc: 'Award' }],
    });
    const sources = new Set(catalog.map(item => item.source));
    for (const source of ['Yahoo Finance', 'U.S. Bureau of Labor Statistics', 'U.S. Treasury', 'Federal Reserve Bank of New York', 'Moraqeb maritime monitor', 'NOAA', 'EPA RadNet', 'CelesTrak', 'KiwiSDR network', 'USAspending.gov']) assert.equal(sources.has(source), true, source);
  });

  it('rejects a valid citation ID when the cited record does not match the claim', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog.find(item => item.source === 'FRED').id;
    const result = validateCitationCoverage(`[OBSERVED] Verified headline from Test Wire [${id}].`, catalog);
    assert.equal(result.valid, false);
    assert.equal(result.mismatchedClaims.length, 1);
    assert.match(markUnsupportedClaims(`[OBSERVED] Verified headline from Test Wire [${id}].`, result), /^\[UNSUPPORTED\]/);
  });

  it('does not let one cited sentence validate an uncited factual sentence', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog[0].id;
    const text = `Verified headline [${id}]. Iran attacked Israel.`;
    const result = validateCitationCoverage(text, catalog);
    assert.equal(result.valid, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.uncitedClaims.length, 1);
    assert.match(markUnsupportedClaims(text, result), /\[UNSUPPORTED\] Iran attacked Israel\./);
  });

  it('reports partial evidence when a material line is uncited', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog[0].id;
    const result = validateCitationCoverage(`[OBSERVED] Supported fact [${id}].\n[OBSERVED] 99 events reported.`, catalog);
    assert.equal(result.valid, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.uncitedClaims.length, 1);
  });
});

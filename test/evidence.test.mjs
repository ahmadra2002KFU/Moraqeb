import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessEvidenceSet, buildEvidenceCatalog, formatEvidenceCatalog, resolveEvidence, sanitizeCitations, validateCitationCoverage, markUnsupportedClaims } from '../lib/evidence/index.mjs';

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

  it('attaches a citation placed immediately after sentence punctuation to that claim', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog[0].id;
    const result = validateCitationCoverage(`[OBSERVED] Verified headline. [${id}]`, catalog);
    assert.equal(result.valid, true);
    assert.equal(result.uncitedClaims.length, 0);
    assert.equal(result.mismatchedClaims.length, 0);
  });

  it('does not require evidence for explicitly marked analytical inference', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog[0].id;
    const result = validateCitationCoverage(`[OBSERVED] Verified headline [${id}]. [INFERENCE] Monitor the situation closely.`, catalog);
    assert.equal(result.valid, true);
    assert.equal(result.claims.find(claim => claim.kind === 'inference')?.supported, true);
  });

  it('matches scaled quantities such as billions to raw source amounts', () => {
    const catalog = [{
      id: 'E123456789012', title: 'Boeing defense award', observation: '22440000000 awarded',
      source: 'USAspending.gov', timestamp: '2026-08-01T00:00:00Z',
    }];
    const result = validateCitationCoverage('[OBSERVED] Boeing received $22.44 billion in awards [E123456789012].', catalog);
    assert.equal(result.valid, true);
  });

  it('reports complete coverage metrics and does not truncate unsupported claim lists', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog[0].id;
    const unsupported = Array.from({ length: 25 }, (_, i) => `[OBSERVED] Unsupported event ${i + 1}.`).join('\n');
    const result = validateCitationCoverage(`[OBSERVED] Verified headline [${id}].\n${unsupported}`, catalog);
    assert.equal(result.uncitedClaims.length, 25);
    assert.equal(result.coverage.evidenceRequired, 26);
    assert.equal(result.coverage.supported, 1);
  });

  it('requires independent non-social source families for high-confidence corroboration', () => {
    const catalog = [
      { id: 'E1', source: 'Official A', url: 'https://official-a.example/report', confidence: 'high', reliability: 'primary', freshness: 'fresh' },
      { id: 'E2', source: 'Official B', url: 'https://official-b.example/report', confidence: 'high', reliability: 'primary', freshness: 'fresh' },
      { id: 'E3', source: 'Social', confidence: 'low', reliability: 'social', freshness: 'fresh' },
    ];
    assert.equal(assessEvidenceSet(['E1'], catalog).confidenceCap, 'MEDIUM');
    assert.equal(assessEvidenceSet(['E1', 'E2'], catalog).confidenceCap, 'HIGH');
    assert.equal(assessEvidenceSet(['E1', 'E2'], catalog).level, 'corroborated');
    assert.equal(assessEvidenceSet(['E3'], catalog).confidenceCap, 'LOW');
  });

  it('deduplicates syndicated evidence and excludes contextual derivatives from corroboration', () => {
    const catalog = [
      { id: 'E1', source: 'Aggregator', url: 'https://wire.example/report?utm_source=x', confidence: 'high', reliability: 'secondary', freshness: 'fresh' },
      { id: 'E2', source: 'RSS', url: 'https://wire.example/report', confidence: 'high', reliability: 'secondary', freshness: 'fresh' },
      { id: 'E3', source: 'Derived delta', confidence: 'high', reliability: 'derived', supportKind: 'context', freshness: 'fresh' },
    ];
    const result = assessEvidenceSet(['E1', 'E2', 'E3'], catalog);
    assert.equal(result.independentRecords, 2);
    assert.equal(result.directRecords, 1);
    assert.equal(result.nonSocialFamilies, 1);
    assert.equal(result.confidenceCap, 'MEDIUM');
  });

  it('protects abbreviations and prevents citation bleed across semicolon-delimited claims', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog.find(item => item.source === 'Test Wire').id;
    const valid = validateCitationCoverage(`[OBSERVED] The U.S. verified the headline [${id}].`, catalog);
    assert.equal(valid.valid, true);
    assert.equal(valid.claims.length, 1);

    const pooled = validateCitationCoverage(`[OBSERVED] Iran attacked Israel; the verified headline was published [${id}].`, catalog);
    assert.equal(pooled.valid, false);
    assert.equal(pooled.uncitedClaims.length, 1);
  });

  it('rejects factual laundering as inference and citation-only text', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog.find(item => item.source === 'Test Wire').id;
    assert.equal(validateCitationCoverage(`[INFERENCE] Iran attacked Israel. [${id}]`, catalog).valid, false);
    assert.equal(validateCitationCoverage('[INFERENCE] Iran attacked Israel, increasing risk.', catalog).valid, false);
    assert.equal(validateCitationCoverage('[INFERENCE] Monitor after Iran attacked Israel.', catalog).valid, false);
    assert.equal(validateCitationCoverage('[INFERENCE] Risk management should account for Iran attack on Israel.', catalog).valid, false);
    assert.equal(validateCitationCoverage(`[${id}]`, catalog).valid, false);
  });

  it('does not treat allowCrossLanguage alone as proof that unrelated Arabic matches English evidence', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog.find(item => item.source === 'Test Wire').id;
    const unrelated = `[OBSERVED] هاجمت دولة دولة أخرى ووقعت أضرار كبيرة [${id}].`;
    assert.equal(validateCitationCoverage(unrelated, catalog, { allowCrossLanguage: true }).valid, false);
  });

  it('requires explicit cross-language inheritance before accepting Arabic lexical matching', () => {
    const catalog = buildEvidenceCatalog(fixture);
    const id = catalog.find(item => item.source === 'Test Wire').id;
    const text = `[OBSERVED] ادعاء عربي غير مرتبط بالمصدر [${id}].`;
    assert.equal(validateCitationCoverage(text, catalog).valid, false);
    assert.equal(validateCitationCoverage(text, catalog, { allowCrossLanguage: true }).valid, false);
    assert.equal(validateCitationCoverage(text, catalog, { allowCrossLanguage: true, crossLanguageVerified: true }).valid, true);
  });

  it('does not exempt short factual claims or Markdown table rows', () => {
    const catalog = buildEvidenceCatalog(fixture);
    assert.equal(validateCitationCoverage('War started.', catalog).valid, false);
    assert.equal(validateCitationCoverage('| Entity | Value |\n|---|---|\n| Iran | 17 |', catalog).valid, false);
  });
});

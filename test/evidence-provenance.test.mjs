import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceCatalog } from '../lib/evidence/index.mjs';

const data = { meta: { timestamp: '2026-08-02T12:00:00Z' }, thermal: [
  { region: 'A', det: 10, night: 1, hc: 2 }, { region: 'B', det: 20, night: 2, hc: 4 },
] };

describe('evidence provenance', () => {
  it('does not replace missing observation time with collection time', () => {
    const catalog = buildEvidenceCatalog(data);
    assert.equal(catalog[0].timestamp, null);
    assert.equal(catalog[0].collectedAt, '2026-08-02T12:00:00.000Z');
  });

  it('does not collapse distinct records that share a landing URL and uses stable IDs', () => {
    const first = buildEvidenceCatalog(data);
    const second = buildEvidenceCatalog(data);
    assert.equal(first.length, 2);
    assert.notEqual(first[0].id, first[1].id);
    assert.deepEqual(first.map(x => x.id), second.map(x => x.id));
  });
});

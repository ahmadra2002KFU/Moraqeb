import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { latestFirmsObservationTime, deduplicateFirmsDetections, filterFirmsObservationWindow } from '../apis/sources/firms.mjs';

describe('NASA FIRMS observation time', () => {
  it('retains the newest satellite acquisition time for an aggregate', () => {
    assert.equal(latestFirmsObservationTime([
      { acq_date: '2026-08-01', acq_time: '0930' },
      { acq_date: '2026-08-02', acq_time: '41' },
      { acq_date: '2026-08-02', acq_time: '1545' },
    ]), '2026-08-02T15:45:00.000Z');
    assert.equal(latestFirmsObservationTime([]), null);
  });

  it('deduplicates the same satellite detection across overlapping regional boxes', () => {
    const shared = { latitude: '31.12345', longitude: '48.54321', acq_date: '2026-08-02', acq_time: '1345', satellite: 'N', instrument: 'VIIRS', confidence: 'h', frp: '12', daynight: 'N' };
    const result = deduplicateFirmsDetections([
      { label: 'Middle East', fires: [shared] },
      { label: 'Iran', fires: [{ ...shared }] },
      { label: 'Ukraine', fires: [{ ...shared, latitude: '49.00000', longitude: '32.00000' }] },
    ]);
    assert.equal(result.totalDetections, 2);
    assert.equal(result.duplicateMemberships, 1);
    assert.equal(result.highConfidence, 2);
    assert.equal(result.nightDetections, 2);
    assert.deepEqual(result.detections.find(item => item.regions.length === 2).regions, ['Iran', 'Middle East']);
  });

  it('does not collapse distinct products and excludes malformed records', () => {
    const row = { latitude: '31', longitude: '48', acq_date: '2026-08-02', acq_time: '1345', satellite: 'N', instrument: 'VIIRS' };
    const result = deduplicateFirmsDetections([
      { label: 'A', product: 'P1', fires: [row, { ...row, latitude: '' }] },
      { label: 'B', product: 'P2', fires: [{ ...row }] },
    ]);
    assert.equal(result.totalDetections, 2);
    assert.equal(result.invalidDetections, 1);
  });

  it('evaluates each observation inside an explicit rolling window', () => {
    const rows = [
      { acq_date: '2026-08-02', acq_time: '1130' },
      { acq_date: '2026-08-01', acq_time: '1159' },
      { acq_date: '2026-08-02', acq_time: '1210' },
    ];
    const current = filterFirmsObservationWindow(rows, '2026-08-02T12:00:00.000Z');
    assert.deepEqual(current.map(row => row.acq_time), ['1130']);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { latestFirmsObservationTime } from '../apis/sources/firms.mjs';

describe('NASA FIRMS observation time', () => {
  it('retains the newest satellite acquisition time for an aggregate', () => {
    assert.equal(latestFirmsObservationTime([
      { acq_date: '2026-08-01', acq_time: '0930' },
      { acq_date: '2026-08-02', acq_time: '41' },
      { acq_date: '2026-08-02', acq_time: '1545' },
    ]), '2026-08-02T15:45:00.000Z');
    assert.equal(latestFirmsObservationTime([]), null);
  });
});

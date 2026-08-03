import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { regionalizeStates } from '../apis/sources/opensky.mjs';

describe('OpenSky regionalization', () => {
  it('derives all regional counts from one global state-vector response', () => {
    const states = [
      ['abc', 'TEST1', 'Jordan', null, null, 36, 31, 13000],
      ['def', '', 'Taiwan', null, null, 121, 24, 9000],
      ['ghi', 'OUT', 'US', null, null, -120, 35, 10000],
    ];
    const regions = regionalizeStates(states);
    const middleEast = regions.find(item => item.key === 'middleEast');
    const taiwan = regions.find(item => item.key === 'taiwan');
    assert.equal(middleEast.totalAircraft, 1);
    assert.equal(middleEast.highAltitude, 1);
    assert.equal(taiwan.totalAircraft, 1);
    assert.equal(taiwan.noCallsign, 1);
    assert.equal(regions.reduce((sum, item) => sum + item.totalAircraft, 0), 2);
  });
});

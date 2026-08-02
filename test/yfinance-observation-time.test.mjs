import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { marketObservationTime, marketPreviousClose } from '../apis/sources/yfinance.mjs';

describe('Yahoo Finance observation time', () => {
  it('uses the exchange quote time instead of sweep collection time', () => {
    assert.equal(marketObservationTime({ regularMarketTime: 1785528000 }), '2026-07-31T20:00:00.000Z');
    assert.equal(marketObservationTime({}), null);
  });

  it('uses the prior daily close rather than the close preceding a multi-day chart window', () => {
    assert.equal(marketPreviousClose({ chartPreviousClose: 79.26 }, [79.26, 84.46, 83.59, 84.67], 84.67), 83.59);
    assert.equal(marketPreviousClose({ previousClose: 83.5, chartPreviousClose: 79.26 }, [79.26, 84.67], 84.67), 83.5);
  });
});

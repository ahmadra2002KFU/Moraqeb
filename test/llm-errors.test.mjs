import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getPublicLLMError } from '../lib/llm/errors.mjs';

describe('getPublicLLMError', () => {
  it('does not expose upstream response bodies', () => {
    const error = new Error('OmniRoute API 401: upstream-secret-body');
    assert.equal(getPublicLLMError(error), 'The AI provider request failed. Please try again.');
  });
});

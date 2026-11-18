import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { shouldRetry } from './query-provider';

describe('shouldRetry', () => {
  it('retries what may answer differently the next time, at most twice', () => {
    expect(shouldRetry(0, new ApiError(503, 'unavailable', '/x'))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, 'unavailable', '/x'))).toBe(false);
  });

  it('never retries a refusal or a missing resource', () => {
    expect(shouldRetry(0, new ApiError(403, 'studio:read required', '/x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'not buffered', '/x'))).toBe(false);
  });
});

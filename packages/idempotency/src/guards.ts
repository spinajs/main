import { InvalidArgument } from '@spinajs/exceptions';

/** The width of the `Key` and `Fingerprint` columns; MySQL would cut a longer value silently. */
export const MAX_KEY_LENGTH = 64;

export function positive(name: string, ms: number): void {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw new InvalidArgument(`${name} must be a finite number above 0, got ${ms}`);
  }
}

export function fitsColumn(name: string, value: string | undefined): void {
  if (value !== undefined && value.length > MAX_KEY_LENGTH) {
    throw new InvalidArgument(`${name} must be at most ${MAX_KEY_LENGTH} characters, got ${value.length}`);
  }
}

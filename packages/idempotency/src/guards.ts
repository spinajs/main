import { InvalidArgument } from '@spinajs/exceptions';

/** The width of the `Key` and `Fingerprint` columns; MySQL would cut a longer value silently. */
export const MAX_KEY_LENGTH = 64;

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

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

/** MySQL's binary collation pads with spaces: `'k'` and `'k '` would be one key there and two keys elsewhere. */
export function plainKey(key: string): void {
  fitsColumn('key', key);
  if (key.trim() !== key || [...key].some(isControl)) {
    throw new InvalidArgument(`key ${JSON.stringify(key)} has surrounding whitespace or a control character`);
  }
}

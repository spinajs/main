/** Plain decimal text, no exponent: what decimal.js and big.js `toJSON()` write below their exponent thresholds. */
export const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** The part of an Ajv instance that formats are added through. */
export interface FormatHost {
  addFormat(name: string, format: RegExp): unknown;
}

/** The formats SpinaJS adds to every server Ajv instance, next to `ajv-formats`. */
export function addSpinajsFormats<T extends FormatHost>(ajv: T): T {
  ajv.addFormat('decimal', DECIMAL_PATTERN);
  return ajv;
}

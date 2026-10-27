/** Locale-independent ordering, so output is byte-identical on every machine. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

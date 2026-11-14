// The declaration shape decimal.js ships (decimal.d.ts): a class merged with a namespace, also the default export.
export default Decimal;
export declare namespace Decimal {
  type Value = string | number | Decimal;
}
export declare class Decimal {
  constructor(n: Decimal.Value);
  plus(n: Decimal.Value): Decimal;
  toFixed(decimalPlaces?: number): string;
  toJSON(): string;
}

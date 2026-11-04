// The declaration shape of @types/big.js: an interface merged with a const of the same name.
export interface BigConstructor {
  new (value: string | number | Big): Big;
}
export interface Big {
  plus(n: string | number | Big): Big;
  toFixed(dp?: number): string;
  toJSON(): string;
}
export declare const Big: BigConstructor;
export default Big;

declare const tag: unique symbol;

export interface Constructor<T> {
  new (...args: unknown[]): T;
}

export type Validator = Function & { prototype: { check?: string } };

export interface WithSymbols {
  name: string;
  validator: Validator;
  [tag]: number;
  [Symbol.iterator]?: string;
}

export type Combined = WithSymbols & { extra: boolean };
export type Mapped = { [K in keyof WithSymbols]: WithSymbols[K] };
export type Tagged = { kind: 'a'; [tag]: 'x' } | { kind: 'b'; [tag]: 'y' };

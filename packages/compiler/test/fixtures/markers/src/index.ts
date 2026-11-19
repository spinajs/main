/**
 * A described base.
 * @spinajs query select
 */
export class Base<T> {
  constructor(readonly value: T) {}
}
export class Sub<T> extends Base<T> {}
export class Plain {}

/** @spinajs query update */
export interface IUpd<T> {
  readonly row: T;
}
export interface IUpdMore<T> extends IUpd<T> {
  readonly more: boolean;
}

/**
 * The principal everything may do.
 * @spinajs system-principal
 */
export const ROOT = Object.freeze({ id: 'root' });

export class Service {
  /** @spinajs run-as */
  run(): void {}
  other(): void {}
}

export async function rows(): Promise<number[]> {
  return [];
}
export async function* stream(): AsyncGenerator<number> {
  yield 1;
}
export function iterable(): AsyncIterable<number> {
  return stream();
}
export function plain(): number[] {
  return [];
}

/**
 * @spinajs query delete
 * Text after the value is not part of it.
 */
export interface IDel<T> {
  readonly row: T;
}

/** Async-iterable by its member only: it extends no library type. */
export class Feed {
  async *[Symbol.asyncIterator](): AsyncGenerator<number> {
    yield 1;
  }
}
export function feed(): Feed {
  return new Feed();
}

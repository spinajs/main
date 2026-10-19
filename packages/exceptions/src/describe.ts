export interface DescribeErrorOptions {
  /** Prefix an Error's message with its class, `TypeError: boom`. Defaults to `true`. */
  withClass?: boolean;
}

// A thrown value may be a Proxy or carry throwing getters; describing it must never throw in turn.
const safely = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const isError = (err: unknown): err is Error => safely(() => err instanceof Error, false);

/**
 * The class of a thrown value, for logs that must not carry its message: `name` unless it is the generic `'Error'`,
 * then the constructor name. A non-Error gives its `typeof` (`'null'` for null).
 */
export function errorClassOf(err: unknown): string {
  if (err === null) return 'null';
  if (!isError(err)) return typeof err;
  return safely(() => {
    const name = err.name;
    if (typeof name === 'string' && name !== '' && name !== 'Error') return name;
    const ctor = (err.constructor as { name?: unknown } | undefined)?.name;
    return typeof ctor === 'string' && ctor !== '' ? ctor : 'Error';
  }, 'Error');
}

/**
 * The message of an Error, a string as is, a primitive through `String()`. Any other object gives its
 * `Object.prototype.toString` tag (`[object Object]`), so its contents never reach a log.
 */
export function errorMessage(err: unknown): string {
  return safely(() => {
    if (isError(err)) return typeof err.message === 'string' ? err.message : '';
    if (typeof err === 'string') return err;
    if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return String(err);
    return Object.prototype.toString.call(err) as string;
  }, 'unprintable error');
}

/** {@link errorMessage}, prefixed by {@link errorClassOf} for an Error unless `withClass` is `false`. */
export function describeError(err: unknown, options: DescribeErrorOptions = {}): string {
  const message = errorMessage(err);
  if (options.withClass === false || !isError(err)) return message;
  const errorClass = errorClassOf(err);
  return message === '' ? errorClass : `${errorClass}: ${message}`;
}

/** `err` itself when it is an Error; otherwise a new Error whose message is {@link errorMessage}, not the value. */
export function toError(err: unknown): Error {
  return isError(err) ? err : new Error(errorMessage(err));
}

/**
 * `instanceof`, or a class of the same name along `err`'s prototype chain: an error from another copy of the class
 * (the cjs and the mjs build of one package) matches too, the way the HTTP error mapping does.
 */
export function isErrorOf<T extends Error>(err: unknown, errorClass: abstract new (...args: never[]) => T): err is T {
  if (safely(() => err instanceof errorClass, false)) return true;
  const name = errorClass.name;
  if (name === '' || typeof err !== 'object' || err === null) return false;
  return safely(() => {
    for (
      let ctor: unknown = err.constructor;
      typeof ctor === 'function' && ctor !== Object;
      ctor = Object.getPrototypeOf(ctor)
    ) {
      if (ctor.name === name) return true;
    }
    return false;
  }, false);
}

import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

/**
 * Asserts that a condition is true. Throws InvalidOperation if false.
 *
 * @param condition - condition to check
 * @param error - message or Error to throw when condition is false
 */
export function assert(condition: boolean, error: string | Error): asserts condition {
  if (!condition) {
    throw typeof error === 'string' ? new InvalidOperation(error) : error;
  }
}

/**
 * Asserts that a value is not null. Throws InvalidArgument if null.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertNonNull<T>(value: T | null, name?: string, error?: Error): asserts value is T {
  if (value === null) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should not be null`, name ?? 'value', 'NULL_VALUE');
  }
}

/**
 * Asserts that a value is not null or undefined. Throws InvalidArgument if nil.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertNonNil<T>(value: T | null | undefined, name?: string, error?: Error): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should not be null or undefined`, name ?? 'value', 'NULL_VALUE');
  }
}

/**
 * Asserts that a value is a string. Throws InvalidArgument if not.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertString(value: unknown, name?: string, error?: Error): asserts value is string {
  if (typeof value !== 'string') {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should be a string`, name ?? 'value', 'TYPE_MISMATCH');
  }
}

/**
 * Asserts that a value is a non-empty string. Throws InvalidArgument if not.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertNonEmptyString(value: unknown, name?: string, error?: Error): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should be a non-empty string`, name ?? 'value', 'EMPTY_VALUE');
  }
}

/**
 * Asserts that a value is a number. Throws InvalidArgument if not.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertNumber(value: unknown, name?: string, error?: Error): asserts value is number {
  if (typeof value !== 'number' || isNaN(value)) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should be a number`, name ?? 'value', 'TYPE_MISMATCH');
  }
}

/**
 * Asserts that a value is an array. Throws InvalidArgument if not.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertArray<T = unknown>(value: unknown, name?: string, error?: Error): asserts value is T[] {
  if (!Array.isArray(value)) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should be an array`, name ?? 'value', 'TYPE_MISMATCH');
  }
}

/**
 * Asserts that a value is a plain object (not array, not null). Throws InvalidArgument if not.
 *
 * @param value - value to check
 * @param name - name of the argument for the error message
 * @param error - optional custom error
 */
export function assertObject(value: unknown, name?: string, error?: Error): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw error ?? new InvalidArgument(`${name ?? 'value'} should be an object`, name ?? 'value', 'TYPE_MISMATCH');
  }
}

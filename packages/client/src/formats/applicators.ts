import { jsonEqual } from './equal.js';
import { maxCodePoints, minCodePoints, ajvMultipleOf } from './keywords.js';

/**
 * Checks of the keywords zod has no native form for. Each answers as Ajv 8 does and, as Ajv, passes a value of a type
 * the keyword does not apply to. They take predicates (`(v) => Schema.safeParse(v).success`), so they need no zod.
 */

type Test = (value: unknown) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function minProperties(n: number): Test {
  return (value) => !isObject(value) || Object.keys(value).length >= n;
}

export function maxProperties(n: number): Test {
  return (value) => !isObject(value) || Object.keys(value).length <= n;
}

export function propertyNames(test: Test): Test {
  return (value) => !isObject(value) || Object.keys(value).every(test);
}

/** Every value whose key matches a pattern matches that pattern's schema. */
export function patternProperties(patterns: readonly (readonly [RegExp, Test])[]): Test {
  return (value) => !isObject(value) || Object.keys(value).every((key) => patterns.every(([pattern, test]) => !pattern.test(key) || test(value[key])));
}

/** `additionalProperties` next to `patternProperties`: a key neither declared nor matched is refused, or checked by `test`. */
export function additionalProperties(declared: readonly string[], patterns: readonly RegExp[], test?: Test): Test {
  const names = new Set(declared);
  const additional = (key: string): boolean => !names.has(key) && !patterns.some((pattern) => pattern.test(key));
  return (value) => !isObject(value) || Object.keys(value).every((key) => !additional(key) || (test !== undefined && test(value[key])));
}

/** A present property, as Ajv reads one: `data[name] !== undefined`, so an inherited `toString` is present. */
const present = (value: Record<string, unknown>, name: string): boolean => Reflect.get(value, name) !== undefined;

/** Draft-07 `dependencies`: a list of names that must be present with the key, or a schema the whole object must match. */
export function dependencies(entries: Readonly<Record<string, readonly string[] | Test>>): Test {
  const list = Object.entries(entries);
  const holds = (value: Record<string, unknown>, dependency: readonly string[] | Test): boolean =>
    typeof dependency === 'function' ? dependency(value) : dependency.every((name) => present(value, name));
  return (value) => !isObject(value) || list.every(([key, dependency]) => !present(value, key) || holds(value, dependency));
}

export function contains(test: Test): Test {
  return (value) => !Array.isArray(value) || value.some(test);
}

/** Ajv's `$data` lookup: each step reads a property of the last value, and a falsy value ends the walk as itself. */
export function dataRef(base: unknown, path: readonly string[]): unknown {
  let value = base;
  for (const segment of path) value = value && (value as Record<string, unknown>)[segment];
  return value;
}

export type DataKeyword =
  | 'const'
  | 'minimum'
  | 'maximum'
  | 'exclusiveMinimum'
  | 'exclusiveMaximum'
  | 'multipleOf'
  | 'minLength'
  | 'maxLength'
  | 'minItems'
  | 'maxItems'
  | 'minProperties'
  | 'maxProperties';

const NUMBER_LIMITS: Partial<Record<DataKeyword, (value: number, limit: number) => boolean>> = {
  minimum: (v, l) => v >= l,
  maximum: (v, l) => v <= l,
  exclusiveMinimum: (v, l) => v > l,
  exclusiveMaximum: (v, l) => v < l,
  multipleOf: (v, l) => ajvMultipleOf(l)(v),
};

/** The type of value a limit keyword applies to, and how it counts or compares the value. */
function measured(keyword: DataKeyword, value: unknown, limit: number): boolean | undefined {
  const number = NUMBER_LIMITS[keyword];
  if (number) return typeof value === 'number' ? number(value, limit) : undefined;
  if (keyword === 'minLength' || keyword === 'maxLength') return typeof value === 'string' ? (keyword === 'minLength' ? minCodePoints : maxCodePoints)(limit)(value) : undefined;
  if (keyword === 'minItems' || keyword === 'maxItems') return Array.isArray(value) ? (keyword === 'minItems' ? value.length >= limit : value.length <= limit) : undefined;
  return isObject(value) ? (keyword === 'minProperties' ? Object.keys(value).length >= limit : Object.keys(value).length <= limit) : undefined;
}

/**
 * A keyword whose value is `{ $data }`, as Ajv applies it: an absent value or reference passes, a limit that is not
 * a number fails, and a value of a type the keyword does not apply to passes.
 */
export function dataLimit(keyword: DataKeyword, value: unknown, ref: unknown): boolean {
  if (value === undefined || ref === undefined) return true;
  if (keyword === 'const') return jsonEqual(value, ref);
  const verdict = measured(keyword, value, ref as number);
  return verdict === undefined || (typeof ref === 'number' && verdict);
}

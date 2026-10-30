import type { IValidationError } from './exceptions/index.js';

/** Structural copy of the Standard Schema v1 interface (standardschema.dev), so no schema library is a dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const marker = (value as { '~standard'?: { validate?: unknown } })['~standard'];
  return typeof marker === 'object' && marker !== null && typeof marker.validate === 'function';
}

const pointerSegment = (segment: PropertyKey | { key: PropertyKey }): string => {
  const key = typeof segment === 'object' ? segment.key : segment;
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
};

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

const GENERIC_MESSAGE = 'Invalid value';
const MAX_LEAVES = 1000;
const MAX_DEPTH = 8;

/** Strings and numbers anywhere in `input`, bounded so a hostile payload cannot make the scan expensive. */
function leafValues(input: unknown): string[] {
  const leaves: string[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (leaves.length >= MAX_LEAVES) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      const text = String(value);
      if (text.length > 0) leaves.push(text);
    } else if (typeof value === 'object' && value !== null && depth < MAX_DEPTH && !seen.has(value)) {
      seen.add(value);
      for (const child of Object.values(value)) walk(child, depth + 1);
    }
  };
  walk(input, 0);
  return leaves;
}

/**
 * Issues in the shape of an Ajv error, so `ValidationFailed` and the problem+json bodies built from it do not change.
 * Libraries may echo the input in a message ("received 123"); a message containing any value of `input` is replaced
 * by a generic one, the same way the Ajv path drops value-bearing params.
 */
export function toValidationErrors(issues: readonly StandardIssue[], input?: unknown): IValidationError[] {
  const leaves = input === undefined ? [] : leafValues(input);
  return issues.map((issue) => {
    const message = typeof issue.message === 'string' && !leaves.some((leaf) => issue.message.includes(leaf)) ? issue.message : GENERIC_MESSAGE;
    return {
      keyword: 'standardSchema',
      instancePath: (issue.path ?? []).map((segment) => `/${pointerSegment(segment)}`).join(''),
      schemaPath: '#',
      params: {},
      message,
    };
  });
}

export function standardOutcome(result: StandardResult<unknown>, input: unknown): [boolean, IValidationError[] | null] {
  return result.issues ? [false, toValidationErrors(result.issues, input)] : [true, null];
}

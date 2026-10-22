import { InvalidArgument } from '@spinajs/exceptions';
import { OnError } from '@spinajs/http';
import type { ErrorClass, ErrorContext, OnErrorHandler, OnErrorResult } from '@spinajs/http';
import { ValidationFailed } from '@spinajs/validation';
import type { IValidationError } from '@spinajs/validation';

import { badRequest } from '../v3/responses.js';

/** What argument extraction throws for an input its schema refuses: a schema violation, or a body that is no JSON object. */
export const INVALID_INPUT: readonly ErrorClass[] = [ValidationFailed, InvalidArgument];

/** The input an invalid-input error is about. */
export interface FailedInput {
  /** The `$id` of the schema the input failed, '' when there is none (a missing body, a body that is no JSON). */
  readonly schema: string;
  /** The top-level fields that failed, in report order; '' stands for the input as a whole. */
  readonly fields: readonly string[];
  /** Top-level fields the schema does not know (D5). */
  readonly unknown: readonly string[];
  /** The rule each failed field broke first, e.g. `maxLength`. */
  readonly rules: ReadonlyMap<string, string>;
}

const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');

/** The top-level field one schema error is about: `{ unknown }` for a field the schema does not know, null for none. */
function fieldOf(e: IValidationError): { field: string } | { unknown: string } | null {
  // if/then and oneOf report their own error next to the one of the branch that failed.
  if (e.keyword === 'if' || e.keyword === 'oneOf') return null;
  const path = typeof e.instancePath === 'string' ? e.instancePath : '';
  const params = (e.params ?? {}) as Record<string, unknown>;
  if (path === '' && e.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') return { unknown: params.additionalProperty };
  if (path === '' && e.keyword === 'required' && typeof params.missingProperty === 'string') return { field: params.missingProperty };
  // @spinajs/http's own required check of an absent argument names the parameter, without a slash.
  return { field: path.startsWith('/') ? unescape(path.split('/')[1]) : '' };
}

export function failedInput(err: unknown): FailedInput {
  const fields: string[] = [];
  const unknown: string[] = [];
  const rules = new Map<string, string>();
  const failed = (field: string, rule: string) => {
    if (!fields.includes(field)) fields.push(field);
    if (!rules.has(field)) rules.set(field, rule);
  };
  const errors = err instanceof ValidationFailed ? (err.parameter ?? []) : [];
  for (const e of errors) {
    const at = fieldOf(e);
    if (at && 'unknown' in at) unknown.push(at.unknown);
    else if (at) failed(at.field, e.keyword);
  }
  if (fields.length === 0 && unknown.length === 0) failed('', 'type');
  const schema = err instanceof ValidationFailed ? (err.schema as { $id?: unknown } | undefined)?.$id : undefined;
  return { schema: typeof schema === 'string' ? schema : '', fields, unknown, rules };
}

export type InputAnswer = (input: FailedInput, err: Error, ctx: ErrorContext) => OnErrorResult | Promise<OnErrorResult>;

/**
 * The answer of the first field of `byField` (in its order, which is the order the route used to check them) that
 * failed; a missing or unparsable body is the first field failing. An input with only unknown fields failing gets
 * `otherwise`.
 */
export function byField(answers: Readonly<Record<string, InputAnswer>>, otherwise: InputAnswer): InputAnswer {
  const order = Object.keys(answers);
  return (input, err, ctx) => {
    const field = order.find((f) => input.fields.includes(f)) ?? (input.fields.includes('') ? order[0] : undefined);
    return field === undefined ? otherwise(input, err, ctx) : answers[field](input, err, ctx);
  };
}

/** `answer` for an input of the argument whose schema has this `$id`, `otherwise` for any other. */
export function bySchema(id: string, answer: InputAnswer, otherwise: InputAnswer): InputAnswer {
  return (input, err, ctx) => (input.schema === id ? answer(input, err, ctx) : otherwise(input, err, ctx));
}

/** The handler of `answer`, for `OnError`. */
export const onInput =
  (answer: InputAnswer): OnErrorHandler =>
  (err, ctx) =>
    answer(failedInput(err), err, ctx);

/**
 * The answer of a route to an input its DTO refuses (D1, D2): runs only for errors of argument extraction, so an
 * action's own InvalidArgument keeps its answer.
 */
export function OnInvalidInput(answer: InputAnswer): ReturnType<typeof OnError> {
  return OnError(INVALID_INPUT, onInput(answer), { stages: ['arguments'] });
}

/** 400 `invalid_field`: the body holds a field the route does not take (D5). */
export const unknownField: InputAnswer = () => badRequest('invalid_field', 'the body has a field this route does not take');

/** A fixed 400 `{ error: code, message }` with no-store. */
export const invalid =
  (code: string, message: string): InputAnswer =>
  () =>
    badRequest(code, message);

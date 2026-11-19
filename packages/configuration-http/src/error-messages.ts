import type { IValidationError } from '@spinajs/validation';

type ErrorParams = Record<string, unknown>;

const limit = (p: ErrorParams) => `must be ${String(p.comparison)} ${String(p.limit)}`;
const formatLimit = (p: ErrorParams) => `should be ${String(p.comparison)} ${String(p.limit)}`;
const fewer = (unit: string) => (p: ErrorParams) => `must NOT have fewer than ${String(p.limit)} ${unit}`;
const more = (unit: string) => (p: ErrorParams) => `must NOT have more than ${String(p.limit)} ${unit}`;

// ajv's own English texts, so the answer is the same whether `validation.messages` lets ajv write them or not
const CONSTRAINT_MESSAGES: Readonly<Record<string, (params: ErrorParams) => string>> = {
  type: (p) => `must be ${[p.type].flat().map(String).join(',')}`,
  required: (p) => `must have required property '${String(p.missingProperty)}'`,
  enum: () => 'must be equal to one of the allowed values',
  const: () => 'must be equal to constant',
  minimum: limit,
  maximum: limit,
  exclusiveMinimum: limit,
  exclusiveMaximum: limit,
  formatMinimum: formatLimit,
  formatMaximum: formatLimit,
  formatExclusiveMinimum: formatLimit,
  formatExclusiveMaximum: formatLimit,
  multipleOf: (p) => `must be multiple of ${String(p.multipleOf)}`,
  minLength: fewer('characters'),
  maxLength: more('characters'),
  minItems: fewer('items'),
  maxItems: more('items'),
  minProperties: fewer('properties'),
  maxProperties: more('properties'),
  uniqueItems: (p) => `must NOT have duplicate items (items ## ${String(p.j)} and ${String(p.i)} are identical)`,
  pattern: (p) => `must match pattern "${String(p.pattern)}"`,
  format: (p) => `must match format "${String(p.format)}"`,
  additionalProperties: () => 'must NOT have additional properties',
  anyOf: () => 'must match a schema in anyOf',
  oneOf: () => 'must match exactly one schema in oneOf',
  not: () => 'must NOT be valid',
  if: (p) => `must match "${String(p.failingKeyword)}" schema`,
};

/** The constraint one validator error reports, eg. `must be <= 25`. */
export function constraintMessage(error: IValidationError): string {
  if (error.message) {
    return error.message;
  }
  const params = (error.params ?? {}) as ErrorParams;
  return CONSTRAINT_MESSAGES[error.keyword]?.(params) ?? `must pass "${error.keyword}" keyword validation`;
}

// with allErrors on, the type schema and the registered schema report the same failure from both allOf branches
export const joinMessages = (messages: readonly string[]): string => [...new Set(messages)].join('; ');

/** Joins the errors of the `PATCH` body schema into a single 400 message, worded like the value errors. */
export function formatBodyErrors(errors: readonly IValidationError[]): string {
  const messages = errors.map((e) => {
    if (!e.instancePath && e.keyword === 'required') {
      return `${String((e.params as ErrorParams).missingProperty)} is required`;
    }
    return `${e.instancePath ? e.instancePath.slice(1) : 'body'} ${constraintMessage(e)}`;
  });
  return joinMessages(messages) || 'invalid request body';
}

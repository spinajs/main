import type { ProblemDetails } from './errors.js';

/** One Ajv error of a validation problem, as the form sees it. */
export interface FieldIssue {
  keyword: string;
  params: Record<string, unknown>;
}

export interface FieldError {
  keyword: string;
  message: string;
}

/** Returns the text for an error, or `undefined` to keep the default English one. */
export type MessageMapper = (issue: FieldIssue) => string | undefined;

export interface ApplyProblemOptions {
  /** Texts for errors that arrive without one; a `message` the server sent is used as it is. */
  messages?: MessageMapper;
}

/** The part of react-hook-form's `setError` that `applyProblem` uses; `N` is the form's field-name type. */
export type SetFieldError<N extends string = string> = (name: N, error: { type: string; message?: string }) => void;

const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const list = (values: unknown): string => (Array.isArray(values) ? values.map(String).join(', ') : '');

const article = (type: string): string => (type === 'null' ? type : /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);

const DEFAULT_MESSAGES: Record<string, (params: Record<string, unknown>) => string> = {
  required: () => 'is required',
  type: ({ type }) => `must be ${(Array.isArray(type) ? type.map(String) : [String(type)]).map(article).join(' or ')}`,
  minLength: ({ limit }) => `must be at least ${String(limit)} characters`,
  maxLength: ({ limit }) => `must be at most ${String(limit)} characters`,
  minimum: ({ limit }) => `must be at least ${String(limit)}`,
  maximum: ({ limit }) => `must be at most ${String(limit)}`,
  exclusiveMinimum: ({ limit }) => `must be greater than ${String(limit)}`,
  exclusiveMaximum: ({ limit }) => `must be less than ${String(limit)}`,
  multipleOf: ({ multipleOf }) => `must be a multiple of ${String(multipleOf)}`,
  minItems: ({ limit }) => `must have at least ${String(limit)} items`,
  maxItems: ({ limit }) => `must have at most ${String(limit)} items`,
  uniqueItems: () => 'must not contain duplicates',
  pattern: () => 'has an invalid format',
  format: ({ format }) => `must be a valid ${String(format)}`,
  enum: ({ allowedValues }) => `must be one of: ${list(allowedValues)}`,
  const: () => 'has an invalid value',
  additionalProperties: () => 'is not allowed',
};

function messageOf(issue: FieldIssue, sent: unknown, options: ApplyProblemOptions | undefined): string {
  if (typeof sent === 'string' && sent !== '') return sent;
  return options?.messages?.(issue) ?? DEFAULT_MESSAGES[issue.keyword]?.(issue.params) ?? 'is invalid';
}

/**
 * Where an error belongs. A missing property is named by `params.missingProperty` under the parent's path. An
 * `additionalProperties` error goes to the parent: the form has no input for the extra property.
 */
function fieldName(item: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
  if (typeof item.instancePath !== 'string') return undefined;
  const segments = item.instancePath.split('/').slice(1).map(unescape);
  if (item.keyword === 'required' && typeof params.missingProperty === 'string') segments.push(params.missingProperty);
  // Each argument is validated on its own: `name` is the key it has on the wire, absent for a whole body, query, ...
  if (typeof item.name === 'string') segments.unshift(item.name);
  return segments.length > 0 ? segments.join('.') : 'root';
}

/**
 * The Ajv errors of a validation problem per form field: `/address/city` is `address.city` and an error on the whole body is
 * `root`. A property name that contains `.` cannot be told from a path, and a property called `root` shares the whole-body
 * bucket.
 */
export function problemFieldErrors(problem: ProblemDetails, options?: ApplyProblemOptions): Record<string, FieldError[]> {
  const fields: Record<string, FieldError[]> = {};
  if (!Array.isArray(problem.errors)) return fields;
  for (const item of problem.errors as unknown[]) {
    if (!isRecord(item) || typeof item.keyword !== 'string') continue;
    const params = isRecord(item.params) ? item.params : {};
    const name = fieldName(item, params);
    if (name === undefined) continue;
    (fields[name] ??= []).push({ keyword: item.keyword, message: messageOf({ keyword: item.keyword, params }, item.message, options) });
  }
  return fields;
}

// Matches by shape: an app can hold two copies of this package, and `instanceof` fails across them.
function problemOf(error: unknown): ProblemDetails | undefined {
  const problem = isRecord(error) ? error.problem : undefined;
  return isRecord(problem) ? (problem as unknown as ProblemDetails) : undefined;
}

/**
 * Sets the first error of each field named by a validation problem on a form; false when `error` carries none. `N` lets a
 * typed react-hook-form `setError` through: the names are built from the server's paths, which the type cannot know.
 */
export function applyProblem<N extends string>(error: unknown, setError: SetFieldError<N>, options?: ApplyProblemOptions): boolean {
  const problem = problemOf(error);
  if (!problem) return false;
  const fields = Object.entries(problemFieldErrors(problem, options));
  for (const [name, [first]] of fields) setError(name as N, { type: first.keyword, message: first.message });
  return fields.length > 0;
}

import { Exception } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';

export interface ProblemDetails {
  /** `about:blank`, or the URI from the exception class's static `problemType`. */
  type: string;
  /** Exception class name in words, e.g. "Validation Failed". */
  title: string;
  status: number;
  /** The exception message. */
  detail?: string;
  /** Request URL, credentials in its query redacted. */
  instance?: string;
  code?: string;
  /** Ajv errors, set for `ValidationFailed` only. */
  errors?: unknown;
  /** Only when `includeStack` is set and the app is not in production. */
  stack?: string;
  [extension: string]: unknown;
}

export interface ProblemOptions {
  includeStack: boolean;
  /** Own enumerable properties of the exception copied into the body as extension members, on top of its static `problemFields`. */
  includeFields: string[];
  isProduction: boolean;
  instance?: string;
  /** Hide the message, code, title and extension members: the answer is the generic server error of a production app. */
  redact?: boolean;
}

export const GENERIC_DETAIL = 'Internal server error';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const PROBLEM_DETAILS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'spinajs/http/ProblemDetails',
  title: 'ProblemDetails',
  description: 'RFC 9457 problem details',
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', description: 'about:blank, or a URI identifying the problem type.' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    errors: { description: 'Validation errors, present on validation failures only.' },
    stack: { type: 'string', description: 'Present only when http.errors.includeStack is enabled outside production.' },
  },
  additionalProperties: true,
} as const;

const RESERVED = new Set(['type', 'title', 'status', 'detail', 'instance', 'code', 'stack', 'message']);

// Bodies built by toProblem, so the response layer can tell them from arbitrary error models.
const problems = new WeakSet<object>();

export function isProblem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && problems.has(value);
}

function titleOf(err: Error): string {
  const name = err.constructor?.name || err.name || 'Error';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function declared<T>(err: Error, name: 'problemFields' | 'problemType'): T | undefined {
  return typeof err.constructor === 'function' ? (err.constructor as unknown as Record<string, T | undefined>)[name] : undefined;
}

const PROBLEM_FIELDS = Symbol('problemFields');

/**
 * Sets `fields` on an error built on the spot and lists them for the problem body, for the places that cannot declare a
 * subclass with a static `problemFields`.
 */
export function withProblemFields<E extends Error>(err: E, fields: Record<string, unknown>): E {
  Object.assign(err, fields);
  Object.defineProperty(err, PROBLEM_FIELDS, { value: Object.keys(fields), enumerable: false, configurable: true });
  return err;
}

function listedFields(err: Error): string[] {
  const own = declared<unknown>(err, 'problemFields');
  const instance = (err as unknown as Record<symbol, unknown>)[PROBLEM_FIELDS];
  return [...(Array.isArray(own) ? own : []), ...(Array.isArray(instance) ? instance : [])].filter((f): f is string => typeof f === 'string');
}

function allowedFields(err: Error, configured: string[]): Record<string, unknown> {
  const fields = [...configured.filter((f) => f !== 'errors'), ...listedFields(err)];

  return Object.fromEntries(Object.entries(err).filter(([key, value]) => fields.includes(key) && !RESERVED.has(key) && value !== undefined));
}

// Only framework exceptions and classes that list `code` in problemFields: a library error's code (a Postgres SQLSTATE, EACCES) describes the host.
function exposesCode(err: Error): boolean {
  return err instanceof Exception || listedFields(err).includes('code');
}

function headOf(err: Error, status: number, redact: boolean | undefined): ProblemDetails {
  if (redact) {
    return { type: 'about:blank', title: 'Internal Server Error', status };
  }
  const problemType = declared<unknown>(err, 'problemType');
  return { type: typeof problemType === 'string' && problemType.length > 0 ? problemType : 'about:blank', title: titleOf(err), status };
}

export function toProblem(err: Error, status: number, options: ProblemOptions): ProblemDetails {
  const source = err as Error & Record<string, unknown>;
  const problem = headOf(err, status, options.redact);

  if (options.redact) {
    problem.detail = GENERIC_DETAIL;
  } else if (typeof err.message === 'string' && err.message.length > 0) {
    problem.detail = err.message;
  }
  if (options.instance !== undefined) {
    problem.instance = options.instance;
  }
  // Node system errors carry a `code` such as EACCES that names the host's file layout and permissions
  if (!options.redact && typeof source.code === 'string' && typeof source.syscall !== 'string' && exposesCode(err)) {
    problem.code = source.code;
  }
  if (!options.redact) {
    Object.assign(problem, allowedFields(err, options.includeFields));
  }
  if (err instanceof ValidationFailed) {
    problem.errors = err.parameter;
  }

  if (options.includeStack && !options.isProduction && typeof err.stack === 'string') {
    problem.stack = err.stack;
  }

  problems.add(problem);
  return problem;
}

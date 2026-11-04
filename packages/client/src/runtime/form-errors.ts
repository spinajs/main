import type { ProblemDetails } from './errors.js';

export interface FieldError {
  keyword: string;
  message?: string;
}

/** The part of react-hook-form's `setError` that `applyProblem` uses. */
export type SetFieldError = (name: string, error: { type: string; message?: string }) => void;

const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Ajv names a missing or extra property in `params`, and the instance path points at its parent. */
function propertyOf(item: Record<string, unknown>): string | undefined {
  const params = item.params;
  if (!isRecord(params)) return undefined;
  const name = item.keyword === 'required' ? params.missingProperty : item.keyword === 'additionalProperties' ? params.additionalProperty : undefined;
  return typeof name === 'string' ? name : undefined;
}

function fieldName(item: Record<string, unknown>): string | undefined {
  if (typeof item.instancePath !== 'string') return undefined;
  const segments = item.instancePath.split('/').slice(1).map(unescape);
  const property = propertyOf(item);
  if (property !== undefined) segments.push(property);
  return segments.length > 0 ? segments.join('.') : 'root';
}

/** The Ajv errors of a validation problem per form field: `/address/city` is `address.city`, and an error on the whole body is `root`. */
export function problemFieldErrors(problem: ProblemDetails): Record<string, FieldError[]> {
  const fields: Record<string, FieldError[]> = {};
  if (!Array.isArray(problem.errors)) return fields;
  for (const item of problem.errors as unknown[]) {
    if (!isRecord(item) || typeof item.keyword !== 'string') continue;
    const name = fieldName(item);
    if (name === undefined) continue;
    (fields[name] ??= []).push({ keyword: item.keyword, ...(typeof item.message === 'string' ? { message: item.message } : {}) });
  }
  return fields;
}

// Matches by shape: an app can hold two copies of this package, and `instanceof` fails across them.
function problemOf(error: unknown): ProblemDetails | undefined {
  const problem = isRecord(error) ? error.problem : undefined;
  return isRecord(problem) ? (problem as unknown as ProblemDetails) : undefined;
}

/** Sets the first error of each field named by a validation problem on a form; false when `error` carries none. */
export function applyProblem(error: unknown, setError: SetFieldError): boolean {
  const problem = problemOf(error);
  if (!problem) return false;
  const fields = Object.entries(problemFieldErrors(problem));
  for (const [name, [first]] of fields) setError(name, { type: first.keyword, ...(first.message !== undefined ? { message: first.message } : {}) });
  return fields.length > 0;
}

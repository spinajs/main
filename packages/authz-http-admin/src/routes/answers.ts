import { AuthzAdminFailure } from '@spinajs/authz';
import { UnknownAuthzDomain } from '@spinajs/authz-http';
import { InvalidArgument } from '@spinajs/exceptions';
import { BadRequestResponse, Conflict, ForbiddenResponse, NotFound, Ok, ServerError } from '@spinajs/http';
import type { Response } from '@spinajs/http';
import { ValidationFailed } from '@spinajs/validation';
import type { IValidationError } from '@spinajs/validation';

import { adminErrorStatus } from './status.js';

export function respond(status: number, body: unknown): Response {
  switch (status) {
    case 200:
      return new Ok(body);
    case 403:
      return new ForbiddenResponse(body);
    case 404:
      return new NotFound(body);
    case 409:
      return new Conflict(body);
    case 500:
      return new ServerError(body);
    default:
      return new BadRequestResponse(body);
  }
}

/** The answer of an AuthzAdminFailure: its status with `{ error: { code, message, field? } }`. */
export function refused(e: AuthzAdminFailure): Response {
  return respond(adminErrorStatus(e.code), { error: { code: e.code, message: e.message, ...(e.field === undefined ? {} : { field: e.field }) } });
}

const COMPOSITE = new Set(['anyOf', 'oneOf', 'allOf', 'if', 'not']);
const inBranch = (e: IValidationError): boolean => /\/(anyOf|oneOf|allOf)\/\d+\//.test(e.schemaPath);

/** The error that names the input best: an unknown key, else an error outside the branches of anyOf/oneOf, else the composite itself. */
function primary(errors: readonly IValidationError[]): IValidationError | undefined {
  const own = errors.filter((e) => !inBranch(e));
  return own.find((e) => e.keyword === 'additionalProperties') ?? own.find((e) => !COMPOSITE.has(e.keyword)) ?? own[0] ?? errors[0];
}

/** `/commands/0/expiresAt` as `commands.0.expiresAt`; the key a `required` or `additionalProperties` error names is appended. */
function pathOf(e: IValidationError): string[] {
  const params = e.params as { missingProperty?: string; additionalProperty?: string; missingParameter?: string };
  // http's required-parameter check names the argument, not a JSON pointer.
  if (params.missingParameter !== undefined) return [];
  const path = e.instancePath === '' ? [] : e.instancePath.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (e.keyword === 'required' && params.missingProperty !== undefined) path.push(params.missingProperty);
  if (e.keyword === 'additionalProperties' && params.additionalProperty !== undefined) path.push(params.additionalProperty);
  return path;
}

const LIMIT_WORDS: Readonly<Record<string, string>> = {
  maxLength: 'exceeds the limit of',
  maxItems: 'exceeds the limit of',
  maximum: 'exceeds the limit of',
  minLength: 'is below the minimum of',
  minItems: 'is below the minimum of',
  minimum: 'is below the minimum of',
};

function describe(e: IValidationError, field: string | undefined, errors: readonly IValidationError[]): string {
  const what = field ?? 'the input';
  const params = e.params as Record<string, unknown>;
  if (Object.hasOwn(LIMIT_WORDS, e.keyword)) return `${what} ${LIMIT_WORDS[e.keyword]} ${String(params.limit)}`;
  switch (e.keyword) {
    case 'additionalProperties':
      return `${what} is not a field of this request`;
    case 'required':
      return `${what} is required`;
    case 'type':
      return `${what} must be of type ${String(params.type)}`;
    case 'anyOf': {
      const keys = errors.filter((x) => x.keyword === 'required' && inBranch(x)).map((x) => (x.params as { missingProperty?: string }).missingProperty);
      return keys.length > 0 ? `${what} needs one of ${keys.join(', ')}` : `${what} matches none of the allowed shapes`;
    }
    case 'oneOf':
      return `${what} matches none of the allowed shapes`;
    case 'format':
      return `${what} must be a ${String(params.format)}`;
    default:
      return `${what} is invalid (${e.keyword})`;
  }
}

/**
 * The failure `code` for input that broke its schema, naming the first offending field. `prefix` is
 * the path of the validated value inside the request (a command of a batch), `fallbackField` the
 * name of a scalar input such as a path parameter. Messages never quote the input.
 */
export function inputFailure(code: string, errors: readonly IValidationError[] | null, prefix: readonly string[] = [], fallbackField?: string): AuthzAdminFailure {
  const e = primary(errors ?? []);
  if (!e) return new AuthzAdminFailure(code, 'the input is invalid', fallbackField);
  const path = [...prefix, ...pathOf(e)];
  const field = path.length > 0 ? path.join('.') : fallbackField;
  return new AuthzAdminFailure(code, describe(e, field, errors ?? []), field);
}

const PARAM_ID = 'authz.admin.param.';

/**
 * `@OnError` handler of the admin routes for the arguments stage (D2): input that breaks its schema
 * answers the route's `{ error: { code, field } }`, as AuthzAdmin's own refusals do.
 * - ValidationFailed of a body or a path parameter: 400 invalid_request.
 * - InvalidArgument (a body that is not JSON): 400 invalid_request.
 * - AuthzAdminFailure from the query, batch and body args: its code and status.
 * - UnknownAuthzDomain: 403 unknown_domain.
 */
export function adminInputAnswer(err: Error): Response | undefined {
  if (err instanceof AuthzAdminFailure) return refused(err);
  if (err instanceof UnknownAuthzDomain) return respond(403, { error: { code: 'unknown_domain', message: err.message } });
  if (err instanceof ValidationFailed) {
    const id = (err.schema as { $id?: unknown } | undefined)?.$id;
    const param = typeof id === 'string' && id.startsWith(PARAM_ID) ? id.slice(PARAM_ID.length) : undefined;
    return refused(inputFailure('invalid_request', err.parameter, [], param));
  }
  if (err instanceof InvalidArgument) return refused(new AuthzAdminFailure('invalid_request', 'the body must be a JSON object'));
  return undefined;
}

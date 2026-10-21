import { PERMISSION_MAX_LENGTH, fieldNameField, fieldSchema, idField, typeField } from '@spinajs/authz';
import { Parameter, ParameterType, Route } from '@spinajs/http';

/** ckit's default `maxChecks`. */
export const MAX_ACCESS_CHECKS = 100;

/** `POST /user/access/checks` body: only the list is validated, never its entries: a malformed entry, even a non-object, is answered false (see CLIENT_CHECK_SCHEMA). */
export const ACCESS_CHECKS_SCHEMA = fieldSchema('authz.http.accessChecks', { type: 'array', maxItems: MAX_ACCESS_CHECKS } as const);

/** One `checks[]` entry. Unknown keys are tolerated, as ckit's clients may send more; `subject` is compared with the caller, not validated. */
export const CLIENT_CHECK_SCHEMA = fieldSchema('authz.http.clientCheck', {
  type: 'object',
  required: ['object', 'permission'],
  properties: {
    object: { type: 'object', required: ['type', 'id'], properties: { type: typeField, id: idField } },
    permission: { type: 'string', minLength: 1, maxLength: PERMISSION_MAX_LENGTH },
    context: { type: 'object', properties: { field: fieldNameField, fieldMode: { enum: ['read', 'write'] } } },
  },
} as const);

export type AccessChecksBody = readonly unknown[];

/** The validated `checks` list as a route argument. */
export function AccessChecks(): ReturnType<typeof Route> {
  return Route(Parameter(ParameterType.FromBody, ACCESS_CHECKS_SCHEMA, { required: true }));
}

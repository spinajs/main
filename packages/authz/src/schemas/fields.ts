import AjvModule from 'ajv';
import type { Options, ValidateFunction } from 'ajv';
import { InvalidArgument } from '@spinajs/exceptions';

import { PERMISSION_MAX_LENGTH, PERMISSION_PATTERN } from '../contracts/permission.js';

/**
 * Field schemas shared by the authz packages: DTOs embed them under `properties`, services and middlewares check a single
 * value with `isValidField`. The fragments carry no `$id`, because ajv refuses one `$id` twice in a schema; `bodyOf` and
 * `fieldSchema` add an `authz.` id, which the validation package checks without coercion.
 */

const ID_PREFIX = 'authz.';

/** authz-http-admin's list page limit. */
const MAX_PAGE_LIMIT = 500;

const bounded = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength }) as const;

/** A resource or principal id; the longest id column of the authz stores. */
export const idField = bounded(160);
/** A resource or principal type. */
export const typeField = bounded(64);
/** A role, set or rule name. */
export const nameField = bounded(128);
/** A field name of a field-level check. */
export const fieldNameField = bounded(128);
export const permissionField = { type: 'string', maxLength: PERMISSION_MAX_LENGTH, pattern: PERMISSION_PATTERN.source } as const;
export const reasonField = bounded(512, 0);
export const idempotencyKeyField = bounded(128);
/** A share link token, as the link store looks it up. */
export const linkTokenField = bounded(512);
/** A token presented in an `authz.http.services` header. */
export const serviceTokenField = bounded(1024);
/** A cache invalidation tag of an authz change; the empty tag is allowed, as it always was. */
export const changeTagField = bounded(256, 0);
export const changeTagsField = { type: 'array', maxItems: 1000, items: changeTagField } as const;

export const resourceRefField = { type: 'object', additionalProperties: false, required: ['type'], properties: { type: typeField, id: idField } } as const;
export const principalRefField = { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: typeField, id: idField } } as const;
export const pageField = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 0, maximum: MAX_PAGE_LIMIT }, offset: { type: 'integer', minimum: 0 }, after: bounded(512) },
} as const;
export const writeOptionsField = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: reasonField, idempotencyKey: idempotencyKeyField, dryRun: { type: 'boolean' } },
} as const;

function checkedId(id: string): string {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX) || id.length === ID_PREFIX.length) {
    throw new InvalidArgument(`authz schema id ${JSON.stringify(id)} must start with '${ID_PREFIX}'`);
  }
  return id;
}

/** A closed object schema (unknown keys are refused) with an `authz.` `$id`. */
export function bodyOf(required: readonly string[], properties: Record<string, object>, id: string): object {
  return { $id: checkedId(id), type: 'object', additionalProperties: false, required: [...required], properties: { ...properties } };
}

/** `field` as a schema of its own, with an `authz.` `$id`. */
export function fieldSchema<T extends object>(id: string, field: T): T & { readonly $id: string } {
  return { $id: checkedId(id), ...field };
}

export const AUTHZ_FIELD_SCHEMAS = Object.freeze({
  id: fieldSchema('authz.field.id', idField),
  type: fieldSchema('authz.field.type', typeField),
  name: fieldSchema('authz.field.name', nameField),
  fieldName: fieldSchema('authz.field.fieldName', fieldNameField),
  permission: fieldSchema('authz.field.permission', permissionField),
  reason: fieldSchema('authz.field.reason', reasonField),
  idempotencyKey: fieldSchema('authz.field.idempotencyKey', idempotencyKeyField),
  linkToken: fieldSchema('authz.field.linkToken', linkTokenField),
  serviceToken: fieldSchema('authz.field.serviceToken', serviceTokenField),
  changeTags: fieldSchema('authz.field.changeTags', changeTagsField),
  resourceRef: fieldSchema('authz.field.resourceRef', resourceRefField),
  principalRef: fieldSchema('authz.field.principalRef', principalRefField),
  page: fieldSchema('authz.field.page', pageField),
  writeOptions: fieldSchema('authz.field.writeOptions', writeOptionsField),
});

interface AjvLike {
  compile(schema: object): ValidateFunction;
}

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (opts: Options) => AjvLike;
let ajv: AjvLike | undefined;
const compiled = new WeakMap<object, ValidateFunction>();

/** Whether `value` matches `schema`, without coercion, defaults or a container. */
export function isValidField(schema: object, value: unknown): boolean {
  let fn = compiled.get(schema);
  if (!fn) {
    ajv ??= new Ajv({ logger: false, allErrors: false, addUsedSchema: false });
    fn = ajv.compile(schema);
    compiled.set(schema, fn);
  }
  return fn(value) === true;
}

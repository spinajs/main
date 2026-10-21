import AjvModule from 'ajv';
import type { Options, ValidateFunction } from 'ajv';
import { InvalidArgument } from '@spinajs/exceptions';

import { PASSWORD_HARD_CAP } from '../contracts/password.js';

/**
 * Field schemas shared by the authn packages: DTOs embed them under `properties`, services check a single value with
 * `isValidField`. The fragments carry no `$id`, because ajv refuses one `$id` twice in a schema (`password` and
 * `confirmPassword`); `bodyOf` and `fieldSchema` add an `authn.` id, which the validation package checks without coercion.
 */

const ID_PREFIX = 'authn.';

const bounded = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength }) as const;

export const loginField = bounded(PASSWORD_HARD_CAP);
export const passwordField = bounded(PASSWORD_HARD_CAP);
export const secretField = passwordField;
export const codeField = passwordField;
export const reauthPasswordField = passwordField;
/** A presented access token (`authn.token`), before it is hashed. */
export const tokenSecretField = passwordField;
/** A token's uuid. */
export const tokenIdField = bounded(64);
export const sessionHandleField = bounded(128);
export const mfaStepField = bounded(64);
/** Fits a WebAuthn assertion as JSON text. */
export const mfaResponseField = bounded(65536);
/** `authn_identity` column width. */
export const oidcSubjectField = bounded(255);
export const oidcGroupField = { type: 'string', maxLength: 255 } as const;
export const oidcGroupsField = { type: 'array', maxItems: 256, items: oidcGroupField } as const;
export const kidField = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' } as const;
export const isoInstantField = { type: 'string', format: 'date-time', maxLength: 40 } as const;
export const identityRefField = {
  oneOf: [bounded(256), { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: bounded(64), id: bounded(256) } }],
} as const;

function checkedId(id: string): string {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX) || id.length === ID_PREFIX.length) {
    throw new InvalidArgument(`authn schema id ${JSON.stringify(id)} must start with '${ID_PREFIX}'`);
  }
  return id;
}

/** A closed object schema (unknown keys are refused) with an `authn.` `$id`. */
export function bodyOf(required: readonly string[], properties: Record<string, object>, id: string): object {
  return { $id: checkedId(id), type: 'object', additionalProperties: false, required: [...required], properties: { ...properties } };
}

/** `field` as a schema of its own, with an `authn.` `$id`. */
export function fieldSchema<T extends object>(id: string, field: T): T & { readonly $id: string } {
  return { $id: checkedId(id), ...field };
}

export const AUTHN_FIELD_SCHEMAS = Object.freeze({
  login: fieldSchema('authn.field.login', loginField),
  password: fieldSchema('authn.field.password', passwordField),
  secret: fieldSchema('authn.field.secret', secretField),
  code: fieldSchema('authn.field.code', codeField),
  reauthPassword: fieldSchema('authn.field.reauthPassword', reauthPasswordField),
  tokenSecret: fieldSchema('authn.field.tokenSecret', tokenSecretField),
  tokenId: fieldSchema('authn.field.tokenId', tokenIdField),
  sessionHandle: fieldSchema('authn.field.sessionHandle', sessionHandleField),
  mfaStep: fieldSchema('authn.field.mfaStep', mfaStepField),
  mfaResponse: fieldSchema('authn.field.mfaResponse', mfaResponseField),
  oidcSubject: fieldSchema('authn.field.oidcSubject', oidcSubjectField),
  oidcGroups: fieldSchema('authn.field.oidcGroups', oidcGroupsField),
  kid: fieldSchema('authn.field.kid', kidField),
  isoInstant: fieldSchema('authn.field.isoInstant', isoInstantField),
  identityRef: fieldSchema('authn.field.identityRef', identityRefField),
});

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const isDateTime = (s: string): boolean => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s));

/** What a value that passed `isValidField(schema)` is, as far as the type system can tell. */
export type FieldValue<S> = S extends { readonly type: 'string' } ? string : S extends { readonly type: 'array' } ? readonly unknown[] : S extends { readonly type: 'object' } ? Readonly<Record<string, unknown>> : unknown;

interface AjvLike {
  compile(schema: object): ValidateFunction;
}

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (opts: Options) => AjvLike;
let ajv: AjvLike | undefined;
const compiled = new WeakMap<object, ValidateFunction>();

/**
 * Whether `value` matches `schema`, without coercion, defaults or a container: services that can be called outside a
 * controller check their input against the same fields the DTOs use.
 */
export function isValidField<S extends object>(schema: S, value: unknown): value is FieldValue<S> {
  let fn = compiled.get(schema);
  if (!fn) {
    ajv ??= new Ajv({ logger: false, allErrors: false, addUsedSchema: false, formats: { 'date-time': isDateTime } });
    fn = ajv.compile(schema);
    compiled.set(schema, fn);
  }
  return fn(value) === true;
}

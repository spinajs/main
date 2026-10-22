import { idField, idempotencyKeyField, nameField, principalRefField, reasonField, typeField } from '@spinajs/authz';

export type JsonSchema = Record<string, unknown>;

export const text: JsonSchema = { type: 'string' };
export const nullableDateTime: JsonSchema = { type: 'string', format: 'date-time', nullable: true, description: 'ISO 8601 date-time with Z or an offset, read as a Date; null clears the expiry' };
export const tags: JsonSchema = { type: 'array', items: text };
export const anyObject: JsonSchema = { type: 'object', additionalProperties: true };
export const rowId: JsonSchema = { ...idField };
export const roleName: JsonSchema = { ...nameField };

export const resourceRef: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: { type: { ...typeField }, id: { ...idField, description: 'absent for a type-level scope' } },
};

export const principalRef: JsonSchema = { ...principalRefField, properties: { ...principalRefField.properties } };

export function obj(required: readonly string[], properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { type: 'object', ...(description ? { description } : {}), ...(required.length ? { required } : {}), properties };
}

/** An object that refuses keys it does not list. */
export function closed(required: readonly string[], properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { ...obj(required, properties, description), additionalProperties: false };
}

export const roleSet: JsonSchema = closed(['role', 'scope'], { role: roleName, scope: resourceRef });

export const subjectSet: JsonSchema = closed(['set'], { set: roleSet });

export const assignmentSubject: JsonSchema = { description: 'A principal, or the holders of a role at a scope', oneOf: [principalRef, subjectSet] };

export const writeOptions: Record<string, JsonSchema> = {
  reason: { ...reasonField, description: 'goes to the audit trail' },
  idempotencyKey: { ...idempotencyKeyField, description: 'a retried request with the same key returns the first result' },
  dryRun: { type: 'boolean', description: 'validate and guard, then roll back' },
};

/** The body of POST /authz/commands with `items` as the schema of one command. */
export function batchOf(items: JsonSchema): JsonSchema {
  return closed(['commands'], { commands: { type: 'array', items }, ...writeOptions }, 'POST /authz/commands: the commands run in one transaction, in order; the first failure rolls the batch back');
}

/** The body of POST /authz/commands over the given command schemas. */
export function commandBatch(commands: readonly JsonSchema[]): JsonSchema {
  return batchOf({ oneOf: commands });
}

export function command(kind: string, required: readonly string[], properties: Record<string, JsonSchema>, description: string): JsonSchema {
  return closed(['kind', ...required], { kind: { type: 'string', enum: [kind] }, ...properties }, description);
}

export type JsonSchema = Record<string, unknown>;

export const text: JsonSchema = { type: 'string' };
export const nullableDateTime: JsonSchema = { type: 'string', format: 'date-time', nullable: true, description: 'ISO 8601 date-time with Z or an offset, read as a Date; null clears the expiry' };
export const tags: JsonSchema = { type: 'array', items: text };
export const anyObject: JsonSchema = { type: 'object', additionalProperties: true };

export const resourceRef: JsonSchema = {
  type: 'object',
  required: ['type'],
  properties: { type: text, id: { ...text, description: 'absent for a type-level scope' } },
};

export const principalRef: JsonSchema = {
  type: 'object',
  required: ['type', 'id'],
  properties: { type: text, id: text },
};

export const roleSet: JsonSchema = { type: 'object', required: ['role', 'scope'], properties: { role: text, scope: resourceRef } };

export const subjectSet: JsonSchema = { type: 'object', required: ['set'], properties: { set: roleSet } };

export const assignmentSubject: JsonSchema = { description: 'A principal, or the holders of a role at a scope', oneOf: [principalRef, subjectSet] };

export function obj(required: readonly string[], properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { type: 'object', ...(description ? { description } : {}), ...(required.length ? { required } : {}), properties };
}

const writeOptions = {
  reason: { ...text, description: 'goes to the audit trail' },
  idempotencyKey: { ...text, description: 'a retried batch with the same key returns the first result' },
  dryRun: { type: 'boolean', description: 'validate and guard, then roll back' },
};

/** The body of POST /authz/commands over the given command schemas. */
export function commandBatch(commands: readonly JsonSchema[]): JsonSchema {
  return obj(['commands'], { commands: { type: 'array', items: { oneOf: commands } }, ...writeOptions }, 'POST /authz/commands: the commands run in one transaction, in order; the first failure rolls the batch back');
}

export function command(kind: string, required: readonly string[], properties: Record<string, JsonSchema>, description: string): JsonSchema {
  return obj(['kind', ...required], { kind: { type: 'string', enum: [kind] }, ...properties }, description);
}

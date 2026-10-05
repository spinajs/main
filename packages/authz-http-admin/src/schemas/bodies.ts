import { commandSchemas, policyBody, ruleBody } from './commands.js';
import { anyObject, assignmentSubject, nullableDateTime, obj, resourceRef, tags, text } from './primitives.js';
import type { JsonSchema } from './primitives.js';

const { id: _ruleId, ...ruleFields } = ruleBody.properties as Record<string, JsonSchema>;
const { id: _policyId, ...policyFields } = policyBody.properties as Record<string, JsonSchema>;

const writeOptions = {
  reason: { ...text, description: 'goes to the audit trail' },
  idempotencyKey: { ...text, description: 'a retried batch with the same key returns the first result' },
  dryRun: { type: 'boolean', description: 'validate and guard, then roll back' },
};

export const AuthzAdminBatch: JsonSchema = obj(
  ['commands'],
  { commands: { type: 'array', items: { oneOf: commandSchemas } }, ...writeOptions },
  'POST /authz/commands: the commands run in one transaction, in order; the first failure rolls the batch back',
);

export const AuthzAssignmentGrant: JsonSchema = obj(
  ['subject', 'role', 'scope'],
  { subject: assignmentSubject, role: text, scope: resourceRef, tags, expiresAt: nullableDateTime, replaceLadder: { type: 'boolean' } },
  'POST /authz/assignments: the fields of assignment.grant (reason, idempotencyKey and dryRun go in the query string)',
);

export const AuthzAssignmentPatch: JsonSchema = obj(
  [],
  { tags: { ...tags, description: 'replaces the tags' }, addTags: tags, removeTags: tags, expiresAt: nullableDateTime },
  'PATCH /authz/assignments/{id}: at least one key; the keys run as assignment.setTags, addTags, removeTags and setExpiry in one batch',
);

export const AuthzRuleBody: JsonSchema = obj(['kind', 'scope'], ruleFields, 'PUT /authz/rules/{id}: a rule; an `id` in the body must equal the path id');
export const AuthzPolicyBody: JsonSchema = obj(['effect', 'permissions'], policyFields, 'PUT /authz/policies/{id}: a policy; an `id` in the body must equal the path id');
export const AuthzAttributesPatch: JsonSchema = { ...anyObject, description: 'PATCH /authz/scopes/{type}/{id}/attributes: deep merge; null deletes a path' };
export const AuthzAttributesBody: JsonSchema = { ...anyObject, description: 'PUT /authz/scopes/{type}/{id}/attributes: replaces all attributes' };

const errorShape = obj(['code', 'message'], { code: text, message: text, field: { ...text, description: 'the offending field, when one is known' } });

export const AuthzAdminError: JsonSchema = obj(
  ['error'],
  { error: errorShape },
  'The body of a refused request. Codes: invalid_request, invalid_query, unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable, invalid_attributes (400); forbidden, escalation, last_holder, self_lockout, protected_role (403); not_found (404); conflict (409)',
);

const commandResult: JsonSchema = {
  oneOf: [
    obj(['ok', 'kind', 'affected'], { ok: { type: 'boolean', enum: [true] }, kind: text, id: text, token: { ...text, description: 'link.create only, shown once' }, affected: { type: 'integer' } }),
    obj(['ok', 'kind', 'error'], { ok: { type: 'boolean', enum: [false] }, kind: text, error: errorShape }),
  ],
};

export const AuthzCommandResult: JsonSchema = { ...commandResult, description: 'The outcome of one command' };

export const AuthzAdminResults: JsonSchema = obj(
  ['results'],
  { results: { type: 'array', items: commandResult, description: 'one per command, in order; the first failure ends the list' } },
  'The answer of a write route: 200 when every command succeeded, else the status of the first failure, with the same body',
);

export const AuthzAdminPage: JsonSchema = obj(
  ['items', 'total'],
  { items: { type: 'array', items: anyObject }, total: { type: 'integer', description: 'rows matching before paging' } },
  'The answer of a list route',
);

export const AuthzAdminAttributes: JsonSchema = { ...anyObject, description: 'The attributes of a scope' };

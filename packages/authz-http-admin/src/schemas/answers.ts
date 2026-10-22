import { anyObject, obj, text } from './primitives.js';
import type { JsonSchema } from './primitives.js';

const errorShape = obj(['code', 'message'], { code: text, message: text, field: { ...text, description: 'the offending field, when one is known' } });

export const AuthzAdminError: JsonSchema = obj(['error'], { error: errorShape }, 'The body of a refused request. Codes: invalid_request, invalid_query, invalid_batch, invalid_command, unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable, invalid_attributes, set_cycle, set_too_deep (400); forbidden, escalation, last_holder, self_lockout, protected_role (403); not_found (404); conflict (409)');

const commandResult: JsonSchema = {
  oneOf: [obj(['ok', 'kind', 'affected'], { ok: { type: 'boolean', enum: [true] }, kind: text, id: text, token: { ...text, description: 'link.create only, shown once' }, affected: { type: 'integer' } }), obj(['ok', 'kind', 'error'], { ok: { type: 'boolean', enum: [false] }, kind: text, error: errorShape })],
};

export const AuthzCommandResult: JsonSchema = { ...commandResult, description: 'The outcome of one command' };

export const AuthzAdminResults: JsonSchema = obj(['results'], { results: { type: 'array', items: commandResult, description: 'one per command, in order; the first failure ends the list' } }, 'The answer of a write route: 200 when every command succeeded, else the status of the first failure, with the same body');

export const AuthzAdminPage: JsonSchema = obj(['items', 'total'], { items: { type: 'array', items: anyObject }, total: { type: 'integer', description: 'rows matching before paging' }, next: { type: 'string', description: 'pass it as `after` to read the following page; absent on the last page and on offset pages' } }, 'The answer of a list route');

export const AuthzAdminAttributes: JsonSchema = { ...anyObject, description: 'The attributes of a scope' };

import { anyObject, assignmentSubject, command, nullableDateTime, obj, principalRef, resourceRef, roleSet, tags, text } from './primitives.js';
import type { JsonSchema } from './primitives.js';

const idOnly = { id: { ...text, description: 'the id of the row' } };

/** A rule as `rule.put` takes it; the condition language is described by @spinajs/authz. */
export const ruleBody: JsonSchema = obj(
  ['id', 'kind', 'scope'],
  {
    id: text,
    kind: { type: 'string', enum: ['restrict', 'cap', 'threshold'] },
    scope: resourceRef,
    resourceTypes: { type: 'array', items: text },
    subjects: { ...anyObject, description: 'SubjectSelector: principalTypes, actorTypes, refs, rank, when' },
    when: { ...anyObject, description: 'a Condition' },
    expiresAt: nullableDateTime,
    allow: { type: 'array', items: assignmentSubject },
    ladder: text,
    maxRole: { description: 'a role id, { ref } or null (drops the assignment)', nullable: true, oneOf: [text, anyObject] },
    stripTags: { type: 'boolean' },
    assignments: anyObject,
    permissions: { type: 'array', items: text },
    resource: { ...anyObject, description: 'a Condition on the resource' },
    minRole: { description: 'a role id or { ref }', oneOf: [text, anyObject] },
    at: text,
    reason: { ...anyObject, description: 'DenyReason: code, payload, priority, sortKey' },
  },
  'A RBAC rule in SQL form; the server sets `source`',
);

/** A policy as `policy.put` takes it. */
export const policyBody: JsonSchema = obj(
  ['id', 'effect', 'permissions'],
  {
    id: text,
    effect: { type: 'string', enum: ['permit', 'deny'] },
    permissions: { type: 'array', items: text, description: 'permission globs' },
    resourceTypes: { type: 'array', items: text },
    principalTypes: { type: 'array', items: text },
    actorTypes: { type: 'array', items: text },
    scope: resourceRef,
    when: { ...anyObject, description: 'a Condition' },
    fields: { ...anyObject, description: 'a FieldSet' },
    reason: text,
    priority: { type: 'integer', description: 'default 500' },
    expiresAt: nullableDateTime,
  },
  'An ABAC policy; the server sets `source`',
);

/** The command kinds of AuthzCommand (packages/authz/src/contracts/admin.ts), in declaration order. */
export const COMMAND_KINDS = [
  'assignment.grant',
  'assignment.revoke',
  'assignment.revokeWhere',
  'assignment.setTags',
  'assignment.addTags',
  'assignment.removeTags',
  'assignment.setExpiry',
  'set.addMember',
  'set.removeMember',
  'link.create',
  'link.update',
  'link.revoke',
  'rule.put',
  'rule.delete',
  'policy.put',
  'policy.delete',
  'scope.setAttributes',
  'scope.replaceAttributes',
  'scope.forget',
] as const;

export const commandSchemas: readonly JsonSchema[] = [
  command('assignment.grant', ['subject', 'role', 'scope'], { subject: assignmentSubject, role: text, scope: resourceRef, tags, expiresAt: nullableDateTime, replaceLadder: { type: 'boolean', description: "revoke the subject's other roles of the same ladder at this scope" } }, 'Grants a role to a subject at a scope'),
  command('assignment.revoke', ['id'], idOnly, 'Revokes one assignment'),
  command('assignment.revokeWhere', ['scope'], { scope: resourceRef, subject: assignmentSubject, role: text }, 'Revokes the assignments at a scope, narrowed by subject and role'),
  command('assignment.setTags', ['id', 'tags'], { ...idOnly, tags }, 'Replaces the tags of an assignment'),
  command('assignment.addTags', ['id', 'tags'], { ...idOnly, tags }, 'Adds tags to an assignment'),
  command('assignment.removeTags', ['id', 'tags'], { ...idOnly, tags }, 'Removes tags from an assignment'),
  command('assignment.setExpiry', ['id', 'expiresAt'], { ...idOnly, expiresAt: nullableDateTime }, 'Sets or clears the expiry of an assignment'),
  command('set.addMember', ['set', 'member'], { set: roleSet, member: principalRef, expiresAt: nullableDateTime }, 'Adds a principal to a subject set (group.member at group:G)'),
  command('set.removeMember', ['set', 'member'], { set: roleSet, member: principalRef }, 'Removes a principal from a subject set'),
  command('link.create', ['scope', 'role'], { scope: resourceRef, role: text, tags, expiresAt: nullableDateTime, attributes: anyObject }, 'Creates a share link; the answer carries its token, shown once'),
  command('link.update', ['id'], { ...idOnly, expiresAt: nullableDateTime, attributes: anyObject, role: text, tags }, 'Changes a share link'),
  command('link.revoke', ['id'], idOnly, 'Revokes a share link'),
  command('rule.put', ['rule'], { rule: ruleBody }, 'Inserts or replaces a RBAC rule by id'),
  command('rule.delete', ['id'], idOnly, 'Deletes a RBAC rule'),
  command('policy.put', ['policy'], { policy: policyBody }, 'Inserts or replaces an ABAC policy by id'),
  command('policy.delete', ['id'], idOnly, 'Deletes an ABAC policy'),
  command('scope.setAttributes', ['scope', 'patch'], { scope: resourceRef, patch: { ...anyObject, description: 'deep merge; null deletes a path' } }, 'Merges a patch into the attributes of a scope'),
  command('scope.replaceAttributes', ['scope', 'attributes'], { scope: resourceRef, attributes: anyObject }, 'Replaces the attributes of a scope'),
  command('scope.forget', ['scope'], { scope: resourceRef }, 'Removes everything held AT a scope node (assignments, links, rules, policies, attributes)'),
];

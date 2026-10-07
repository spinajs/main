import { ROLE_NAME_MAX_LENGTH, ROLE_NAME_PATTERN } from '@spinajs/authz';

import { DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS } from '../model/cache.js';
import { DEFAULT_GROUP_PRINCIPAL } from '../model/sets/resolver.js';

const name = { type: 'string', minLength: 1 };
const stringList = { type: 'array', items: name };
const roleName = { type: 'string', pattern: ROLE_NAME_PATTERN, maxLength: ROLE_NAME_MAX_LENGTH };
const roleList = { type: 'array', items: roleName };

// propertyNames rejects an unknown key; additionalProperties: false would let the configuration's removeAdditional drop a typo silently.
const closed = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  propertyNames: { enum: Object.keys(properties) },
  ...(required ? { required } : {}),
});

const grant = {
  anyOf: [
    name,
    closed(
      {
        permission: name,
        relation: { anyOf: [name, stringList] },
        on: { type: 'array', items: closed({ type: name, id: { type: 'string' } }, ['type']) },
        fields: closed({ read: stringList, write: stringList, hide: stringList }),
        requiresTag: name,
        grantedAt: stringList,
      },
      ['permission'],
    ),
  ],
};

const role = closed({
  ladder: name,
  extends: roleList,
  grants: { type: 'array', items: grant },
  revoke: stringList,
  implies: {
    type: 'array',
    items: closed(
      {
        role: roleName,
        at: { type: 'string', enum: ['self-and-descendants', 'descendants'] },
        tags: stringList,
        bypass: { type: 'array', items: { type: 'string', enum: ['restrict', 'cap'] } },
      },
      ['role', 'at'],
    ),
  },
  subjectSet: { type: 'boolean' },
  assignable: { type: 'boolean' },
  scopeTypes: stringList,
  description: { type: 'string' },
});

const ruleNames = { type: 'array', items: name, minItems: 1 };
const ref = closed({ type: name, id: name }, ['type']);
const principalRef = closed({ type: name, id: name }, ['type', 'id']);
const valueRef = closed({ ref: name }, ['ref']);
// Conditions are checked by the condition parser, which knows the registered functions.
const condition = { type: 'object' };
const RULE_KINDS = ['restrict', 'cap', 'threshold'];

// A rule without a scope applies at $global (ConfigRuleStore fills it in). A bare type is on the path of a list only,
// never of a check, so lists and checks would disagree; $global with an id is no node at all.
const ruleScope = { ...ref, if: { not: { required: ['id'] } }, then: { properties: { type: { const: '$global' } } }, else: { properties: { type: { not: { const: '$global' } } } } };

const ruleSubjects = closed({
  principalTypes: ruleNames,
  actorTypes: ruleNames,
  refs: { type: 'array', items: principalRef, minItems: 1 },
  rank: { ...closed({ ladder: name, at: name, lt: roleName, eq: roleName, gte: roleName }, ['ladder', 'at']), oneOf: [{ required: ['lt'] }, { required: ['eq'] }, { required: ['gte'] }] },
  when: condition,
});

const ruleCommon = {
  id: name,
  kind: { type: 'string', enum: RULE_KINDS },
  scope: ruleScope,
  resourceTypes: ruleNames,
  subjects: ruleSubjects,
  when: condition,
  // ajv-formats 2 takes a date-time without a timezone, which Date.parse reads as local time.
  expiresAt: { anyOf: [{ type: ['string', 'null'], format: 'date-time', pattern: '(?:[zZ]|[+-]\\d\\d:?\\d\\d)$' }, { instanceof: 'Date' }] },
  source: { type: 'string' },
};

// One key set per kind (design §5.8).
const ruleOf = (kind: string, properties: Record<string, unknown>, extra: Record<string, unknown>) => ({
  if: { properties: { kind: { const: kind } } },
  then: { ...closed({ ...ruleCommon, ...properties }), ...extra },
});

/** A config RuleDef (design §5.8), the former RULE_SCHEMA of ConfigRuleStore. */
const rule = {
  type: 'object',
  properties: { id: name, kind: { type: 'string', enum: RULE_KINDS }, scope: ruleScope },
  required: ['id', 'kind'],
  allOf: [
    ruleOf('restrict', { allow: { type: 'array', items: { anyOf: [principalRef, closed({ set: closed({ role: roleName, scope: ref }, ['role', 'scope']) }, ['set'])] } } }, { required: ['allow'] }),
    ruleOf(
      'cap',
      {
        ladder: name,
        maxRole: { anyOf: [{ type: ['string', 'null'], pattern: ROLE_NAME_PATTERN, maxLength: ROLE_NAME_MAX_LENGTH }, valueRef] },
        stripTags: { type: 'boolean' },
        assignments: closed({ scopeTypes: ruleNames, subjectTypes: ruleNames }),
      },
      { anyOf: [{ required: ['ladder', 'maxRole'] }, { required: ['stripTags'], properties: { stripTags: { const: true } } }], dependencies: { maxRole: ['ladder'] } },
    ),
    ruleOf(
      'threshold',
      {
        permissions: ruleNames,
        resource: condition,
        minRole: { anyOf: [roleName, valueRef] },
        ladder: name,
        at: name,
        reason: { type: 'object', properties: { code: name, priority: { type: 'number' }, sortKey: { type: 'string' }, model: false }, required: ['code'] },
      },
      { required: ['permissions', 'minRole'], dependencies: { at: ['ladder'] } },
    ),
  ],
};

// Validates the `authz.rbac` subtree: the configuration reads `$configurationModule` with lodash get, so a dotted path
// works and this schema runs next to the core one (`authz`), which leaves `rbac` open. The root stays open for keys of
// other lanes. Store names and migration columns have no default here: they live in code (RBAC_STORE_DEFAULTS, the migrations).
export const AUTHZ_RBAC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-rbac.configuration.schema.json',
  $configurationModule: 'authz.rbac',
  description: 'RBAC configuration (authz.rbac.*)',
  type: 'object',
  properties: {
    roles: { type: 'object', propertyNames: roleName, additionalProperties: role },
    ladders: { type: 'object', propertyNames: name, additionalProperties: closed({ roles: roleList, resourceTypes: stringList }, ['roles']) },
    rules: { type: 'array', items: rule, uniqueItemProperties: ['id'] },
    // null turns the group member set off; a key left out keeps its default.
    groupPrincipal: {
      type: ['object', 'null'],
      default: {},
      properties: { role: { ...roleName, default: DEFAULT_GROUP_PRINCIPAL.role }, scopeType: { ...name, default: DEFAULT_GROUP_PRINCIPAL.scopeType } },
      propertyNames: { enum: ['role', 'scopeType'] },
    },
    // create() used to trim; a padded name now fails the boot instead.
    defaultRoles: roleList,
    anonymousRoles: { ...roleList, default: [] },
    serviceRoles: { type: 'object', additionalProperties: roleList, default: {} },
    stores: { type: 'object', properties: { roles: stringList, assignments: stringList, rules: stringList, links: stringList } },
    cache: {
      type: 'object',
      default: {},
      properties: {
        assignmentsTtlSeconds: { type: 'number', minimum: 0, default: DEFAULT_ASSIGNMENTS_TTL_SECONDS },
        maxSubjects: { type: 'integer', minimum: 0, default: DEFAULT_MAX_CACHED_SUBJECTS },
        rolesCheckSeconds: { type: 'number', minimum: 0, default: DEFAULT_ROLES_CHECK_SECONDS },
      },
      // coerceTypes would read a null as 0, which turns the role version check off. `if` sees the raw value; `const`, unlike
      // `type: 'null'`, coerces nothing (that would turn a 0 into null).
      if: { properties: { rolesCheckSeconds: { const: null } }, required: ['rolesCheckSeconds'] },
      then: { properties: { rolesCheckSeconds: false } },
    },
    migration: { type: 'object', properties: { roleColumn: name, idColumn: name } },
    links: { type: 'object', properties: { secret: { type: 'string', minLength: 32 } } },
    connection: name,
  },
};

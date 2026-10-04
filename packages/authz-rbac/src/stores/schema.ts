const name = { type: 'string', minLength: 1 };
const stringList = { type: 'array', items: name };

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
  extends: stringList,
  grants: { type: 'array', items: grant },
  revoke: stringList,
  implies: {
    type: 'array',
    items: closed(
      {
        role: name,
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

// Validates the `authz.rbac` subtree: the configuration reads `$configurationModule` with lodash get, so a dotted path
// works and this schema runs next to the core one (`authz`), which leaves `rbac` open.
// The root stays open for keys of other lanes; no `default` keywords: defaults live in code and in config/rbac-stores.
export const AUTHZ_RBAC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-rbac.configuration.schema.json',
  $configurationModule: 'authz.rbac',
  description: 'RBAC configuration (authz.rbac.*)',
  type: 'object',
  properties: {
    roles: { type: 'object', propertyNames: name, additionalProperties: role },
    ladders: { type: 'object', propertyNames: name, additionalProperties: closed({ roles: stringList, resourceTypes: stringList }, ['roles']) },
    // L1b owns the rule schema
    rules: { type: 'array', items: { type: 'object' } },
    groupPrincipal: closed({ role: name, scopeType: name }, ['role', 'scopeType']),
    defaultRoles: stringList,
    anonymousRoles: stringList,
    serviceRoles: { type: 'object', additionalProperties: stringList },
    stores: { type: 'object', properties: { roles: stringList, assignments: stringList, rules: stringList, links: stringList } },
    cache: { type: 'object', properties: { assignmentsTtlSeconds: { type: 'number', minimum: 0 } } },
    migration: { type: 'object', properties: { roleColumn: name, idColumn: name } },
    links: { type: 'object', properties: { secret: { type: 'string', minLength: 32 } } },
    connection: name,
  },
};

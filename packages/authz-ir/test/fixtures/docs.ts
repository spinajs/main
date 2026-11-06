import type { PolicyIR } from '../../src/index.js';

const rebac = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;

/** Folders under the `$global` root, docs under folders, groups with nested membership, two caveats. */
export function docsIR(): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      $global: { relations: { admin: { allowed: ['user'], source: { kind: 'tuples', store: 'authz_assignment' } } }, permissions: {} },
      group: { relations: { member: { allowed: ['user', 'group#member'], source: rebac } }, permissions: {} },
      folder: {
        relations: {
          parent: { allowed: ['$global'], source: { kind: 'ancestor', via: 'folder' } },
          owner: { allowed: ['user'], source: rebac },
          viewer: { allowed: ['user', 'group#member', 'user:*'], source: rebac },
        },
        permissions: { view: { union: [{ computed: 'viewer' }, { computed: 'owner' }, { tupleToUserset: { tupleset: 'parent', computed: 'admin' } }] } },
      },
      doc: {
        relations: {
          parent: { allowed: ['folder'], source: { kind: 'column', model: 'Doc', column: 'folder_id' } },
          owner: { allowed: ['user'], source: { kind: 'column', model: 'Doc', column: 'author_id' } },
          editor: { allowed: ['user', { type: 'user', caveat: 'office_hours' }], source: rebac },
          banned: { allowed: ['user'], source: rebac },
        },
        permissions: {
          edit: { union: [{ computed: 'owner' }, { computed: 'editor' }] },
          view: { exclusion: { base: { union: [{ computed: 'edit' }, { tupleToUserset: { tupleset: 'parent', computed: 'view' } }] }, subtract: { computed: 'banned' } } },
          publish: { caveat: 'not_frozen', of: { computed: 'edit' } },
        },
      },
    },
    permissions: {
      'doc:read': { type: 'doc', relation: 'view', list: true, source: { origin: 'config:authz.rebac.permissions' } },
      'doc:update': { type: 'doc', relation: 'edit', list: false, source: { origin: 'config:authz.rebac.permissions' } },
      'doc:publish': { type: 'doc', relation: 'publish', list: false, source: { origin: 'config:authz.rebac.permissions' } },
      'folder:read': { type: 'folder', relation: 'view', list: true, source: { origin: 'config:authz.rebac.permissions' } },
    },
    caveats: {
      not_frozen: { params: { 'resource.status': 'string' }, expr: { not: { attr: 'resource.status', eq: 'frozen' } } },
      office_hours: { params: { 'env.hour': 'int' }, expr: { all: [{ attr: 'env.hour', gte: 9 }, { attr: 'env.hour', lt: 17 }] } },
    },
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: true, ancestry: 'parent', roles: { admin: [{ type: '$global', relation: 'admin' }] } },
    opaque: [],
  };
}

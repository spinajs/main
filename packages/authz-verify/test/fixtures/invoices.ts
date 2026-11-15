import type { PolicyIR } from '@spinajs/authz-ir';

const assignment = { kind: 'tuples', store: 'authz_assignment' } as const;
const ancestor = (via: string) => ({ kind: 'ancestor', via }) as const;
const config = { origin: 'config:authz' };

/** The impact summary §3.3 policy: `clerk` on `$global`, `accountant` on orgs, invoices under projects under orgs. */
export function invoicesIR(): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      $global: { relations: { clerk: { allowed: ['user'], source: assignment } }, permissions: {} },
      group: { relations: { member: { allowed: ['user', 'group#member'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } } }, permissions: {} },
      org: {
        relations: { parent: { allowed: ['$global'], source: ancestor('org') }, accountant: { allowed: ['user', 'group#member'], source: assignment } },
        permissions: { clerk: { tupleToUserset: { tupleset: 'parent', computed: 'clerk' } }, can_invoice_read: { computed: 'accountant' }, can_invoice_approve: { computed: 'accountant' } },
      },
      project: {
        relations: { parent: { allowed: ['org'], source: ancestor('project') } },
        permissions: {
          clerk: { tupleToUserset: { tupleset: 'parent', computed: 'clerk' } },
          can_invoice_read: { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } },
          can_invoice_approve: { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_approve' } },
        },
      },
      invoice: {
        relations: {
          parent: { allowed: ['project'], source: { kind: 'column', model: 'Invoice', column: 'project_id' } },
          owner: { allowed: ['user'], source: { kind: 'column', model: 'Invoice', column: 'author_id' } },
          frozen: { allowed: [{ type: 'user:*', caveat: 'status_is_frozen' }], source: { kind: 'tuples', store: 'authz_rebac_tuple' } },
        },
        permissions: {
          clerk: { tupleToUserset: { tupleset: 'parent', computed: 'clerk' } },
          read: { union: [{ tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } }, { intersection: [{ computed: 'clerk' }, { computed: 'owner' }] }] },
          approve: { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_approve' } },
          update: { exclusion: { base: { computed: 'approve' }, subtract: { computed: 'frozen' } } },
        },
      },
    },
    permissions: {
      'invoice:read': { type: 'invoice', relation: 'read', list: true, source: config },
      'invoice:approve': { type: 'invoice', relation: 'approve', list: false, source: config },
      'invoice:update': { type: 'invoice', relation: 'update', list: false, source: config },
    },
    caveats: { status_is_frozen: { params: { 'resource.status': 'string' }, expr: { attr: 'resource.status', eq: 'frozen' } } },
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: true, ancestry: 'parent', roles: { clerk: [{ type: '$global', relation: 'clerk' }], accountant: [{ type: 'org', relation: 'accountant' }] } },
    opaque: [],
  };
}

/** Folders nested in folders to any depth: `view` recurses through `parent->view`, `edit` through `parent->edit`. */
export function foldersIR(): PolicyIR {
  const rebac = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      folder: {
        relations: {
          parent: { allowed: ['folder'], source: ancestor('folder') },
          viewer: { allowed: ['user', 'user:*'], source: rebac },
          edit: { allowed: ['user'], source: rebac },
        },
        permissions: {
          edit: { union: [{ this: true }, { tupleToUserset: { tupleset: 'parent', computed: 'edit' } }] },
          view: { union: [{ computed: 'viewer' }, { computed: 'edit' }, { tupleToUserset: { tupleset: 'parent', computed: 'view' } }] },
          browse: { union: [{ computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'browse' } }] },
        },
      },
    },
    permissions: {
      'folder:read': { type: 'folder', relation: 'view', list: true, source: config },
      'folder:update': { type: 'folder', relation: 'edit', list: false, source: config },
      'folder:browse': { type: 'folder', relation: 'browse', list: false, source: config },
    },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

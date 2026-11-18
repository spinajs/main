import type { PolicyIR } from '@spinajs/authz-ir';

const source = { origin: 'config:authz.abac.policies' };

/**
 * What `abacToIR` and `mergeFragments` give for four policies: `doc:read` permitted to everyone, `doc:update`
 * permitted to principals of type `service`, `doc:delete` permitted to everyone and denied while the doc is frozen.
 */
export function abacIR(): PolicyIR {
  return {
    version: 1,
    types: {
      $global: { relations: {}, permissions: {} },
      doc: {
        relations: { parent: { allowed: ['$global'], source: { kind: 'ancestor', via: '$global' } } },
        permissions: {
          abac_permit_doc_read: { intersection: [] },
          abac_permit_doc_update: { caveat: 'abac_services', of: { intersection: [] } },
          abac_permit_doc_delete: { intersection: [] },
          abac_deny_doc_delete: { caveat: 'abac_frozen', of: { intersection: [] } },
          perm_doc_delete: { exclusion: { base: { computed: 'abac_permit_doc_delete' }, subtract: { computed: 'abac_deny_doc_delete' } } },
        },
      },
    },
    permissions: {
      'doc:read': { type: 'doc', relation: 'abac_permit_doc_read', list: true, source },
      'doc:update': { type: 'doc', relation: 'abac_permit_doc_update', list: false, source },
      'doc:delete': { type: 'doc', relation: 'perm_doc_delete', list: false, source },
    },
    caveats: {
      abac_services: { params: { 'principal.type': 'string' }, expr: { attr: 'principal.type', in: ['service'] } },
      abac_frozen: { params: { 'resource.status': 'string' }, expr: { attr: 'resource.status', eq: 'frozen' } },
    },
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

import { ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { event, linkTags, optionalStore, subjectTag } from './common.js';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore } from './ports.js';

/**
 * scope.forget for RBAC data AT the node: links (with their assignments), assignments, rules, and every grant
 * whose subject is a set living at the node, wherever it is held, so a later node with the same id inherits
 * nothing. A store the domain does not register holds nothing to forget.
 */
@Singleton()
@Injectable(ScopeForgetter)
export class RbacScopeForgetter extends ScopeForgetter {
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const tags = new Set<string>();
    const events: AuthzEvent[] = [];
    let affected = 0;

    const links = await optionalStore(ctx, AdminLinkStore);
    for (const l of (await links?.forgetScope(scope, tx)) ?? []) {
      affected++;
      for (const t of linkTags(l.id)) tags.add(t);
      events.push(event(ctx, 'LinkRevoked', { id: l.id, scope: l.scope }));
    }

    const assignments = await optionalStore(ctx, AdminAssignmentStore);
    for (const a of (await assignments?.forgetScope(scope, tx)) ?? []) {
      affected++;
      tags.add(subjectTag(a.subject));
      events.push(event(ctx, 'RoleRevoked', { id: a.id, subject: a.subject, role: a.role, scope: a.scope }));
    }

    const rules = await optionalStore(ctx, AdminRuleStore);
    for (const r of (await rules?.forgetScope(scope, tx)) ?? []) {
      affected++;
      tags.add(`rule:${r.id}`);
      events.push(event(ctx, 'RuleChanged', { id: r.id, scope: r.scope, op: 'delete' }));
    }

    return { affected, tags: [...tags], events };
  }
}

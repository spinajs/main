import type { AuthzAdminBackend } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

import { DbAuthzAdminBackend } from '../admin/db/backend.js';
import { loadRoleIndex } from '../admin/common.js';
import { AdminAssignmentStore, AdminMembershipStore } from '../admin/ports.js';
import { readMaxSetDepth } from '../membership/closure.js';
import type { MembershipRow } from '../membership/closure.js';
import type { MembershipSources } from '../membership/maintenance.js';
import { rbacStoreNames } from '../stores/defaults.js';
import type { RbacStoreKind } from '../stores/defaults.js';
import { CliUsageError } from './args.js';
import { AuthzCliCommand } from './base.js';

/** What the membership commands work on; tests set it, the CLI resolves it from the root container. */
export interface MembershipCliContext extends Omit<MembershipSources, 'now'> {
  readonly backend: AuthzAdminBackend;
}

export const describeMembershipRow = (r: MembershipRow): string => `${r.memberKey} in ${r.setKey} depth ${r.depth}${r.expiresAt ? ` until ${r.expiresAt.toISOString()}` : ''}`;

/** Outside cli/commands: the Cli takes the first export of each file there as a command. */
export abstract class MembershipCliCommand extends AuthzCliCommand {
  public Membership?: MembershipCliContext;

  /** Call it inside `command()`: booting AuthzService registers the RBAC stores in the root container. */
  protected async membership(): Promise<MembershipCliContext> {
    if (this.Membership) return this.Membership;
    const root = DI.RootContainer;
    const configuration = await DI.resolve(Configuration);
    const store = async <T>(token: Class<T>, kind: RbacStoreKind): Promise<T> => {
      if (root.hasRegistered(token)) return (await root.resolve(token)) as T;
      const [name] = rbacStoreNames(configuration, kind);
      if (name === undefined || !root.hasRegistered(name)) throw new CliUsageError(`no ${token.name} (authz.rbac.stores.${kind}): the membership commands need the RBAC DB stores`);
      return (await DI.resolve(name)) as T;
    };
    return {
      roles: await loadRoleIndex(root, 'authz:membership'),
      assignments: await store(AdminAssignmentStore, 'assignments'),
      memberships: await store(AdminMembershipStore, 'membership'),
      backend: new DbAuthzAdminBackend(),
      maxDepth: readMaxSetDepth(configuration.get(['authz', 'rbac', 'maxSetDepth'])),
    };
  }
}

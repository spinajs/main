import { AuthzDomains, AuthzService, RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { RbacService, principalSubjectKey, subjectKeyOf } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfig } from '../access-config/index.js';
import { domainNow } from '../middleware/decide.js';
import { FS_NO_OWNER_TYPES } from '../middleware/owner.js';
import { parseFsRef } from '../refs/index.js';
import type { FsRefType } from '../refs/index.js';
import { FS_ACL_LIMITS, aclPathChain, fileAclStore } from './shared.js';

/**
 * `relation` on fs refs of `type`, read from the file ACL (fs middleware design §2.2): holds when a live row of the
 * relation at the path, a parent directory or the filesystem root names one of the principal's subject keys. The
 * subject the engine passes is ignored: a caller-built row could claim anything.
 *
 * Known limit: `holds` never sees a check's `fresh` flag, so subjectKeysOf reads assignments through the RBAC
 * model's cache and a set membership may lag by its TTL.
 */
export class FsAclRelation extends RelationResolver {
  constructor(
    readonly type: FsRefType,
    readonly relation: string,
    /** Where the Configuration, AuthzDomains and the FileAclStore are resolved. */
    protected readonly container: IContainer = DI.RootContainer,
  ) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef): Promise<boolean> {
    if (ref?.type !== this.type || FS_NO_OWNER_TYPES.has(principal.type)) return false;
    const parsed = parseFsRef(ref);
    if (!parsed || parsed.fs.length > FS_ACL_LIMITS.fs) return false;
    // No row can exist for a path past the column width, and the store refuses one.
    const chain = aclPathChain(parsed.path).filter((p) => p.length <= FS_ACL_LIMITS.path);
    const domain = this.container.get(Configuration) ? fsAccessConfig(parsed.fs, this.container).domain : 'root';
    const at = await domainNow(this.container, domain);
    const keys = await this.subjectKeys(principal, domain, at);
    return (await fileAclStore(this.container)).holds(parsed.fs, chain, keys, this.relation, at);
  }

  /**
   * From the RbacService registered in the domain or a parent (sets, companions, wildcards, the ceiling applied),
   * used only when it is the service of a model the domain's AuthzService runs: a child domain without one must not match
   * set rows through its parent's service. Otherwise the principal and its type wildcard.
   */
  protected async subjectKeys(principal: Principal, domain: string, at: Date): Promise<readonly string[]> {
    const own = [principalSubjectKey(principal), subjectKeyOf({ type: principal.type, id: '*' })];
    const domains = domain === 'root' ? undefined : ((await this.container.resolve(AuthzDomains)) as AuthzDomains);
    const scope = domains ? domains.container(domain) : this.container;
    if (!scope.hasRegistered(RbacService)) return own;
    const rbac = (await scope.resolve(RbacService)) as RbacService;
    const authz = domains ? await domains.service(domain) : ((await scope.resolve(AuthzService)) as AuthzService);
    return authz.models().includes(rbac.model) ? rbac.subjectKeysOf(principal, at) : own;
  }
}

import { AuthzConfigError, SYSTEM, currentPrincipal, engineLog, principalKey } from '@spinajs/authz';
import type { AssignmentSubject, Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { publishedFs } from '@spinajs/fs';

import { fsAccessConfig, fsAclConfig } from '../access-config/index.js';
import { decideFs, domainService, refOf } from '../middleware/decide.js';
import type { FsDecideService, FsLog } from '../middleware/decide.js';
import { fsRowOf, normalizeFsPath } from '../refs/index.js';
import type { FsPathKind } from '../refs/index.js';
import { aclSubjectKey, fileAclStore } from './shared.js';
import type { FileAclStore, FsAclRow } from './store.js';

export interface FsAclOptions {
  /** Where the Configuration, the published providers, AuthzService, AuthzDomains and the FileAclStore are resolved; default the root. */
  readonly container?: IContainer;
  /** The service that decides for a domain; default the root AuthzService, else `AuthzDomains.service(domain)`. */
  readonly service?: (domain: string) => Promise<FsDecideService>;
  /** Default: the ALS principal, else UNATTENDED. */
  readonly principal?: () => Principal;
  readonly log?: FsLog;
  readonly store?: () => Promise<FileAclStore>;
}

/**
 * Changes the file ACL as the current principal. Every call asserts a definite
 * `fs:manage` on both the file and the dir ref of the path (the fs ref for the root), whatever the filesystem's
 * `authz.fs` mode; only SYSTEM is exempt. The checks run in the domain of `authz.fs.<fs>.domain`, 'root' without an
 * entry. fs:manage lets the holder grant any configured relation, owner included. System code that needs unchecked
 * writes uses the FileAclStore directly. A row granted on a path that does not exist yet is cleared as stale when
 * that path is later created through the middleware.
 */
export class FsAcl {
  private logger?: FsLog;

  constructor(protected readonly options: FsAclOptions = {}) {}

  async grant(fs: string, path: string, subject: AssignmentSubject, relation: string, opts: { readonly expiresAt?: Date } = {}): Promise<void> {
    this.known(relation);
    const principal = this.principal();
    const at = await this.authorize(fs, path, principal);
    await (await this.store()).grant({ fs, path: at, subject, relation, grantedBy: principalKey(principal), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) });
  }

  async revoke(fs: string, path: string, subject: AssignmentSubject, relation: string): Promise<void> {
    this.known(relation);
    const key = aclSubjectKey(subject);
    const at = await this.authorize(fs, path, this.principal());
    await (await this.store()).revoke(fs, at, key, relation);
  }

  async list(fs: string, path: string): Promise<readonly FsAclRow[]> {
    const at = await this.authorize(fs, path, this.principal());
    return (await this.store()).list(fs, at);
  }

  protected get container(): IContainer {
    return this.options.container ?? DI.RootContainer;
  }

  private get log(): FsLog {
    return (this.logger ??= this.options.log ?? engineLog('authz-fs'));
  }

  private principal(): Principal {
    return (this.options.principal ?? currentPrincipal)();
  }

  private store(): Promise<FileAclStore> {
    return this.options.store ? this.options.store() : fileAclStore(this.container);
  }

  private known(relation: string): void {
    const { relations } = fsAclConfig(this.container);
    if (!relations.includes(relation)) throw new AuthzConfigError(`FsAcl: relation ${JSON.stringify(relation)} is not in authz.fsAcl.relations (${relations.join(', ')})`);
  }

  private async authorize(fs: string, path: string, principal: Principal): Promise<string> {
    const provider = publishedFs(fs, this.container);
    if (!provider) throw new AuthzConfigError(`FsAcl: filesystem ${JSON.stringify(fs)} has no published provider`);
    const normalised = normalizeFsPath(path, provider.BasePath);
    if (principal === SYSTEM) return normalised;
    const { domain } = fsAccessConfig(fs, this.container);
    const service = await (this.options.service ? this.options.service(domain) : domainService(this.container, domain));
    const kinds: readonly FsPathKind[] = normalised === '' ? ['file'] : ['file', 'dir'];
    for (const kind of kinds) {
      await decideFs({ fsName: fs, mode: 'enforce', service, log: this.log, principal, permission: 'fs:manage', ref: refOf(fs, normalised, kind), subject: fsRowOf(fs, normalised, kind) });
    }
    return normalised;
  }
}

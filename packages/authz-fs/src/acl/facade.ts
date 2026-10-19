import { AuthzConfigError, SYSTEM, currentPrincipal, engineLog, principalKey } from '@spinajs/authz';
import type { AssignmentSubject, Principal } from '@spinajs/authz';
import { subjectKeyOf } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { publishedFs } from '@spinajs/fs';

import { fsAccessConfig, fsAclConfig } from '../access-config/index.js';
import { decideFs, domainService, refOf } from '../middleware/decide.js';
import type { FsDecideService, FsLog } from '../middleware/decide.js';
import { fsRowOf, normalizeFsPath } from '../refs/index.js';
import type { FsPathKind } from '../refs/index.js';
import { fileAclStore } from './shared.js';
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

export interface FsAclPathOptions {
  /** The ref type fs:manage is checked on; default 'file' (the root is always the fs ref). */
  readonly kind?: FsPathKind;
}

/**
 * Changes the file ACL as the current principal (fs middleware design §2.3): each call needs `fs:manage` on the
 * path, with the filesystem's mode (off checks nothing, audit warns, enforce asserts; SYSTEM passes). System code
 * may call the FileAclStore directly. A row granted on a path that does not exist yet is cleared as stale when
 * that path is later created through the middleware.
 */
export class FsAcl {
  private logger?: FsLog;

  constructor(protected readonly options: FsAclOptions = {}) {}

  async grant(fs: string, path: string, subject: AssignmentSubject, relation: string, opts: FsAclPathOptions & { readonly expiresAt?: Date } = {}): Promise<void> {
    this.known(relation);
    const principal = this.principal();
    const at = await this.authorize(fs, path, principal, opts.kind);
    await (await this.store()).grant({ fs, path: at, subject, relation, grantedBy: principalKey(principal), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) });
  }

  async revoke(fs: string, path: string, subject: AssignmentSubject, relation: string, opts: FsAclPathOptions = {}): Promise<void> {
    this.known(relation);
    const at = await this.authorize(fs, path, this.principal(), opts.kind);
    await (await this.store()).revoke(fs, at, subjectKeyOf(subject), relation);
  }

  async list(fs: string, path: string, opts: FsAclPathOptions = {}): Promise<readonly FsAclRow[]> {
    const at = await this.authorize(fs, path, this.principal(), opts.kind);
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

  private async authorize(fs: string, path: string, principal: Principal, kind: FsPathKind = 'file'): Promise<string> {
    const config = fsAccessConfig(fs, this.container);
    const normalised = normalizeFsPath(path, publishedFs(fs, this.container)?.BasePath);
    const mode = config.mode;
    if (mode === 'off' || principal === SYSTEM) return normalised;
    const service = await (this.options.service ? this.options.service(config.domain) : domainService(this.container, config.domain));
    await decideFs({ fsName: fs, mode, service, log: this.log, principal, permission: 'fs:manage', ref: refOf(fs, normalised, kind), subject: fsRowOf(fs, normalised, kind) });
    return normalised;
  }
}

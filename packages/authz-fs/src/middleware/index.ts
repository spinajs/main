import { AuthzConfigError, AuthzService, SYSTEM, currentPrincipal, definite, engineLog, thrownError } from '@spinajs/authz';
import type { Decision, Permission, Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FsMiddleware, normalizeFsPath } from '@spinajs/fs';
import type { FsActionContext, FsTarget, fs } from '@spinajs/fs';

import { fsAccessConfig } from '../access-config/index.js';
import type { FsAccessConfig } from '../access-config/index.js';
import { FS_ACL_LIMITS, fileAclStore } from '../acl/shared.js';
import type { FileAclStore } from '../acl/store.js';
import { fsRowOf } from '../refs/index.js';
import { decideFs, domainNow, domainService, refOf, validNow, warnDenied } from './decide.js';
import type { FsDecideService, FsLog } from './decide.js';
import { ownerOf } from './owner.js';
import { askedUntil, signingUntil } from './signed-url.js';
import type { AskedUntil } from './signed-url.js';

export type { FsDecideService, FsLog } from './decide.js';
export { FS_NO_OWNER_TYPES } from './owner.js';
export { DEFAULT_SIGNED_URL_TTL_SECONDS } from './signed-url.js';

export interface AuthzFsMiddlewareOptions {
  /** Where the Configuration, AuthzService, AuthzDomains and the FileAclStore are resolved; default the root. */
  readonly container?: IContainer;
  /** The service that decides for a domain; default the root AuthzService, else `AuthzDomains.service(domain)`. */
  readonly service?: (domain: string) => Promise<FsDecideService>;
  /** Default: the ALS principal, else UNATTENDED (what AuthzService.current() returns). */
  readonly principal?: () => Principal;
  readonly log?: FsLog;
  /** The time signed URL lifetimes count from; default the AuthzClock of the filesystem's domain. */
  readonly now?: () => Date;
  readonly store?: () => Promise<FileAclStore>;
}

/** A target on a filesystem the middleware checks. */
interface Checked {
  readonly target: FsTarget;
  readonly config: FsAccessConfig;
  /** One per access of the target; none for SYSTEM. */
  readonly decisions: readonly Decision[];
  /** Write targets only: whether the path existed before the IO. */
  readonly existed?: boolean;
  /** Deleted targets of rm, move and rename only: whether the path was a directory before the IO. */
  readonly dir?: boolean;
  /**
   * Deleted targets that are no directory: whether keys sat under the path as a prefix before the IO. On a key store
   * the key and the prefix share the ACL path, so its rows belong to the prefix as well and stay.
   */
  readonly shared?: boolean;
}

interface Plan {
  readonly principal: Principal;
  readonly checked: readonly Checked[];
  /** move/rename: the written target, whatever its filesystem's mode, and whether it existed. */
  readonly destination?: FsTarget;
  readonly destinationExisted?: boolean;
}

const PLAN = Symbol('authz-fs.plan');
const OFF: FsAccessConfig = Object.freeze({ mode: 'off', domain: 'root' });
const MOVES: ReadonlySet<string> = new Set(['move', 'rename']);

const writes = (t: FsTarget): boolean => t.access.includes('write');
const deletes = (t: FsTarget): boolean => t.access.includes('delete');
const where = (t: FsTarget): string => `${t.fs.Name}:${t.path}`;
/** No row can sit at a longer path, nor under it. */
const holdsRows = (t: FsTarget): boolean => t.path.length <= FS_ACL_LIMITS.path;

/**
 * Whether anything answers at the target's path, whatever its kind: a file, a directory, or keys under it as a
 * prefix. On a key store (S3) a key and the prefix of the same name share one ACL path, so a key written there must
 * neither clear the folder's rows nor claim them.
 */
async function occupied(ctx: FsActionContext, t: FsTarget): Promise<boolean> {
  return (await ctx.exists({ ...t, kind: 'file' })) || (await ctx.isDir(t)) || (await ctx.hasEntries(t));
}

/**
 * Checks every target of every fs action with the `authz.fs.<name>` entry of the target's own filesystem (fs
 * middleware design §2.1) and keeps the file ACL in step with what the action did.
 */
@Injectable(FsMiddleware)
export class AuthzFsMiddleware extends FsMiddleware {
  public order = 100;
  private logger?: FsLog;

  constructor(protected readonly options: AuthzFsMiddlewareOptions = {}) {
    super();
  }

  isEnabled(target: fs): boolean {
    return this.configOf(target).mode !== 'off';
  }

  async before(ctx: FsActionContext): Promise<void> {
    const asked = ctx.action === 'signedUrl' ? askedUntil(ctx.args[0]) : undefined;
    const enabled = ctx.targets.map((target) => ({ target, config: this.configOf(target.fs) })).filter((t) => t.config.mode !== 'off');
    for (const { target } of enabled) {
      if (writes(target) && target.path.length > FS_ACL_LIMITS.path) throw new InvalidArgument(`${target.fs.Name}: a path of ${target.path.length} characters is longer than the ${FS_ACL_LIMITS.path} the file ACL holds`, 'path');
    }

    const principal = (this.options.principal ?? currentPrincipal)();
    const checked: Checked[] = [];
    for (const { target, config } of enabled) checked.push({ target, config, decisions: principal === SYSTEM ? [] : await this.decide(principal, target, config) });
    if (ctx.action === 'signedUrl' && checked.length > 0) await this.narrowSignedUrl(ctx, checked[0], asked);

    // Only after every check passed: a refused action leaves the ACL alone.
    const planned: Checked[] = [];
    for (const c of checked) {
      // Probed before the IO: once rm, move or rename ran, the path is gone and no provider calls it a directory.
      const probed = deletes(c.target) ? await this.probeDeleted(ctx, c) : c;
      if (!writes(c.target)) {
        planned.push(probed);
        continue;
      }
      const existed = await occupied(ctx, c.target);
      // Nothing lives at or under a free path, so its rows are stale (an rm outside the middleware, an update that
      // failed): what is created there must not inherit them.
      if (!existed) await (await this.store()).deleteTree(c.target.fs.Name, c.target.path);
      planned.push({ ...probed, existed });
    }
    const destination = MOVES.has(ctx.action) ? ctx.targets.find(writes) : undefined;
    const plan: Plan = { principal, checked: planned, ...(destination ? { destination, destinationExisted: await occupied(ctx, destination) } : {}) };
    ctx.state.set(PLAN, plan);
  }

  async after(ctx: FsActionContext, result: unknown): Promise<unknown> {
    const plan = ctx.state.get(PLAN) as Plan | undefined;
    if (!plan) return result;
    try {
      await this.applyRows(ctx.action, plan);
    } catch (e) {
      const log = this.log;
      (log.error ?? log.warn).call(log, { error: thrownError(e), action: ctx.action, paths: ctx.targets.map(where).join(', ') }, 'authz.fs: ${action} on ${paths} succeeded, but the file ACL was not updated');
      throw e;
    }
    return ctx.action === 'list' && Array.isArray(result) ? this.listEach(plan, result) : result;
  }

  protected get container(): IContainer {
    return this.options.container ?? DI.RootContainer;
  }

  // Without a Configuration and an authz host (tools, other packages' unit tests) there is no authz.fs entry to
  // enforce. A resolved AuthzService is the host (it resolves Configuration as it boots; AuthzDomains alone is not,
  // it resolves without one): once it runs, a missing Configuration must not leave every filesystem unchecked.
  protected configOf(target: fs): FsAccessConfig {
    if (this.container.get(Configuration)) return fsAccessConfig(target.Name, this.container);
    if (this.container.isResolved(AuthzService)) {
      throw new AuthzConfigError('authz.fs: an authz host is resolved but Configuration is not; await DI.resolve(Configuration) first');
    }
    return OFF;
  }

  private get log(): FsLog {
    return (this.logger ??= this.options.log ?? engineLog('authz-fs'));
  }

  private service(domain: string): Promise<FsDecideService> {
    return this.options.service ? this.options.service(domain) : domainService(this.container, domain);
  }

  private store(): Promise<FileAclStore> {
    return this.options.store ? this.options.store() : fileAclStore(this.container);
  }

  private async decide(principal: Principal, target: FsTarget, config: FsAccessConfig): Promise<Decision[]> {
    const service = await this.service(config.domain);
    const fsName = target.fs.Name;
    const ref = refOf(fsName, target.path, target.kind);
    const subject = fsRowOf(fsName, target.path, target.kind);
    const mode = config.mode === 'enforce' ? 'enforce' : 'audit';
    const decisions: Decision[] = [];
    for (const access of target.access) decisions.push(await decideFs({ fsName, mode, service, log: this.log, principal, permission: `fs:${access}` as Permission, ref, subject }));
    return decisions;
  }

  // The URL never outlives the asked until (else the default lifetime), the TTL cap or the permit; audit narrows too.
  private async narrowSignedUrl(ctx: FsActionContext, c: Checked, asked: AskedUntil | undefined): Promise<void> {
    const { maxTtlSeconds, defaultTtlSeconds } = c.config.signedUrl ?? {};
    const now = this.options.now ? validNow(this.options.now()) : await domainNow(this.container, c.config.domain);
    const until = signingUntil({ asked, defaultTtlSeconds, maxTtlSeconds, now, decisions: c.decisions });
    const opts = ctx.args[0] !== null && typeof ctx.args[0] === 'object' ? (ctx.args[0] as object) : {};
    ctx.args[0] = { ...opts, until };
  }

  private async probeDeleted(ctx: FsActionContext, c: Checked): Promise<Checked> {
    const dir = await ctx.isDir(c.target);
    return dir ? { ...c, dir } : { ...c, dir, shared: await ctx.hasEntries(c.target) };
  }

  private async applyRows(action: string, plan: Plan): Promise<void> {
    if (action === 'rm') {
      const store = await this.store();
      for (const c of plan.checked.filter((c) => holdsRows(c.target))) {
        if (c.dir) await store.deleteTree(c.target.fs.Name, c.target.path);
        else if (!c.shared) await store.deletePath(c.target.fs.Name, c.target.path);
      }
      return;
    }
    if (MOVES.has(action)) return this.moveRows(plan);
    for (const c of plan.checked) {
      if (c.existed !== false || c.config.stampOwner !== true || c.target.path === '') continue;
      // Only a definite allow stamps: an audit-mode denial or a conditional permit must leave no owner behind.
      if (c.decisions.length === 0 || !c.decisions.every(definite)) continue;
      const owner = ownerOf(plan.principal, c.decisions[0]);
      if (owner) await (await this.store()).setOwnerIfAbsent(c.target.fs.Name, c.target.path, owner);
    }
  }

  /**
   * A destination that existed keeps its rows (first writer) and the source rows go; otherwise the source rows move
   * there, onto another filesystem too (one table): a directory's whole tree, anything else only its own rows. No
   * owner is stamped: the rows travel with the file. A key whose prefix holds keys leaves its rows to the prefix. A
   * destination too long for a row gets none: the source rows go, its parents' rows cover it.
   */
  private async moveRows(plan: Plan): Promise<void> {
    const checked = plan.checked.find((c) => c.target.role === 'source');
    const source = checked?.target;
    const destination = plan.destination;
    if (!source || !destination || checked?.shared === true || !holdsRows(source)) return;
    if (source.fs.Name === destination.fs.Name && source.path === destination.path) return;
    const store = await this.store();
    const tree = checked?.dir === true;
    if (plan.destinationExisted || !holdsRows(destination)) await (tree ? store.deleteTree(source.fs.Name, source.path) : store.deletePath(source.fs.Name, source.path));
    else if (tree) await store.moveTree(source.fs.Name, source.path, destination.fs.Name, destination.path);
    else await store.movePath(source.fs.Name, source.path, destination.fs.Name, destination.path);
  }

  private async listEach(plan: Plan, entries: unknown[]): Promise<unknown[]> {
    const dir = plan.checked[0];
    if (!dir || dir.config.list !== 'each' || plan.principal === SYSTEM) return entries;
    const { target, config } = dir;
    const fsName = target.fs.Name;
    const service = await this.service(config.domain);
    const enforce = config.mode === 'enforce';
    const keep = await Promise.all(
      entries.map(async (entry) => {
        let path: string;
        try {
          // Local providers list names inside the directory, S3 whole keys.
          const joined = typeof entry === 'string' && target.path !== '' && !entry.includes('/') ? `${target.path}/${entry}` : entry;
          path = normalizeFsPath(joined as string, target.fs.BasePath);
        } catch {
          return !enforce;
        }
        const ref = refOf(fsName, path, 'file');
        const decision = await service.check({ principal: plan.principal, permission: 'fs:stat', resource: ref, subject: fsRowOf(fsName, path, 'file') });
        if (definite(decision)) return true;
        if (!enforce) warnDenied(fsName, this.log, plan.principal, 'fs:stat', ref, decision);
        return !enforce;
      }),
    );
    return entries.filter((_, i) => keep[i]);
  }
}

import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { AuthzConfigError } from '../contracts/errors.js';
import { AuthzDomains, AuthzService } from '../contracts/service.js';
import { engineLog } from './log.js';

const DOMAIN_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const ROOT = 'root';

interface DomainRecord {
  readonly name: string;
  /** Undefined for root. */
  readonly parent?: string;
  readonly container: IContainer;
  /** Services booting for this domain or attached to it; all are disposed with the domain. */
  readonly services: Set<AuthzService>;
  service?: AuthzService;
}

export interface DomainIdentity {
  readonly name: string;
  readonly parent?: string;
}

const q = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

@Singleton()
@Injectable(AuthzDomains)
@Inject(Container)
export class DefaultAuthzDomains extends AuthzDomains {
  private readonly records = new Map<string, DomainRecord>();
  /** Every service that ever entered a domain boot. */
  private readonly entered = new WeakSet<AuthzService>();

  constructor(private readonly rootContainer: IContainer) {
    super();
    this.records.set(ROOT, { name: ROOT, container: rootContainer, services: new Set() });
  }

  create(name: string, parent?: string): IContainer {
    if (name === ROOT) throw new AuthzConfigError(`Authz domain "root" is the root container; it cannot be created`);
    if (typeof name !== 'string' || !DOMAIN_NAME.test(name)) throw new AuthzConfigError(`Invalid authz domain name ${q(name)}: expected 1 to 64 characters of [A-Za-z0-9_.-]`);
    if (this.records.has(name)) throw new AuthzConfigError(`Authz domain ${q(name)} already exists`);
    if (parent !== undefined && typeof parent !== 'string') throw new AuthzConfigError(`Authz domain ${q(name)}: parent must be a domain name, got ${q(parent)}`);

    const configured = this.configuredParent(name);
    if (parent !== undefined && configured !== undefined && parent !== configured) {
      throw new AuthzConfigError(`Authz domain ${q(name)}: parent ${q(parent)} differs from authz.domains.${name}.parent (${q(configured)})`);
    }
    const parentName = parent ?? configured ?? ROOT;
    const owner = this.records.get(parentName);
    if (!owner) throw new AuthzConfigError(`Authz domain ${q(name)}: parent domain ${q(parentName)} does not exist`);

    const container = owner.container.child();
    this.records.set(name, { name, parent: parentName, container, services: new Set() });
    container.once('di.dispose', () => this.forget(name, container));
    return container;
  }

  container(name: string): IContainer {
    const record = this.records.get(name);
    if (!record) throw new AuthzConfigError(`Authz domain ${q(name)} does not exist (live domains: ${this.names().join(', ')})`);
    return record.container;
  }

  async service(name: string): Promise<AuthzService> {
    const container = this.container(name);
    if (!container.hasRegistered(AuthzService)) throw new AuthzConfigError(`Authz domain ${q(name)}: no AuthzService implementation is registered; import the authz host`);
    const service = (await container.resolve(AuthzService)) as AuthzService;
    // DI may hand out a service whose domain was disposed after its boot attached it.
    const record = this.records.get(name);
    if (record?.container !== container) throw new AuthzConfigError(`Authz domain ${q(name)} was disposed while its service booted`);
    // An implementation that never enters a boot (a test fake) is returned as DI gives it.
    if (record.service !== service && this.entered.has(service)) throw new AuthzConfigError(`The AuthzService of domain ${q(name)} is disposed`);
    return service;
  }

  names(): readonly string[] {
    return Object.freeze([...this.records.keys()]);
  }

  /** The domain a container belongs to; undefined for a container that is not a domain. */
  describe(container: IContainer): DomainIdentity | undefined {
    for (const r of this.records.values()) {
      if (r.container === container) return Object.freeze(r.parent === undefined ? { name: r.name } : { name: r.name, parent: r.parent });
    }
    return undefined;
  }

  /** Like describe(), and records `service` as booting for the domain so that disposing the domain disposes it. */
  enter(container: IContainer, service: AuthzService): DomainIdentity | undefined {
    const id = this.describe(container);
    if (id) {
      this.records.get(id.name)!.services.add(service);
      this.entered.add(service);
    }
    return id;
  }

  parentOf(name: string): string | undefined {
    return this.records.get(name)?.parent;
  }

  /** Domain names from 'root' to `name`. */
  lineage(name: string): readonly string[] {
    const out: string[] = [];
    for (let r = this.records.get(name); r; r = r.parent === undefined ? undefined : this.records.get(r.parent)) out.unshift(r.name);
    if (out[0] !== ROOT) throw new AuthzConfigError(`Authz domain ${q(name)} does not exist`);
    return Object.freeze(out);
  }

  /** Does a change published for `changeDomain` concern domain `domain`? */
  affects(changeDomain: string | undefined, domain: string): boolean {
    // A malformed domain invalidates everywhere: dropping too much never widens access.
    if (typeof changeDomain !== 'string') return true;
    for (let n: string | undefined = domain; n !== undefined; n = this.records.get(n)?.parent) {
      if (n === changeDomain) return true;
    }
    return false;
  }

  attach(name: string, service: AuthzService): boolean {
    const record = this.records.get(name);
    if (!record?.services.has(service)) return false;
    record.service = service;
    return true;
  }

  detach(name: string, service: AuthzService): void {
    const record = this.records.get(name);
    if (!record) return;
    record.services.delete(service);
    if (record.service === service) record.service = undefined;
  }

  resolved(name: string): AuthzService | undefined {
    return this.records.get(name)?.service;
  }

  private forget(name: string, container: IContainer): void {
    if (this.records.get(name)?.container !== container) return;
    const gone = new Set([name]);
    // Records are kept in creation order, so a descendant always follows its parent.
    for (const r of this.records.values()) if (r.parent !== undefined && gone.has(r.parent)) gone.add(r.name);
    for (const n of gone) {
      const record = this.records.get(n)!;
      this.records.delete(n);
      // A service DI had not cached yet when the container was disposed would otherwise stay live.
      for (const service of record.services) {
        Promise.resolve()
          .then(() => service.dispose())
          .catch((e: unknown) => engineLog('authz').error(`Authz domain ${q(n)}: disposing its service failed: ${e instanceof Error ? e.message : q(e)}`));
      }
    }
  }

  private configuredParent(name: string): string | undefined {
    // create() is synchronous, so it reads the already resolved Configuration.
    const configuration = this.rootContainer.get(Configuration) as Configuration | undefined;
    if (!configuration || typeof configuration.get !== 'function') {
      throw new AuthzConfigError(`Authz domain ${q(name)}: Configuration is not resolved; await DI.resolve(Configuration) before AuthzDomains.create`);
    }
    let cur: unknown = configuration.get(['authz']);
    for (const seg of ['domains', name, 'parent']) {
      if (!isRecord(cur) || !Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    }
    if (cur === undefined) return undefined;
    if (typeof cur !== 'string') throw new AuthzConfigError(`Authz domain ${q(name)}: configuration key authz.domains.${name}.parent must be a string`);
    return cur;
  }
}

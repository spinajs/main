import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { quote as q } from '@spinajs/util';

import { AuthzConfigError } from '../contracts/errors.js';
import { AuthzDomains, AuthzService, DOMAIN_NAME_PATTERN, ROOT_DOMAIN } from '../contracts/service.js';
import type { ChangeBus, DecisionAudit, DomainIdentity } from '../contracts/service.js';
import { engineLog, thrownError } from './log.js';
import { configAt } from './config/domain-config.js';
import type { DomainConfig } from './config/domain-config.js';
import type { AuthzClock } from './clock.js';

const DOMAIN_NAME = new RegExp(DOMAIN_NAME_PATTERN);

/** What a domain's AuthzService picked and merged at boot; the host hands it to attach(). */
export interface DomainBoot {
  readonly config: DomainConfig;
  readonly audit: DecisionAudit | undefined;
  readonly bus: ChangeBus | undefined;
  readonly clock: AuthzClock;
}

interface DomainRecord {
  readonly name: string;
  /** Undefined for root. */
  readonly parent?: string;
  readonly container: IContainer;
  /** Services booting for this domain or attached to it; all are disposed with the domain. */
  readonly services: Set<AuthzService>;
  service?: AuthzService;
  boot?: DomainBoot;
}


/** The parent `authz.domains.<name>.parent` names in the authz tree. */
export function configuredParent(tree: unknown, name: string): string | undefined {
  return configAt(tree, ['domains', name, 'parent']) as string | undefined;
}

/** Domain names from 'root' to `name` by the configured parents: the lineage before the host has created its domains. */
export function configuredLineage(tree: unknown, name: string): readonly string[] {
  const out = [name];
  for (let d = name; d !== ROOT_DOMAIN; ) {
    const parent = configuredParent(tree, d) ?? ROOT_DOMAIN;
    // The schema checks each entry on its own; only the chain across entries can loop.
    if (out.includes(parent)) throw new AuthzConfigError(`The configured parents of authz domain ${q(name)} form a cycle`);
    out.unshift(parent);
    d = parent;
  }
  return Object.freeze(out);
}

@Singleton()
@Injectable(AuthzDomains)
@Inject(Container)
export class DefaultAuthzDomains extends AuthzDomains {
  private readonly records = new Map<string, DomainRecord>();
  /** Every service that ever entered a domain boot. */
  private readonly entered = new WeakSet<AuthzService>();

  /** Read synchronously by create(): the root Configuration must be resolved before the first create(). */
  @Config('authz')
  protected Config: unknown;

  constructor(rootContainer: IContainer) {
    super();
    this.records.set(ROOT_DOMAIN, { name: ROOT_DOMAIN, container: rootContainer, services: new Set() });
  }

  create(name: string, parent?: string): IContainer {
    if (name === ROOT_DOMAIN) throw new AuthzConfigError(`Authz domain "root" is the root container; it cannot be created`);
    if (typeof name !== 'string' || !DOMAIN_NAME.test(name)) throw new AuthzConfigError(`Invalid authz domain name ${q(name)}: expected 1 to 64 characters of [A-Za-z0-9_.-]`);
    if (this.records.has(name)) throw new AuthzConfigError(`Authz domain ${q(name)} already exists`);
    if (parent !== undefined && typeof parent !== 'string') throw new AuthzConfigError(`Authz domain ${q(name)}: parent must be a domain name, got ${q(parent)}`);

    const configured = configuredParent(this.Config, name);
    if (parent !== undefined && configured !== undefined && parent !== configured) {
      throw new AuthzConfigError(`Authz domain ${q(name)}: parent ${q(parent)} differs from authz.domains.${name}.parent (${q(configured)})`);
    }
    const parentName = parent ?? configured ?? ROOT_DOMAIN;
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
    if (out[0] !== ROOT_DOMAIN) throw new AuthzConfigError(`Authz domain ${q(name)} does not exist`);
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

  attach(name: string, service: AuthzService, boot?: DomainBoot): boolean {
    const record = this.records.get(name);
    if (!record?.services.has(service)) return false;
    record.service = service;
    record.boot = boot === undefined ? undefined : Object.freeze({ ...boot });
    return true;
  }

  detach(name: string, service: AuthzService): void {
    const record = this.records.get(name);
    if (!record) return;
    record.services.delete(service);
    if (record.service === service) {
      record.service = undefined;
      record.boot = undefined;
    }
  }

  /** The configuration of the domain merged over its lineage, as its service booted with it (frozen). */
  config(name: string): DomainConfig {
    return this.booted(name).config;
  }

  /** The DecisionAudit the domain's service picked at boot (authz.audit.service, else the last registered); undefined when none. */
  audit(name: string): DecisionAudit | undefined {
    return this.booted(name).audit;
  }

  /** The ChangeBus the domain's service picked at boot (authz.bus.service, else the last registered); undefined when none. */
  bus(name: string): ChangeBus | undefined {
    return this.booted(name).bus;
  }

  /** The AuthzClock the domain's service booted with: the domain's own registration, else SystemClock. */
  clock(name: string): AuthzClock {
    return this.booted(name).clock;
  }

  resolved(name: string): AuthzService | undefined {
    return this.records.get(name)?.service;
  }

  private booted(name: string): DomainBoot {
    const record = this.records.get(name);
    if (!record) throw new AuthzConfigError(`Authz domain ${q(name)} does not exist (live domains: ${this.names().join(', ')})`);
    if (!record.boot) throw new AuthzConfigError(`Authz domain ${q(name)} has no booted AuthzService; await AuthzDomains.service(${q(name)}) first`);
    return record.boot;
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
          .catch((e: unknown) => engineLog('authz').error({ error: thrownError(e), domain: n }, 'Authz domain ${domain}: disposing its service failed'));
      }
    }
  }
}

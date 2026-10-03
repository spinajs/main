/**
 * Host harness for `runBehaviour`: each case runs in a fresh test domain (a child of root made by
 * `AuthzDomains.create`) holding the world's kit fakes, booted by the real `DefaultAuthzService`.
 *
 * Options (all optional):
 * - `domain`: the test domain's name, default 'test'; it is also `$domain` in expected messages.
 * - `facets`: facets the lane adds through `register`/`extend` (the host facets are always on).
 * - `register(host)`: lane wiring, called after the kit registrations and before the services boot;
 *   write config only through `host.setConfig`, so the case's cleanup removes it.
 * - `extend(host, session)`: extra session handles (`admin`, `list`, `lane`, …); a `dispose` it
 *   returns runs before the domain is disposed.
 * - `kitScopeAttributes`: default true; false skips the kit's ScopeAttributeStore and schema
 *   contributor for `world.scopeAttributes`, for a lane that registers its own.
 *
 * World mapping (values are copied, never shared with the fixture): `permissions`, `combine` and
 * `config.{engine,fields,cache,audit}` go to `authz.domains.<domain>.*`; `config.domains.<n>` to
 * `authz.domains.<n>` (keys the harness derives from the world win); `config.principals` to
 * `authz.principals`; any other `config.<key>` (model sections) to `authz.<key>`. A world section
 * replaces the lane's own section at that key for the case; it is not merged into it. Without the
 * `cache` facet and without `config.cache`, the domain gets `cache.maxEntries: 0` (no L2; L1 stays,
 * as in F3's engine harness). Each `world.domains` entry becomes a child domain (parent 'root' means
 * the test domain) with its kit models and `authz.domains.<name>.{combine,disable}`. Every config key
 * a case set is restored afterwards.
 *
 * Root stays booted across cases: it boots once, inside the first case and under that case's config,
 * so root must hold no models of the lane and root-only keys of a world reach root only in the first
 * case. The harness needs `testHost`'s TestConfiguration as the DI Configuration: it installs it in
 * `beforeAll` (when no one did) and uninstalls it in `afterAll`. Host tests and lanes load the host
 * from the lib (`@spinajs/authz`, as this kit does), never from src, because two copies register two
 * DefaultAuthzService classes in one DI root.
 */
import type { IContainer } from '@spinajs/di';

import { AuthzClock, AuthzContributor, AuthorizationModel, ChangeBus, DecisionAudit, RelationResolver, ResourceAdapter, ScopeAttributeStore, ScopeResolver, resourceKey } from '@spinajs/authz';
import type { AuthzService, ResourceRef } from '@spinajs/authz';
import type { BehaviourAuthz, BehaviourDomains, BehaviourHarness, HarnessSession, SetupContext } from '../behaviour/harness.js';
import type { Facet, World } from '../behaviour/types.js';
import { instantiateWorld } from '../behaviour/world.js';
import type { KitWorld } from '../behaviour/world.js';
import { config, domains, installHost, instance, uninstallHost } from './support.js';

export interface HostSetup {
  /** The test domain's container. */
  readonly container: IContainer;
  /** The containers of the world's child domains, by name. */
  readonly containers: ReadonlyMap<string, IContainer>;
  readonly world: World;
  readonly kit: KitWorld;
  readonly ctx: SetupContext;
  readonly domain: string;
  /** Sets a config key for this case only (segment arrays for names with dots). */
  setConfig(path: readonly string[], value: unknown): void;
}

export interface HostHarnessOptions {
  readonly domain?: string;
  readonly facets?: readonly Facet[];
  readonly kitScopeAttributes?: boolean;
  register?(host: HostSetup): void | Promise<void>;
  extend?(host: HostSetup, session: HarnessSession): Partial<HarnessSession> | Promise<Partial<HarnessSession>>;
}

const HOST_FACETS: readonly Facet[] = ['engine', 'boot', 'audit', 'clock', 'cache', 'host', 'bus'];
const DOMAIN_KEYS = new Set(['engine', 'fields', 'cache', 'audit']);

class WorldAttributeStore extends ScopeAttributeStore {
  private readonly values: ReadonlyMap<string, Readonly<Record<string, unknown>>>;

  constructor(values: NonNullable<World['scopeAttributes']>['values']) {
    super();
    this.values = new Map((values ?? []).map((v) => [resourceKey(v.scope), v.attributes]));
  }

  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return this.values.get(resourceKey(ref)) ?? {};
  }

  async version(): Promise<string> {
    return '';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Plain objects and arrays are copied; anything else (functions, class instances) is kept as is.
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as unknown as T;
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  return value;
}

/** Config writes of one case, undone in reverse order; parents the case created are removed when left empty. */
class ConfigScope {
  private readonly undo: (() => void)[] = [];

  set(path: readonly string[], value: unknown): void {
    const cfg = config();
    const created: string[][] = [];
    for (let i = 1; i < path.length; i++) {
      const parent = path.slice(0, i);
      if (cfg.get(parent) === undefined) created.push(parent);
    }
    const before = cfg.get<unknown>([...path]);
    const existed = before !== undefined;
    cfg.set([...path], value);
    this.undo.push(() => {
      if (existed) cfg.set([...path], before);
      else cfg.unset(path);
      for (const p of created.reverse()) {
        const v = cfg.get<unknown>(p);
        if (isRecord(v) && Object.keys(v).length === 0) cfg.unset(p);
      }
    });
  }

  restore(): void {
    for (const fn of this.undo.splice(0).reverse()) fn();
  }
}

function permissionsConfig(world: World): Record<string, unknown> {
  return Object.fromEntries(
    world.permissions.map((p) => {
      if (typeof p === 'string') return [p, {}];
      const { name, source: _source, ...def } = p;
      return [name, copy(def)];
    }),
  );
}

/** World domains in an order where each parent comes before its children. */
function domainOrder(world: World, root: string): { name: string; parent: string }[] {
  const entries = Object.entries(world.domains ?? {});
  const placed = new Set<string>(['root']);
  const out: { name: string; parent: string }[] = [];
  while (out.length < entries.length) {
    const next = entries.find(([name, d]) => !placed.has(name) && placed.has(d.parent ?? 'root'));
    if (!next) throw new Error(`hostHarness: world domains ${entries.map(([n]) => n).join(', ')} have an unknown parent or a cycle`);
    const [name, d] = next;
    placed.add(name);
    out.push({ name, parent: d.parent === undefined || d.parent === 'root' ? root : d.parent });
  }
  return out;
}

export function hostHarness(opts: HostHarnessOptions = {}): BehaviourHarness {
  const domain = opts.domain ?? 'test';
  let ownsInstall = false;

  return {
    facets: [...new Set([...HOST_FACETS, ...(opts.facets ?? [])])],
    domain,

    async beforeAll() {
      try {
        config();
      } catch {
        ownsInstall = true;
        await installHost();
      }
    },

    async afterAll() {
      if (ownsInstall) await uninstallHost();
      ownsInstall = false;
    },

    async setup(world, ctx) {
      const kit = instantiateWorld(world);
      const scope = new ConfigScope();
      const ds = await domains();
      let container: IContainer | undefined;
      const disposeDomain = async () => {
        if (container && ds.names().includes(domain) && ds.container(domain) === container) await container.dispose();
        container = undefined;
      };

      try {
        const wc = world.config ?? {};
        const caching = ctx.facets.includes('cache') || wc.cache !== undefined;
        const configured = isRecord(wc.domains) ? (copy(wc.domains) as Record<string, unknown>) : {};
        const domainConfig = (name: string, derived: Record<string, unknown>): Record<string, unknown> => {
          const base = configured[name];
          delete configured[name];
          return { ...(isRecord(base) ? base : {}), ...derived };
        };
        const own: Record<string, unknown> = { permissions: permissionsConfig(world), combine: copy(world.combine) };
        for (const [key, value] of Object.entries(wc)) {
          if (value === undefined || key === 'domains') continue;
          if (DOMAIN_KEYS.has(key)) own[key] = copy(value);
          else scope.set(['authz', key], copy(value));
        }
        if (!caching) own.cache = { maxEntries: 0 };
        scope.set(['authz', 'domains', domain], domainConfig(domain, own));

        container = ds.create(domain, 'root');
        const c = container;
        for (const m of kit.models) c.register(instance(m)).as(AuthorizationModel);
        for (const a of kit.adapters) c.register(instance(a)).as(ResourceAdapter);
        for (const s of kit.scopeResolvers) c.register(instance(s)).as(ScopeResolver);
        for (const r of kit.relations) c.register(instance(r)).as(RelationResolver);
        c.register(instance(kit.audit)).as(DecisionAudit);
        c.register(instance(kit.bus)).as(ChangeBus);
        c.register(instance(kit.clock)).as(AuthzClock);
        if (world.scopeAttributes && opts.kitScopeAttributes !== false) {
          const { schemas = [], values } = world.scopeAttributes;
          if (values) c.register(instance(new WorldAttributeStore(values))).as(ScopeAttributeStore);
          c.register(instance({ contribute: () => ({ scopeAttributeSchemas: schemas }) })).as(AuthzContributor);
        }

        const children = domainOrder(world, domain);
        const containers = new Map<string, IContainer>();
        for (const { name, parent } of children) {
          const d = world.domains![name];
          const childCfg: Record<string, unknown> = {};
          if (d.combine) childCfg.combine = copy(d.combine);
          if (d.disable) childCfg.disable = [...d.disable];
          scope.set(['authz', 'domains', name], domainConfig(name, childCfg));
          const child = ds.create(name, parent);
          containers.set(name, child);
          for (const m of kit.domainModels.get(name) ?? []) child.register(instance(m)).as(AuthorizationModel);
        }
        for (const [name, value] of Object.entries(configured)) scope.set(['authz', 'domains', name], value);

        const host: HostSetup = { container: c, containers, world, kit, ctx, domain, setConfig: (path, value) => scope.set(path, value) };
        await opts.register?.(host);

        const authz = (await ds.service(domain)) as AuthzService;
        const services = new Map<string, AuthzService>();
        for (const { name } of children) services.set(name, (await ds.service(name)) as AuthzService);

        const domainHandle: BehaviourDomains = {
          service(name) {
            const svc = services.get(name);
            if (!svc) throw new Error(`hostHarness: domain ${name} is not a domain of the world (domains: ${[...services.keys()].join(', ')})`);
            return svc as unknown as BehaviourAuthz;
          },
          names: () => [...services.keys()].filter((n) => ds.names().includes(n)),
          async dispose(name) {
            if (!services.has(name)) throw new Error(`hostHarness: domain ${name} is not a domain of the world`);
            await ds.container(name).dispose();
          },
        };

        const base: HarnessSession = {
          authz: authz as unknown as BehaviourAuthz,
          kit,
          domain,
          audit: kit.audit,
          clock: kit.clock,
          bus: kit.bus,
          domains: domainHandle,
          dispose: async () => undefined,
        };
        const extra = (await opts.extend?.(host, base)) ?? {};
        return {
          ...base,
          ...extra,
          async dispose() {
            try {
              await extra.dispose?.();
            } finally {
              try {
                await disposeDomain();
              } finally {
                scope.restore();
              }
            }
          },
        };
      } catch (e) {
        try {
          await disposeDomain();
        } finally {
          scope.restore();
        }
        throw e;
      }
    },
  };
}

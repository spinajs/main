import type { AuthzAdmin, AuthzChange, AuthzService, Permission, Principal, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import type { FakeRow, StaticModel } from '../fakes/index.js';
import type { AuditEntry } from '../recording.js';
import type { BehaviourId, Facet, Who, World } from './types.js';
import type { KitWorld } from './world.js';

/**
 * The decision surface fixtures call, typed by the frozen AuthzService. An engine harness (F3) wraps
 * its Authorizer; a host harness hands the AuthzService itself. The optional methods are needed only
 * by the steps that call them; a missing one fails that step with a clear message.
 */
export type BehaviourAuthz = Pick<AuthzService, 'check' | 'checkMany' | 'explain'> & Partial<Pick<AuthzService, 'can' | 'assert' | 'filter' | 'filterNow' | 'summary' | 'covers' | 'preload' | 'invalidate' | 'models' | 'current' | 'runAs'>>;

/** clock facet. A ManualClock fits. */
export interface BehaviourClock {
  now(): Date;
  advance(ms: number): unknown;
}

/** audit facet. A RecordingAudit fits. */
export interface BehaviourAudit {
  readonly entries: readonly AuditEntry[];
}

/** bus facet. A RecordingChangeBus fits; `published` is needed only by `published` steps. */
export interface BehaviourBus {
  publish(change: AuthzChange): Promise<void>;
  readonly published?: readonly AuthzChange[];
}

/** host facet: the child domains of `world.domains`, created by the harness at setup. */
export interface BehaviourDomains {
  service(name: string): BehaviourAuthz;
  names(): readonly string[];
  /** Disposes the domain's container: its AuthzService, caches and child-owned models. */
  dispose(name: string): Promise<void>;
}

/**
 * Handles for lane facets (orm, http, fs, queue, …). The fixture file that first needs one declares it
 * by augmenting this interface:
 *
 * ```ts
 * declare module '../harness.js' {
 *   interface LaneHandles { http: { request(method: string, path: string, opts?: object): Promise<{ status: number; body: unknown }> } }
 * }
 * ```
 */
export interface LaneHandles {}

/** One running system for one case. Fill the handles of the facets the harness declares. */
export interface HarnessSession {
  /** engine. */
  readonly authz?: BehaviourAuthz;
  /**
   * engine: the KitWorld the harness built with `instantiateWorld(world)`. Its models must be the very
   * instances the system runs (`calls` steps and `do` steps that script a model read them).
   */
  readonly kit?: KitWorld;
  /**
   * The name of the domain that plays the world's root (default: the harness's `domain`, else 'root').
   * The runner puts it in place of `$domain` in expected error messages and `DecisionExpectation.domain`.
   */
  readonly domain?: string;
  /** clock: the time source of the engine (and of the cache TTLs); `advance` steps move it. */
  readonly clock?: BehaviourClock;
  /** audit: every DecisionAudit record the session made. */
  readonly audit?: BehaviourAudit;
  /** bus: the ChangeBus the AuthzService of every domain subscribes to. */
  readonly bus?: BehaviourBus;
  /** host: the child domains of `world.domains`. */
  readonly domains?: BehaviourDomains;
  /** admin: the AuthzAdmin of the root domain. */
  readonly admin?: AuthzAdmin;
  /** list/sql: ids of the world rows of `type` that `filter(principal, permission, type)` selects, by the lane's query side. */
  list?(principal: Principal, permission: Permission, type: ResourceType): Promise<readonly string[]>;
  /** The subject the lane's adapter loads for a world row (an ORM model instance); default: the world row itself. */
  load?(ref: ResourceRef): Promise<unknown>;
  /** Lane facets (orm, http, fs, …), declared through {@link LaneHandles}. */
  readonly lane?: Partial<LaneHandles>;
  /** Called once per case, also when the case fails. */
  dispose(): Promise<void>;
}

export interface SetupContext {
  /** The rule, e.g. 'B03'. */
  readonly id: BehaviourId;
  /** The part name, e.g. 'core'. */
  readonly part: string;
  /** The case name. */
  readonly case: string;
  /** The mocha title of the case. */
  readonly title: string;
  /** The facets the part needs (a subset of the harness's). */
  readonly facets: readonly Facet[];
}

/**
 * Plugs a lane's system into the behaviour fixtures. Rules for harness writers (DI, F2 behaviour A and
 * hand-off H, P2):
 *
 * - One fresh system per case: `setup` builds it, `dispose` tears it down; nothing may leak into the
 *   next case. The runner disposes only a session `setup` returned: a `setup` that fails half-way
 *   cleans up what it built before rejecting (`scopedContainer` does so for its child).
 * - Create a test domain (child container) per case and register the lane's models in the child, so
 *   it owns and creates them; the kit's `scopedContainer` does this. A root-registered singleton first
 *   resolved through a child lives in root and survives `child.dispose()`, so a child never yields
 *   fresh root singletons. Child-only model classes must not carry `@Injectable(AuthorizationModel)`;
 *   register them imperatively in the child.
 * - Uncache only the root types the harness itself causes to be created (`uncacheOwned`, or
 *   `scopedContainer({ uncache })`). Never call `DI.clearCache()`: it wipes entries other packages
 *   write at import time, which nothing rebuilds.
 * - Kit fakes come from `instantiateWorld(world)`. Register those very instances, not new ones, and
 *   return the KitWorld as `session.kit`. They arrive un-initialised: the system's boot calls their
 *   `init`, as it does for any model.
 * - A test domain usually has another name than 'root'; say which in `domain` (or `session.domain`).
 *   Fixtures write `$domain` where an error message names the domain.
 *
 * The README section "World → system" says where each world key goes.
 */
export interface BehaviourHarness {
  /** What the harness can do; parts needing other facets are pending or failing (see `runBehaviour`). */
  readonly facets: readonly Facet[];
  /**
   * The name of the domain that plays the world's root, default 'root'. It replaces `$domain` in
   * expected messages; boot expectations can use only this one, since a rejected setup returns no session.
   */
  readonly domain?: string;
  /** Once before the first case (bootstrap an app, open a database). */
  beforeAll?(): Promise<void>;
  /** Once after the last case. */
  afterAll?(): Promise<void>;
  /**
   * Builds a fresh system for `world` and returns its handles. Rejects with the system's own error when
   * the world fails its boot checks (boot cases expect that).
   */
  setup(world: World, ctx: SetupContext): Promise<HarnessSession>;
}

/** What a `do` step gets. */
export interface StepContext {
  readonly session: HarnessSession;
  readonly world: World;
  /** session.authz, or the domain's service for a step with `domain`. */
  authz(domain?: string): BehaviourAuthz;
  principal(who: Who): Principal;
  /** The world rows of a type, in world order. */
  rows(type: ResourceType): readonly FakeRow[];
  /** `session.load(ref)` when the harness has it, else the world row. */
  subject(ref: ResourceRef): Promise<unknown>;
  /** Ids of the world rows of `type` the residual holds for, by the kit's `evaluateFilter`. */
  select(residual: ResourceFilter, type: ResourceType, principal: Principal, actor?: Principal): Promise<readonly string[]>;
  /** A kit StaticModel of `session.kit`. */
  staticModel(name: string, domain?: string): StaticModel;
}

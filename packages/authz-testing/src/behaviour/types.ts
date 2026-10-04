import type { Assignment, CombiningAlgorithm, LinkDef, Permission, Policy, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';

import type { TestLadderDef, TestRoleDef } from '../arbitraries/rbac.js';
import type { FakeAdapterOptions, FakeRbacOptions, FakeScopeResolverOptions, FakeTupleModelOptions, HoldsFn, ModelCall, StaticModelOptions } from '../fakes/index.js';
import type { Tuple } from '../rebac.js';
import type { AuditEntry } from '../recording.js';
import type { FakePermissionInput } from '../registry.js';
import type { StepContext } from './harness.js';
import type { BEHAVIOUR_RULES } from './rules.js';

/** 'B01' … 'B46' (design §17). */
export type BehaviourId = keyof typeof BEHAVIOUR_RULES;

/** A whole fixture ('B09') or one of its parts ('B09.core'). */
export type BehaviourSelector = BehaviourId | `${BehaviourId}.${string}`;

/**
 * What a harness can do. A part lists the facets it needs; `runBehaviour` runs it only on a harness
 * that has all of them. {@link FACETS} says what each one promises.
 */
export type Facet = 'engine' | 'boot' | 'audit' | 'clock' | 'cache' | 'host' | 'bus' | 'rbac' | 'ladders' | 'rules' | 'links' | 'abac' | 'conditions' | 'rebac' | 'admin' | 'scopeAttributes' | 'store' | 'list' | 'sql' | 'orm' | 'http' | 'fs' | 'queue' | 'socket' | 'email' | 'configuration' | 'token' | 'authn' | 'impersonation' | 'canvas';

/** The promise behind each facet; a harness that lists a facet keeps it. */
export const FACETS: Readonly<Record<Facet, string>> = Object.freeze({
  engine: '`session.authz` answers check, explain and checkMany (and can, assert, filter, filterNow, preload, invalidate, models where a step needs them) for the world: `permissions`, `combine`, the kit models of `world.models` (built with `instantiateWorld`), adapters, scope resolvers, relations and principals, at `world.now`, with the `engine`, `fields` and `audit` keys of `world.config`; `session.kit` is the KitWorld it built and its models are the instances the engine runs. A residual is evaluated against a subject with SQL three-valued logic (UNKNOWN does not allow), as the kit\'s `evaluateFilter` does. The README section "World → system" maps every world key.',
  boot: 'setup runs the boot checks of design §6.5 and rejects with their AuthzConfigError when the world breaks one.',
  audit: '`session.audit.entries` lists every DecisionAudit record the session made.',
  clock: "`session.clock` is the engine's time source: it starts at `world.now`, and `advance` moves request time, expiry and cache TTLs.",
  cache: "the L2 DecisionCache runs with `world.config.cache`; a repeated cacheable decision is served without calling the models, until its TTL or validUntil passes, a voting model's version changes, or the tag `subject:<principalKey>` of its principal or `model:<name>` of a voting model is invalidated.",
  host: '`authz.current()` and `authz.runAs()` work over the ALS store, and `session.domains` serves the child domains of `world.domains` (their own kit models, `combine` and `disable`).',
  bus: "`session.bus` is the ChangeBus every domain's AuthzService subscribes to; a published change invalidates their L2 and models.",
  rbac: "`world.rbac` roles (extends, grants with relation, on, fields) and assignments are loaded into the lane's RBAC model, named 'rbac'.",
  ladders: '`world.rbac.ladders`, implied roles, tags, provenance (`grantedAt`) and subject sets are honoured (L1b).',
  rules: '`world.rbac.rules` (restrict, cap, threshold) are loaded (L1b; L4b in SQL).',
  links: '`world.rbac.links` exist as share links whose tokens resolve to link principals (lane handle `rbacLinks`; L1b, L2, L5, C4).',
  abac: "`world.abac.policies` are loaded into the lane's ABAC model, named 'abac'.",
  conditions: 'the core ConditionCompiler is wired (`ctx.conditions`), so policy and rule conditions work (L3).',
  rebac: '`world.rebac.tuples` are loaded into a real ReBAC model (reserved for @spinajs/authz-rebac; the kit FakeTupleModel needs only `engine`).',
  admin: "`session.admin` is the domain's AuthzAdmin over the lane's stores, and lane handle `adminEvents` lists the AuthzEvents its sinks received (L9, C4).",
  scopeAttributes: '`world.scopeAttributes` (schemas and stored values) feed `ctx.attributes`, the store winning over resolver values (L9).',
  store: 'assignments, rules, links and policies live in the DB-backed stores, with `authz_version` bumps (lane handles `store` and `rbacStore`; L2).',
  list: "`session.list` returns the ids of the world rows a type-level residual selects, computed by the lane's own query side (in memory or SQL).",
  sql: '`session.list` runs on a SQL database holding the world rows, and lane handle `sqlPages` reads one page of a list (L4, L4b, K1).',
  orm: 'ORM queries on the @AccessResource models of `world.lane.orm` (lane handle `orm`; L4).',
  http: 'HTTP requests against the app built from `world.lane.http` (lane handle `http`; L5, C2–C7). Parts of L5 also use lane handle `linkSource`, parts of C4 `adminHttp`.',
  fs: 'the filesystems of `world.lane.fs` behind authz-fs, with `authz.fs.*` from `world.config.fs` (lane handle `fs`; L7).',
  queue: 'queue emit and handle with initiators over the jobs of `world.lane.queue` (lane handle `queue`; L6, C8).',
  socket: 'the socket handlers of `world.lane.socket` (lane handle `socket`; C9).',
  email: 'mail sending with attachments read from guarded filesystems (lane handle `email`; C9).',
  configuration: 'configuration-db-source polling over the rows of `world.lane.configuration` (lane handle `configuration`; C6).',
  token: 'tokens issued by authn and the principals the app resolves for them (lane handle `token`; C5).',
  authn: 'authn-http flows for world principals: login, MFA completion, role switch and impersonation start, each answering with the principal the session then yields (lane handle `authn`; C3).',
  impersonation: "users' AuthzImpersonationGuard: may an actor impersonate a target (lane handle `impersonationGuard`; C3). The impersonation flow itself is `authn`.",
  canvas: 'the canvas C6 facade over the §8.5 config (a lane handle K1 declares).',
});

/** A world principal by its key in `World.principals`, a principal object (SYSTEM, UNATTENDED, …), or '$current' (`authz.current()`). */
export type Who = string | Principal;

export interface CombineRoute {
  readonly algorithm: CombiningAlgorithm;
  /** Model names in config order. */
  readonly models: readonly string[];
}

/** `authz.combine` (design §8.1). */
export interface CombineConfig {
  readonly default: CombineRoute;
  readonly types?: Readonly<Record<ResourceType, CombineRoute>>;
}

/** A kit fake as data; `instantiateWorld` builds it. */
export type KitModelSpec = StaticModelSpec | FakeRbacSpec | FakeTupleSpec;

export interface StaticModelSpec extends StaticModelOptions {
  readonly kind: 'static';
  readonly name: string;
}

export interface FakeRbacSpec extends FakeRbacOptions {
  readonly kind: 'fake-rbac';
}

export interface FakeTupleSpec extends Omit<FakeTupleModelOptions, 'store'> {
  readonly kind: 'fake-tuple';
  /** Written to the world's one FakeTupleStore, which every fake-tuple model of the world shares. */
  readonly tuples?: readonly Tuple[];
}

export interface RelationSpec {
  readonly type: ResourceType;
  readonly relation: string;
  readonly holds: HoldsFn;
}

/** A child domain (design §15.3): models registered in the child, merged with the parent's by name. */
export interface WorldDomain {
  /** Default 'root'. */
  readonly parent?: string;
  /** Default: the parent's. */
  readonly combine?: CombineConfig;
  readonly models?: readonly KitModelSpec[];
  /** Parent model names dropped in this domain (`authz.domains.<name>.disable`). */
  readonly disable?: readonly string[];
}

export interface WorldLink extends LinkDef {
  /** The bearer secret the lane's link store accepts for this link. */
  readonly token: string;
  /** The link's own assignment (`link:<id>` holds `role` at `scope`). */
  readonly role: string;
  readonly tags?: readonly string[];
  readonly revoked?: boolean;
}

/** Data for the lane's RBAC model; the authz-rbac types accept these shapes as they are. */
export interface RbacWorld {
  readonly roles?: readonly TestRoleDef[];
  readonly ladders?: readonly TestLadderDef[];
  readonly assignments?: readonly Assignment[];
  readonly rules?: readonly RuleDef[];
  readonly links?: readonly WorldLink[];
}

export interface AbacWorld {
  readonly policies: readonly Policy[];
}

export interface RebacWorld {
  readonly tuples: readonly Tuple[];
}

export interface ScopeAttributeWorld {
  readonly schemas?: readonly ScopeAttributeSchema[];
  /** Stored values (ScopeAttributeStore rows). */
  readonly values?: readonly { readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>> }[];
}

/** Overrides of `authz.*` keys (design §8.1); model sections (`rbac`, `abac`, …) go under their names. */
export interface WorldConfig {
  readonly engine?: { readonly explain?: boolean; readonly modelTimeoutMs?: number; readonly maxDelegation?: number };
  readonly fields?: { readonly neverRead?: readonly string[]; readonly write?: { readonly mode: 'strip' | 'reject' } };
  readonly cache?: { readonly maxEntries?: number; readonly ttlSeconds?: number };
  readonly audit?: { readonly denials?: boolean; readonly runAs?: boolean; readonly unscoped?: boolean };
  readonly principals?: { readonly anonymous?: { readonly enabled?: boolean } };
  readonly [section: string]: unknown;
}

/**
 * Everything a case runs against, as data. Kit fakes (`models`, `adapters`, `scopes`, `relations`) are
 * specs that `instantiateWorld` turns into objects; `rbac`, `abac`, `rebac` and `scopeAttributes`
 * are for the lane's real models and stores.
 */
export interface World {
  /** Request time. Required when anything in the world or the case expires or the clock moves. */
  readonly now?: Date;
  readonly permissions: readonly FakePermissionInput[];
  readonly combine: CombineConfig;
  /** Kit models of the root domain, in registration order. */
  readonly models?: readonly KitModelSpec[];
  /** In a world with `rbac`, an adapter whose spec leaves `compiles` out also compiles `native:rbac.assignment` and `native:rbac.threshold` (RFC L1-2). */
  readonly adapters?: readonly FakeAdapterOptions[];
  readonly scopes?: readonly FakeScopeResolverOptions[];
  readonly relations?: readonly RelationSpec[];
  readonly principals?: Readonly<Record<string, Principal>>;
  readonly domains?: Readonly<Record<string, WorldDomain>>;
  readonly rbac?: RbacWorld;
  readonly abac?: AbacWorld;
  readonly rebac?: RebacWorld;
  readonly scopeAttributes?: ScopeAttributeWorld;
  readonly config?: WorldConfig;
}

// ---------------------------------------------------------------------------------------------
// Expectations

/** The call throws an error whose class (or an ancestor class) has this name, e.g. 'AuthzConfigError'. */
export interface Throws {
  readonly throws: string;
  /** Each string appears in the message; `$domain` stands for the name of the harness's root domain. */
  readonly message?: readonly string[];
}

/** A code, or a subset of the reason's keys (code plus payload, e.g. `{ code: 'model_error', model: 'm1' }`). */
export type ReasonExpectation = string | (Readonly<Record<string, unknown>> & { readonly code: string });

/**
 * 'conditional': neither TRUE nor FALSE. `equals`: deep-equal after `simplify`. `selects`: the ids of the
 * world rows (of the decision's or filter's type) the residual holds for, by the kit's `evaluateFilter`.
 */
export type ResidualExpectation = 'TRUE' | 'FALSE' | 'conditional' | { readonly equals: ResourceFilter } | { readonly selects: readonly string[] };

/** Field paths the glob list must allow and deny. */
export interface FieldsProbe {
  readonly allows?: readonly string[];
  readonly denies?: readonly string[];
}

/** Every key given is checked; a key left out is not. */
export interface DecisionExpectation {
  readonly allowed?: boolean;
  /** null: no reason. */
  readonly reason?: ReasonExpectation | null;
  readonly residual?: ResidualExpectation;
  readonly fields?: { readonly read?: FieldsProbe; readonly write?: FieldsProbe };
  readonly roles?: Readonly<Record<string, string>>;
  /** null: no validUntil. */
  readonly validUntil?: Date | null;
  /** true/false: a trace is present/absent; `votes`: the trace holds a vote of each of these models (any order). */
  readonly trace?: boolean | { readonly votes: readonly string[] };
  /** null: no actor. */
  readonly actor?: PrincipalRef | null;
  /** `$domain` stands for the name of the harness's root domain. */
  readonly domain?: string;
}

/** Calls recorded by a kit StaticModel (`world.models` or a domain's), counted from setup. */
export interface CallsExpectation {
  readonly model: string;
  readonly domain?: string;
  /** Default 'evaluate'. */
  readonly method?: ModelCall['method'];
  readonly count?: number;
  readonly atLeast?: number;
  /** Deep-equal to the args of the last such call. */
  readonly lastArgs?: readonly unknown[];
}

/** Audit entries matching every key given; `count` exact, else at least one. */
export interface AuditExpectation {
  readonly kind: AuditEntry['kind'];
  readonly reason?: string;
  readonly permission?: Permission;
  readonly principal?: Who;
  readonly count?: number;
}

/** Published AuthzChanges holding all these tags; `count` exact, else at least one. */
export interface PublishedExpectation {
  readonly tags: readonly string[];
  readonly count?: number;
}

export interface SummaryExpectation {
  /** Present in the combined GLOBAL permissions, with `conditional` when given. */
  readonly permissions?: readonly { readonly name: Permission; readonly conditional?: boolean }[];
  readonly absent?: readonly Permission[];
}

// ---------------------------------------------------------------------------------------------
// Steps

export interface CheckRequest {
  /** The principal checked. */
  readonly as: Who;
  /** A permission name; an unregistered one is allowed (B02 expects the throw). */
  readonly permission: Permission;
  /** Default: type-level (the engine uses `{ type: def.resource }`). */
  readonly resource?: ResourceRef;
  /** 'row': the world row of `resource` (or what `session.load` returns for it). */
  readonly subject?: 'row' | object;
  readonly actor?: Who;
  readonly env?: Readonly<Record<string, unknown>>;
  /** A child domain of `world.domains` (host facet); default root. */
  readonly domain?: string;
}

export interface ManyRequest {
  readonly as: Who;
  readonly permissions: readonly Permission[];
  readonly resource?: ResourceRef;
  readonly domain?: string;
}

export interface FilterRequest {
  readonly as: Who;
  readonly permission: Permission;
  readonly type: ResourceType;
  readonly domain?: string;
}

/** B06: for each principal, permission and world row of `type`, `check(subject = row).allowed` ⇔ the row is in the filter's rows. */
export interface AgreeRequest {
  readonly as: readonly Who[];
  readonly permissions: readonly Permission[];
  readonly type: ResourceType;
  readonly domain?: string;
}

export interface CheckStep {
  readonly check: CheckRequest;
  readonly expect: DecisionExpectation | Throws;
}

export interface ExplainStep {
  readonly explain: CheckRequest;
  readonly expect: DecisionExpectation | Throws;
}

export interface CanStep {
  readonly can: CheckRequest;
  readonly expect: boolean | Throws;
}

/** `authz.assert`: on a deny it throws AccessDenied (expect `{ throws: 'AccessDenied' }`). */
export interface AssertStep {
  readonly assert: CheckRequest;
  readonly expect: DecisionExpectation | Throws;
}

export interface CheckManyStep {
  readonly checkMany: ManyRequest;
  readonly expect: Readonly<Record<Permission, DecisionExpectation>> | Throws;
}

export interface FilterStep {
  readonly filter: FilterRequest;
  readonly expect: ResidualExpectation | Throws;
}

export interface FilterNowStep {
  readonly filterNow: FilterRequest;
  /** 'undefined': the engine declines to answer synchronously. */
  readonly expect: ResidualExpectation | 'undefined' | Throws;
}

export interface AgreeStep {
  readonly agree: AgreeRequest;
}

export interface SummaryStep {
  readonly summary: { readonly as: Who; readonly at?: ResourceRef; readonly domain?: string };
  readonly expect: SummaryExpectation;
}

export interface CoversStep {
  readonly covers: { readonly holder: Who; readonly target: Who; readonly at?: ResourceRef; readonly domain?: string };
  readonly expect: boolean;
}

export interface PreloadStep {
  readonly preload: Who;
  readonly domain?: string;
}

export interface InvalidateStep {
  readonly invalidate: readonly string[];
  readonly domain?: string;
}

/** clock facet: move time forward by this many milliseconds. */
export interface AdvanceStep {
  readonly advance: number;
}

/** bus facet: publish an AuthzChange (`at` = the clock's now, else `world.now`, else the real now). */
export interface PublishStep {
  readonly publish: { readonly tags: readonly string[]; readonly domain?: string; readonly actor?: PrincipalRef };
}

/** host facet: run the nested steps under `authz.runAs(as, reason, …)`. */
export interface RunAsStep {
  readonly runAs: { readonly as: Who; readonly reason: string };
  readonly steps: readonly Step[];
}

/** host facet: `authz.current()` is this principal (by identity for SYSTEM and UNATTENDED, else by type and id). */
export interface CurrentStep {
  readonly current: Who;
}

/** The names of `authz.models()` (any order). */
export interface ModelsStep {
  readonly models: readonly string[];
  readonly domain?: string;
}

/** host facet: dispose a child domain. */
export interface DisposeDomainStep {
  readonly disposeDomain: string;
}

export interface CallsStep {
  readonly calls: CallsExpectation;
}

export interface AuditStep {
  readonly audit: AuditExpectation;
}

export interface PublishedStep {
  readonly published: PublishedExpectation;
}

/** Escape hatch for flows the steps above cannot say; use node:assert inside. */
export interface DoStep {
  readonly do: (ctx: StepContext) => void | Promise<void>;
  /** Shown in failure messages. */
  readonly note?: string;
}

export type Step = CheckStep | ExplainStep | CanStep | AssertStep | CheckManyStep | FilterStep | FilterNowStep | AgreeStep | SummaryStep | CoversStep | PreloadStep | InvalidateStep | AdvanceStep | PublishStep | RunAsStep | CurrentStep | ModelsStep | DisposeDomainStep | CallsStep | AuditStep | PublishedStep | DoStep;

// ---------------------------------------------------------------------------------------------
// Fixtures

/** The case expects setup to reject (a world the boot checks refuse). */
export interface BootExpectation extends Throws {
  /** Also accept a setup that succeeds when the steps then throw as they expect ("at boot or call", B02). */
  readonly orAtCall?: boolean;
}

export interface Case {
  /** Mocha title after the part id: `B03.core <name>`. */
  readonly name: string;
  /** Default: the part's world. */
  readonly world?: World;
  readonly boot?: BootExpectation;
  readonly steps: readonly Step[];
}

export interface FixturePart {
  /** 'core', 'rbac', 'cache', …: selected as `B09.<name>`. */
  readonly name: string;
  readonly facets: readonly Facet[];
  /** The plan lanes whose acceptance names this part. */
  readonly lanes: readonly string[];
  /** Why the part has no cases yet, or what it leaves out. */
  readonly note?: string;
  readonly world?: World;
  readonly cases: readonly Case[];
}

export interface BehaviourFixture {
  readonly id: BehaviourId;
  /** Verbatim from design §17. */
  readonly rule: string;
  readonly parts: readonly FixturePart[];
}

/** More parts for a fixture, from another file; a part with cases replaces a declared part of the same name that has none. */
export interface FixtureExtension {
  readonly id: BehaviourId;
  readonly parts: readonly FixturePart[];
}

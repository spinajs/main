import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, GLOBAL, engineLog, principalKey, resourceKey, unionFieldGlobs } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext, FieldSet, ModelCapabilities, ModelInitContext, ModelSummary, Permission, PermissionDef, PermissionRegistry, Principal, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import type { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore, SubjectResolver } from '../contracts.js';
import { AssignmentCache, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS } from './cache.js';
import { RBAC_SUMMARY_STEPS, createRbacExtensions, extendRbacInput, liveAssignments, rbacTables, readRbacInput, resourcePath, runRbacPipeline } from './evaluate.js';
import { effectiveRole } from './ladder/steps.js';
import { ruleStoreParts } from './rules/extension.js';
import { unlessRowRules } from './rules/steps.js';
import type { LiveAssignment, RbacExtension, RbacInput, RbacSources } from './evaluate.js';
import { compileGrants } from './grants.js';
import type { GrantIndex } from './grants.js';
import { assignmentProblem, compileRoles } from './roles.js';
import { RbacSubjectResolver, WILDCARD_ID, groupPrincipalConfig } from './sets/resolver.js';
import type { AssignmentProblem, CompileRolesOptions, RoleGraph } from './roles.js';
import { isTokenRoleExtension, tokenRoleExtension } from '../token/extension.js';

export interface RbacModelOptions {
  readonly roles: RoleStore;
  readonly assignments: AssignmentStore;
  /** Default: RbacSubjectResolver (principal, companions, group member set, subject sets), with `authz.rbac.groupPrincipal`. */
  readonly subjects?: SubjectResolver;
  /** At most one in-memory store (ConfigRuleStore) and one other (DbRuleStore), design §8.5. */
  readonly rules?: RuleStore | readonly RuleStore[];
  readonly links?: LinkStore;
  /** The closure of subject sets (design §4.3); absent: sets are one level deep. */
  readonly membership?: MembershipStore;
  /** Default: one instance from each factory of DEFAULT_RBAC_EXTENSIONS, built with these options. The model adds tokenRoleExtension last either way. */
  readonly extensions?: readonly RbacExtension[];
  /** Default: the host log under the name 'authz-rbac'. */
  readonly log?: { warn(message: string): void };
  /** Times the assignment cache TTL and the role version check; default: the system clock. */
  readonly clock?: { now(): Date };
}

interface Loaded {
  readonly version: string;
  readonly graph: RoleGraph;
  readonly registry: PermissionRegistry;
  readonly anonymousRoles: readonly string[];
  readonly serviceRoles: ReadonlyMap<string, readonly string[]>;
  readonly assignments: AssignmentCache;
  readonly rolesCheckMs: number;
}

const PROBLEM_TEXT: Readonly<Record<AssignmentProblem, string>> = {
  unknown_role: 'is not defined',
  not_assignable: 'is not assignable',
  wrong_scope_type: 'cannot be assigned at $global (scopeTypes)',
};

/** The RBAC model (design §6.1). Register it per domain, next to its RbacContributor; it carries no `@Injectable`. */
export class RbacModel extends AuthorizationModel {
  readonly name = 'rbac';
  readonly capabilities: ModelCapabilities;
  readonly extensions: readonly RbacExtension[];

  private readonly log: { warn(message: string): void };
  private loaded?: Loaded;
  private grants?: GrantIndex;
  private readonly warnedRoles = new Set<string>();
  private readonly warnedAssignments = new Set<string>();
  /*
   * Role reload (§6.1.2 "compile on RoleStore version change"): every stale mark bumps roleMarks; the
   * roles are fresh while rolesFreshAt has caught up. A reload records the mark it started at, so a
   * mark that lands during it leaves the roles stale and the next request reloads again.
   */
  private roleMarks = 0;
  private rolesFreshAt = 0;
  private reloading?: Promise<void>;
  private checking?: Promise<void>;
  private lastRoleCheck = 0;
  /** A reload or version check failed and none has succeeded since. */
  private rolesBroken = false;
  private defaultResolver?: RbacSubjectResolver;

  constructor(private readonly opts: RbacModelOptions) {
    super();
    this.log = opts.log ?? engineLog('authz-rbac');
    // The token role rules run on every model and last: a later gather that returns fresh assignments
    // or a fresh request would undo them, and an app that passes `extensions` must not lose them.
    const given = opts.extensions ?? createRbacExtensions(opts);
    const token = given.find(isTokenRoleExtension) ?? tokenRoleExtension(opts);
    this.extensions = Object.freeze([...given.filter((e) => !isTokenRoleExtension(e)), token]);
    // Only the ops the votes emit: the boot refuses a declared native op without its filter (§6.5 rule 4).
    const residuals = [...new Set([...CORE_FILTER_OPS, ...this.extensions.flatMap((e) => e.residuals ?? [])])];
    this.capabilities = Object.freeze({
      effects: Object.freeze(['permit', 'deny'] as const),
      residuals: Object.freeze(residuals),
      sync: 'after-preload',
      fields: true,
      needsSubject: this.extensions.some((e) => e.capabilities?.needsSubject === true),
      resourceTypes: '*',
    });
  }

  async init(ctx: ModelInitContext): Promise<void> {
    for (const ext of this.extensions) await ext.init?.(ctx);
    if (!this.opts.subjects) this.defaultResolver = new RbacSubjectResolver({ groupPrincipal: groupPrincipalConfig(ctx) });
    const version = await this.opts.roles.version();
    const { roles, ladders } = await this.opts.roles.load();
    const graph = compileRoles(roles, ladders, { extraEdges: this.extraEdges() });
    for (const ext of this.extensions) for (const filter of ext.nativeFilters?.() ?? []) ctx.registerNativeFilter(filter);
    const { rolesCheckMs, ...cache } = cacheConfig(ctx);
    const assignments = new AssignmentCache(this.opts.assignments, { ...cache, clock: this.clock(), model: this.name });
    this.loaded = { version, graph, registry: ctx.permissions, anonymousRoles: anonymousRoles(ctx, graph), serviceRoles: serviceRoles(ctx, graph), assignments, rolesCheckMs };
    this.grants = undefined;
    this.roleMarks = 0;
    this.rolesFreshAt = 0;
    this.reloading = undefined;
    this.checking = undefined;
    this.lastRoleCheck = this.clock().now().getTime();
    this.rolesBroken = false;
  }

  /** The compiled role graph. @throws AuthzConfigError before `init` */
  roleGraph(): RoleGraph {
    return this.state().graph;
  }

  /** The permission registry of the domain where `init` ran. @throws AuthzConfigError before `init` */
  permissions(): PermissionRegistry {
    return this.state().registry;
  }

  /**
   * The grant index, compiled on first use (the registry is complete only after every model's init),
   * then the extensions' compile hooks; the contributor calls it at boot.
   * @throws UnknownPermission or AuthzConfigError for a bad grant (B02) or a failing compile hook
   */
  grantIndex(): GrantIndex {
    if (this.grants) return this.grants;
    const { graph, registry } = this.state();
    this.grants = this.compileIndex(graph, registry);
    return this.grants;
  }

  applies(permission: PermissionDef, _type: ResourceType): boolean {
    const index = this.grantIndex();
    return index.granted(permission.name) || index.denied(permission.name);
  }

  /**
   * A Vote without IO when the roles are fresh, the principal's assignments are cached and the
   * request is type-level (B22), else a promise.
   */
  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    this.state();
    if (this.rolesFreshAt < this.roleMarks) return this.ensureRoles().then(() => this.evaluateNow(req, ctx));
    return this.evaluateNow(req, ctx);
  }

  private evaluateNow(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    const input = readRbacInput(req, ctx, this.sources());
    return input instanceof Promise ? input.then((i) => runRbacPipeline(i)) : runRbacPipeline(input);
  }

  /**
   * §5.5: the roles that hold at `at` after the ceiling (as Vote.roles reads them), and every
   * permission a check would permit for some row. Each permission runs the pipeline, so an entry
   * agrees with the votes: `conditional` unless every vote permits every row and denies none.
   * - At `$global` each permission is judged per type T of its `types`, on `{ type: T }` (path
   *   `[{ type: T }, GLOBAL]`), so type and glob patterns and bare-type and scoped assignments count;
   *   a request on `$global` itself is concrete and would miss them. Listed when some T permits
   *   and does not deny everything; `fields` is the union over the permitting Ts.
   * - `fields` of each vote are those of every grant that permits some row (RBAC_SUMMARY_STEPS),
   *   not the vote's own rule, which leaves out a conditional or scoped grant's fields when an
   *   unconditional grant exists: the entry never shows fewer fields than the target gets on a row.
   * - At any other `at`, the permission is judged at `at`, if its `types` hold `at`'s type.
   * - `roles` lists only the assignments that hold at `at` (at `$global`: GLOBAL ones), after
   *   restrict and cap, each with its effective role; permissions from bare-type or scoped
   *   assignments appear without their roles. At a bare type (`{ type }`), rules that apply per
   *   row are not run, so `roles` there are before those rules (permissions are still conditional).
   * - Rules that would apply per row of a type-level probe (RuleRowsError) are left out of that
   *   probe, and its permissions are listed as conditional: rules only narrow, so nothing is lost.
   */
  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    await this.freshRoles();
    const sources = this.sources();
    const { registry } = this.state();
    const atGlobal = at.type === GLOBAL.type && at.id == null;
    const typed = (types: readonly string[]): ResourceRef[] => (atGlobal && types.length > 0 ? types.map((type) => ({ type })) : [at]);
    const held = async (ref: ResourceRef) => unlessRowRules(await readRbacInput({ principal, permission: ROLES_PROBE, resource: ref }, ctx, sources), (i) => liveAssignments(i)).value;
    const { live } = await held(at);
    const names = new Set<string>();
    for (const ref of typed([...new Set(registry.all().flatMap((d) => d.types))])) {
      const { live: here, scoped } = await held(ref);
      for (const l of [...here, ...scoped]) for (const p of sources.grants.permissions(l.role)) names.add(p);
    }
    const permissions: { name: Permission; conditional: boolean; fields?: FieldSet }[] = [];
    for (const name of [...names].sort()) {
      const def = registry.get(name);
      if (def === undefined || (!atGlobal && !def.types.includes(at.type))) continue;
      const votes: Vote[] = [];
      let exact = true;
      for (const ref of typed(def.types)) {
        const run = unlessRowRules(await readRbacInput({ principal, permission: name, resource: ref }, ctx, sources), (i) => runRbacPipeline(i, RBAC_SUMMARY_STEPS));
        votes.push(run.value);
        exact &&= run.exact;
      }
      const permitting = votes.filter((v) => v.permitWhen.op !== 'false' && v.denyWhen.op !== 'true');
      if (permitting.length === 0) continue;
      const conditional = !exact || !votes.every((v) => v.permitWhen.op === 'true' && v.denyWhen.op === 'false');
      const fields = permitting.every((v) => v.fields) ? { read: unionFieldGlobs(...permitting.map((v) => v.fields!.read ?? ['*'])), write: unionFieldGlobs(...permitting.map((v) => v.fields!.write ?? ['*'])) } : undefined;
      permissions.push({ name, conditional, ...(fields ? { fields } : {}) });
    }
    const { ladders } = rbacTables(this.extensions, sources.roles, sources.grants);
    const roles = live.map((l) => ({ role: effectiveRole(ladders, l), scope: l.scope, ...(l.expiresAt ? { expiresAt: l.expiresAt.toISOString() } : {}) }));
    return { model: this.name, roles, permissions };
  }

  /**
   * For RbacService.rolesOf: the gathered input of a request by `principal` at `at`, the roles
   * reloaded first when stale. Run liveAssignments over it.
   */
  async inputAt(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<RbacInput> {
    await this.freshRoles();
    return readRbacInput({ principal, permission: ROLES_PROBE, resource: at }, ctx, this.sources());
  }

  /**
   * For RbacService.covers, synchronous: the live assignments of `principal` at `at` read from the
   * request snapshot in `ctx` (then at ctx.now), else from the cache across requests (at the model clock),
   * ceiling.roles applied. Without ancestors, the path is `at` and
   * GLOBAL only (and, at a type, that type).
   * @throws AuthzConfigError when the roles are stale, the subjects or an extension's gather need IO
   *   (with a rule store that is not in memory, such as DbRuleStore, at every `at`, GLOBAL included),
   *   the assignments are not cached, or `at` is not GLOBAL while an in-memory store has a live
   *   rule (never a guess)
   */
  heldNow(principal: Principal, at: ResourceRef = GLOBAL, ctx?: EvaluationContext): readonly LiveAssignment[] {
    this.state();
    if (this.rolesFreshAt < this.roleMarks) throw new AuthzConfigError('rbac: the role definitions are stale and not reloaded yet; preload the principal or run a check first');
    // Rules at ancestors, and rules that read their attributes or ranks, need the full path, which a synchronous read does not have.
    const now = ctx?.now ?? this.clock().now();
    if (!(at.type === GLOBAL.type && at.id == null) && this.rulesMayApply(now)) throw new AuthzConfigError(`rbac: rules need the full path of ${resourceKey(at)}; use RbacService.coversAt`);
    const loaded = this.state();
    const sources = this.sources();
    const subjects = this.resolver().subjects(principal);
    if (isThenable(subjects)) {
      Promise.resolve(subjects).catch(() => undefined);
      throw new AuthzConfigError('rbac: the subject resolver needs IO; covers of a principal needs subjects it can answer at once');
    }
    const peek = (list: readonly AssignmentSubject[]) => {
      const rows = loaded.assignments.peek(list, now, ctx);
      if (rows === undefined) throw new AuthzConfigError(`rbac: the assignments of ${principal.type}:${principal.id} are not preloaded (or their cache entry expired); preload the principal first`);
      return rows;
    };
    const rows = peek(subjects as readonly AssignmentSubject[]);
    const request: DecisionRequest = { principal, permission: ROLES_PROBE, resource: at };
    const path = at.id == null ? (resourcePath(at, NO_CONTEXT) as readonly ResourceRef[]) : [at, GLOBAL];
    const base: RbacInput = { request, now, path, subjects: subjects as readonly AssignmentSubject[], assignments: [...rows, ...configAssignments(loaded, subjects as readonly AssignmentSubject[])], roles: sources.roles, grants: sources.grants, ...(sources.onUnknownRole ? { onUnknownRole: sources.onUnknownRole } : {}), ...(sources.onRefusedAssignment ? { onRefusedAssignment: sources.onRefusedAssignment } : {}) };
    // Subject sets read their rows through `load`: from the cache here, never the store.
    const input = extendRbacInput(request, NO_CONTEXT, { ...sources, load: peek, setsOf: undefined }, base);
    if (input instanceof Promise) {
      input.catch(() => undefined);
      throw new AuthzConfigError("rbac: an extension's gather needs IO; covers of a principal cannot answer at once");
    }
    return liveAssignments(input).live;
  }

  /** The link store of the options (share links, design §6.1.6). */
  get linkStore(): LinkStore | undefined {
    return this.opts.links;
  }

  /** The model clock's now (assignment cache TTL, covers). */
  currentTime(): Date {
    return this.clock().now();
  }

  private async freshRoles(): Promise<void> {
    this.state();
    if (this.rolesFreshAt < this.roleMarks) await this.ensureRoles();
  }

  private sources(): RbacSources {
    const loaded = this.state();
    return {
      roles: loaded.graph,
      grants: this.grantIndex(),
      assignments: this.opts.assignments,
      subjects: this.resolver(),
      rules: this.opts.rules,
      links: this.opts.links,
      extensions: this.extensions,
      configAssignments: (subjects) => configAssignments(loaded, subjects),
      load: (subjects, c) => loaded.assignments.read(subjects, c),
      ...(this.opts.membership ? { setsOf: (keys: readonly string[], ctx: EvaluationContext) => this.setsOf(keys, ctx) } : {}),
      onUnknownRole: (a) => this.unknownRole(a),
      onRefusedAssignment: (a, problem) => this.refusedAssignment(a, problem),
    };
  }

  /** One store read per request and member key list; the assignment cache is the cross-request cache. */
  private setsOf(memberKeys: readonly string[], ctx: EvaluationContext): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> {
    const key = `${SETS_MEMO}${ctx.now.getTime()}:${JSON.stringify([...memberKeys].sort())}`;
    let read = ctx.cache.get(key) as Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> | undefined;
    if (!read) {
      read = this.opts.membership!.setsOf(memberKeys, ctx.now);
      ctx.cache.set(key, read);
      read.catch(() => ctx.cache.delete(key));
    }
    return read;
  }

  /**
   * Reloads stale roles (and checks the role store version every `cache.rolesCheckSeconds`), then
   * loads the assignments of the principal's subjects into the request (ctx.cache) and across
   * requests (per subject, TTL): through the gathering phase, so the subject sets the extensions
   * add are loaded too (one store read for the principal and its companions, one for its sets).
   */
  async preload(principal: Principal, ctx: EvaluationContext): Promise<void> {
    const { rolesCheckMs } = this.state();
    const now = this.clock().now().getTime();
    if (rolesCheckMs > 0 && (now - this.lastRoleCheck >= rolesCheckMs || now < this.lastRoleCheck)) await this.checkRoleVersion();
    await this.ensureRoles();
    await readRbacInput({ principal, permission: ROLES_PROBE, resource: GLOBAL }, ctx, this.sources());
  }

  /**
   * Drops cached assignments (AssignmentCache.invalidate). A `role:` or `model:rbac` tag, `*`, an
   * unknown tag or a malformed list also marks the roles stale: the next request re-reads the role
   * store version and recompiles when it changed.
   */
  invalidate(tags: readonly string[]): void {
    if (!this.loaded) return;
    this.loaded.assignments.invalidate(tags);
    if (touchesRoles(tags, this.name)) this.roleMarks++;
  }

  /**
   * The role store version the roles were compiled from. After a failed reload or version check it
   * is a distinct stale value, so the host drops decisions cached under the old roles and recompiles
   * its routes, while the votes fail closed.
   */
  version(): string {
    if (!this.loaded) return '';
    return this.rolesBroken ? `${this.loaded.version}#stale:${this.roleMarks}` : this.loaded.version;
  }

  private extraEdges(): CompileRolesOptions['extraEdges'] {
    const sources = this.extensions.flatMap((e) => (e.extraEdges ? [e.extraEdges] : []));
    if (sources.length === 0) return undefined;
    return (defs, ladders) => sources.flatMap((edges) => [...edges(defs, ladders)]);
  }

  private compileIndex(graph: RoleGraph, registry: PermissionRegistry): GrantIndex {
    const index = compileGrants(graph, registry);
    for (const ext of this.extensions) ext.compile?.(graph, index, registry);
    for (const { role, glob } of index.unmatchedGlobs) this.log.warn(`rbac role '${role}' grants '${glob}', which matches no registered permission`);
    for (const { role, glob } of index.droppedFields) this.log.warn(`rbac role '${role}' grants '${glob}' with fields, but no permission it matches takes fields; the fields are ignored`);
    return index;
  }

  /** Resolves once the roles are at least as fresh as the latest stale mark seen now; one reload runs at a time. */
  private async ensureRoles(): Promise<void> {
    const wanted = this.roleMarks;
    while (this.rolesFreshAt < wanted) {
      if (!this.reloading) {
        const run: Promise<void> = this.reloadRoles().finally(() => {
          if (this.reloading === run) this.reloading = undefined;
        });
        this.reloading = run;
      }
      await this.reloading;
    }
  }

  /*
   * Fails closed: roles that do not load or compile (or drop a config role) reject every vote that
   * needs them, and the next request tries again. Keeping the last good graph would keep granting
   * what the operator just removed.
   */
  private async reloadRoles(): Promise<void> {
    const mark = this.roleMarks;
    try {
      // Version before load: a version read after the load could label older content as newer.
      const version = await this.opts.roles.version();
      const base = this.state();
      if (version !== base.version) {
        const { roles, ladders } = await this.opts.roles.load();
        const graph = compileRoles(roles, ladders, { extraEdges: this.extraEdges() });
        const grants = this.compileIndex(graph, base.registry);
        refuseConfigRoles(graph, base);
        this.loaded = { ...this.state(), version, graph };
        this.grants = grants;
      }
      this.lastRoleCheck = this.clock().now().getTime();
      if (mark > this.rolesFreshAt) this.rolesFreshAt = mark;
      this.rolesBroken = false;
    } catch (e) {
      this.rolesBroken = true;
      this.log.warn(`rbac: reloading the role definitions failed; RBAC votes fail until a reload succeeds: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  /** Marks the roles stale when the store version moved; one check runs at a time. An unreadable version marks them stale too (fail closed). */
  private checkRoleVersion(): Promise<void> {
    if (this.checking) return this.checking;
    const run: Promise<void> = (async () => {
      try {
        const version = await this.opts.roles.version();
        this.lastRoleCheck = this.clock().now().getTime();
        if (version !== this.state().version) this.roleMarks++;
      } catch (e) {
        this.roleMarks++;
        this.rolesBroken = true;
        throw e;
      }
    })().finally(() => {
      if (this.checking === run) this.checking = undefined;
    });
    this.checking = run;
    return run;
  }

  /** Whether the rule stores may hold a rule live at `now`: always with a store that is not in memory. */
  private rulesMayApply(now: Date): boolean {
    const { config, db } = ruleStoreParts(this.opts.rules);
    if (db) return true;
    return config ? config.all().some((r) => r.expiresAt == null || r.expiresAt.getTime() > now.getTime()) : false;
  }

  /** The SubjectResolver of the options, else the RbacSubjectResolver built at init. */
  private resolver(): SubjectResolver {
    return this.opts.subjects ?? this.defaultResolver ?? new RbacSubjectResolver();
  }

  private clock(): { now(): Date } {
    return this.opts.clock ?? SYSTEM_CLOCK;
  }

  private state(): Loaded {
    if (!this.loaded) throw new AuthzConfigError("RBAC model 'rbac' is used before its init ran");
    return this.loaded;
  }

  private unknownRole(a: Assignment): void {
    if (this.warnedRoles.has(a.role)) return;
    this.warnedRoles.add(a.role);
    this.log.warn(`rbac: assignment '${a.id}' (source: ${a.source}) names unknown role '${a.role}'; assignments of this role are ignored`);
  }

  private refusedAssignment(a: Assignment, problem: Exclude<AssignmentProblem, 'unknown_role'>): void {
    if (this.warnedAssignments.has(a.id)) return;
    this.warnedAssignments.add(a.id);
    const why = problem === 'not_assignable' ? `role '${a.role}' is not assignable` : `the scopeTypes of role '${a.role}' leave out '${a.scope.type}'`;
    this.log.warn(`rbac: assignment '${a.id}' (source: ${a.source}) at ${resourceKey(a.scope)} is ignored: ${why}`);
  }
}

// The configuration schema checks the shapes; whether a role exists and is assignable needs the role graph.
// An unvalidated configuration still gets here, and a string would be read as one role name per character.
function anonymousRoles(ctx: ModelInitContext, graph: RoleGraph): readonly string[] {
  const value = ctx.config<readonly string[]>('anonymousRoles', []);
  if (!Array.isArray(value)) throw new AuthzConfigError('authz.rbac.anonymousRoles must be an array of role names');
  for (const role of value) refuseConfigRole(graph, role, 'authz.rbac.anonymousRoles');
  return Object.freeze([...value]);
}

function serviceRoles(ctx: ModelInitContext, graph: RoleGraph): ReadonlyMap<string, readonly string[]> {
  const value = ctx.config<Readonly<Record<string, readonly string[]>>>('serviceRoles', {});
  const out = new Map<string, readonly string[]>();
  for (const [key, roles] of Object.entries(value)) {
    if (!Array.isArray(roles)) throw new AuthzConfigError(`authz.rbac.serviceRoles['${key}'] must be an array of role names`);
    for (const role of roles) refuseConfigRole(graph, role, `authz.rbac.serviceRoles['${key}']`);
    out.set(key, Object.freeze([...roles]));
  }
  return out;
}

/** The config roles read at init must still be assignable at GLOBAL in a reloaded graph. */
function refuseConfigRoles(graph: RoleGraph, loaded: Loaded): void {
  for (const role of loaded.anonymousRoles) refuseConfigRole(graph, role, 'authz.rbac.anonymousRoles');
  for (const [key, roles] of loaded.serviceRoles) for (const role of roles) refuseConfigRole(graph, role, `authz.rbac.serviceRoles['${key}']`);
}

/** Tags that cannot reach role definitions leave them alone; everything else may (fail safe). */
const NOT_ROLE_PREFIXES = ['subject:', 'scope:', 'link:', 'policy:', 'rule:', 'model:'];

function touchesRoles(tags: readonly string[], model: string): boolean {
  if (!Array.isArray(tags)) return true;
  return (tags as readonly unknown[]).some((t) => typeof t !== 'string' || t.startsWith('role:') || t === `model:${model}` || !NOT_ROLE_PREFIXES.some((p) => t.startsWith(p)));
}

function refuseConfigRole(graph: RoleGraph, role: string, where: string): void {
  const problem = assignmentProblem(graph, role, GLOBAL);
  if (problem) throw new AuthzConfigError(`${where}: role '${role}' ${PROBLEM_TEXT[problem]}`);
}

function configAssignments(loaded: Loaded, subjects: readonly AssignmentSubject[]): Assignment[] {
  const out: Assignment[] = [];
  const add = (subject: AssignmentSubject, roles: readonly string[], source: string) => {
    for (const role of roles) out.push({ id: `${source}:${role}`, subject, role, scope: GLOBAL, source });
  };
  for (const s of subjects) {
    // Config roles belong to the principal itself; its wildcard would add them twice.
    if ('set' in s || s.id === WILDCARD_ID) continue;
    if (s.type === 'anonymous') add(s, loaded.anonymousRoles, 'config:anonymousRoles');
    const service = loaded.serviceRoles.get(principalKey(s));
    if (service) add(s, service, 'config:serviceRoles');
  }
  return out;
}

const SYSTEM_CLOCK = { now: () => new Date() };

function cacheConfig(ctx: ModelInitContext): { ttlMs: number; maxEntries: number; rolesCheckMs: number } {
  const ttl = ctx.config<number>('cache.assignmentsTtlSeconds', DEFAULT_ASSIGNMENTS_TTL_SECONDS);
  const max = ctx.config<number>('cache.maxSubjects', DEFAULT_MAX_CACHED_SUBJECTS);
  const check = ctx.config<number>('cache.rolesCheckSeconds', DEFAULT_ROLES_CHECK_SECONDS);
  // An unvalidated configuration still gets here: NaN, Infinity or a string would keep assignments, or roles, unchecked forever.
  if (!Number.isFinite(ttl)) throw new AuthzConfigError('authz.rbac.cache.assignmentsTtlSeconds must be a finite number of seconds');
  if (!Number.isFinite(check)) throw new AuthzConfigError('authz.rbac.cache.rolesCheckSeconds must be a finite number of seconds');
  return { ttlMs: ttl * 1000, maxEntries: max, rolesCheckMs: check * 1000 };
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null | undefined)?.then === 'function';

/** The permission of the requests that only read which roles hold (steps 1–3 never read it). */
const ROLES_PROBE: Permission = 'rbac:roles';

const SETS_MEMO = '\u0000rbac:sets:';

/** The context of a synchronous read: an extension's gather that touches it fails, never guesses. */
const NO_CONTEXT = new Proxy({} as EvaluationContext, {
  get(_target, key) {
    if (key === 'then') return undefined;
    throw new AuthzConfigError(`rbac: no evaluation context in a synchronous read (asked for '${String(key)}')`);
  },
});

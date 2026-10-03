import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, GLOBAL, engineLog, principalKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext, ModelCapabilities, ModelInitContext, PermissionDef, PermissionRegistry, Principal, ResourceType, Vote } from '@spinajs/authz';

import type { AssignmentStore, LinkStore, RoleStore, RuleStore, SubjectResolver } from '../contracts.js';
import { AssignmentCache, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_MAX_CACHED_SUBJECTS } from './cache.js';
import { createRbacExtensions, defaultSubjects, readRbacInput, runRbacPipeline } from './evaluate.js';
import type { RbacExtension } from './evaluate.js';
import { compileGrants } from './grants.js';
import type { GrantIndex } from './grants.js';
import { assignmentProblem, compileRoles } from './roles.js';
import type { AssignmentProblem, CompileRolesOptions, RoleGraph } from './roles.js';

export interface RbacModelOptions {
  readonly roles: RoleStore;
  readonly assignments: AssignmentStore;
  /** Default: the principal and its companions. */
  readonly subjects?: SubjectResolver;
  readonly rules?: RuleStore;
  readonly links?: LinkStore;
  /** Default: one instance from each factory of DEFAULT_RBAC_EXTENSIONS, built with these options. */
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

export const DEFAULT_ROLES_CHECK_SECONDS = 60;

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

  constructor(private readonly opts: RbacModelOptions) {
    super();
    this.log = opts.log ?? engineLog('authz-rbac');
    this.extensions = opts.extensions ? Object.freeze([...opts.extensions]) : createRbacExtensions(opts);
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
    return this.grantIndex().granted(permission.name);
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
    const loaded = this.state();
    const input = readRbacInput(req, ctx, {
      roles: loaded.graph,
      grants: this.grantIndex(),
      assignments: this.opts.assignments,
      subjects: this.opts.subjects,
      rules: this.opts.rules,
      links: this.opts.links,
      extensions: this.extensions,
      configAssignments: (subjects) => configAssignments(loaded, subjects),
      load: (subjects, c) => loaded.assignments.read(subjects, c),
      onUnknownRole: (a) => this.unknownRole(a),
    });
    return input instanceof Promise ? input.then((i) => runRbacPipeline(i)) : runRbacPipeline(input);
  }

  /**
   * Reloads stale roles (and checks the role store version every `cache.rolesCheckSeconds`), then
   * loads the assignments of the principal's subjects into the request (ctx.cache) and across
   * requests (per subject, TTL).
   */
  async preload(principal: Principal, ctx: EvaluationContext): Promise<void> {
    const { rolesCheckMs } = this.state();
    const now = this.clock().now().getTime();
    if (rolesCheckMs > 0 && (now - this.lastRoleCheck >= rolesCheckMs || now < this.lastRoleCheck)) await this.checkRoleVersion();
    await this.ensureRoles();
    const subjects = this.opts.subjects ? await this.opts.subjects.subjects(principal) : defaultSubjects(principal);
    await this.state().assignments.read(subjects, ctx);
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
}

function anonymousRoles(ctx: ModelInitContext, graph: RoleGraph): readonly string[] {
  const value = ctx.config<unknown>('anonymousRoles', []);
  if (!isNameList(value)) throw new AuthzConfigError('authz.rbac.anonymousRoles must be an array of role names');
  for (const role of value) refuseConfigRole(graph, role, 'authz.rbac.anonymousRoles');
  return Object.freeze([...value]);
}

function serviceRoles(ctx: ModelInitContext, graph: RoleGraph): ReadonlyMap<string, readonly string[]> {
  const value = ctx.config<unknown>('serviceRoles', {});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AuthzConfigError("authz.rbac.serviceRoles must map principal keys ('service:<id>') to arrays of role names");
  const out = new Map<string, readonly string[]>();
  for (const [key, roles] of Object.entries(value)) {
    if (!isNameList(roles)) throw new AuthzConfigError(`authz.rbac.serviceRoles['${key}'] must be an array of role names`);
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
    if ('set' in s) continue;
    if (s.type === 'anonymous') add(s, loaded.anonymousRoles, 'config:anonymousRoles');
    const service = loaded.serviceRoles.get(principalKey(s));
    if (service) add(s, service, 'config:serviceRoles');
  }
  return out;
}

const SYSTEM_CLOCK = { now: () => new Date() };

function cacheConfig(ctx: ModelInitContext): { ttlMs: number; maxEntries: number; rolesCheckMs: number } {
  const ttl = ctx.config<unknown>('cache.assignmentsTtlSeconds', DEFAULT_ASSIGNMENTS_TTL_SECONDS);
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) throw new AuthzConfigError('authz.rbac.cache.assignmentsTtlSeconds must be a finite number of seconds, 0 or more');
  const max = ctx.config<unknown>('cache.maxSubjects', DEFAULT_MAX_CACHED_SUBJECTS);
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) throw new AuthzConfigError('authz.rbac.cache.maxSubjects must be an integer, 0 or more');
  const check = ctx.config<unknown>('cache.rolesCheckSeconds', DEFAULT_ROLES_CHECK_SECONDS);
  if (typeof check !== 'number' || !Number.isFinite(check) || check < 0) throw new AuthzConfigError('authz.rbac.cache.rolesCheckSeconds must be a finite number of seconds, 0 or more');
  return { ttlMs: ttl * 1000, maxEntries: max, rolesCheckMs: check * 1000 };
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');

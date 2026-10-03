import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, GLOBAL, engineLog, principalKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext, ModelCapabilities, ModelInitContext, PermissionDef, PermissionRegistry, ResourceType, Vote } from '@spinajs/authz';

import type { AssignmentStore, LinkStore, RoleStore, RuleStore, SubjectResolver } from '../contracts.js';
import { createRbacExtensions, gatherRbacInput, runRbacPipeline } from './evaluate.js';
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
}

interface Loaded {
  readonly version: string;
  readonly graph: RoleGraph;
  readonly registry: PermissionRegistry;
  readonly anonymousRoles: readonly string[];
  readonly serviceRoles: ReadonlyMap<string, readonly string[]>;
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
    this.loaded = { version, graph, registry: ctx.permissions, anonymousRoles: anonymousRoles(ctx, graph), serviceRoles: serviceRoles(ctx, graph) };
    this.grants = undefined;
  }

  /** The compiled role graph. @throws AuthzConfigError before `init` */
  roleGraph(): RoleGraph {
    return this.state().graph;
  }

  /**
   * The grant index, compiled on first use (the registry is complete only after every model's init),
   * then the extensions' compile hooks; the contributor calls it at boot.
   * @throws UnknownPermission or AuthzConfigError for a bad grant (B02) or a failing compile hook
   */
  grantIndex(): GrantIndex {
    if (this.grants) return this.grants;
    const { graph, registry } = this.state();
    const index = compileGrants(graph, registry);
    for (const ext of this.extensions) ext.compile?.(graph, index, registry);
    for (const { role, glob } of index.unmatchedGlobs) this.log.warn(`rbac role '${role}' grants '${glob}', which matches no registered permission`);
    for (const { role, glob } of index.droppedFields) this.log.warn(`rbac role '${role}' grants '${glob}' with fields, but no permission it matches takes fields; the fields are ignored`);
    this.grants = index;
    return index;
  }

  applies(permission: PermissionDef, _type: ResourceType): boolean {
    return this.grantIndex().granted(permission.name);
  }

  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const loaded = this.state();
    const input = await gatherRbacInput(req, ctx, {
      roles: loaded.graph,
      grants: this.grantIndex(),
      assignments: this.opts.assignments,
      subjects: this.opts.subjects,
      rules: this.opts.rules,
      links: this.opts.links,
      extensions: this.extensions,
      configAssignments: (subjects) => configAssignments(loaded, subjects),
      onUnknownRole: (a) => this.unknownRole(a),
    });
    return runRbacPipeline(input);
  }

  version(): string {
    return this.loaded?.version ?? '';
  }

  private extraEdges(): CompileRolesOptions['extraEdges'] {
    const sources = this.extensions.flatMap((e) => (e.extraEdges ? [e.extraEdges] : []));
    if (sources.length === 0) return undefined;
    return (defs, ladders) => sources.flatMap((edges) => [...edges(defs, ladders)]);
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

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');

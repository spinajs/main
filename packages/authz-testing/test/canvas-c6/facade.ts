import type { Decision as EngineDecision, DenyReason as EngineDenyReason, Principal as EnginePrincipal, ResourceRef } from '@spinajs/authz';

import { agentPrincipal as kitAgentPrincipal, groupPrincipal, userPrincipal } from '../../src/index.js';
import type { Capability, Role } from './c6/access.js';
import { Authz } from './c6/authz.js';
import type { Decision, DenyReason, Principal, Resource } from './c6/authz.js';
import { capabilityPermission, orgLevelPermissions } from './config.js';
import { branchRef } from './scope.js';

export interface CheckRequest {
  readonly principal: EnginePrincipal;
  readonly permission: string;
  readonly resource: ResourceRef;
}

export interface C6FacadeDeps {
  /** The domain's AuthzService.check (or anything with that signature). */
  check(req: CheckRequest): Promise<EngineDecision>;
  /** RbacService.linkPrincipal of the domain's RbacModel. */
  linkPrincipal(id: string, companion?: EnginePrincipal): Promise<EnginePrincipal>;
  /** C6 link uuid -> authz link id, from loadCanvasState. */
  linkIds: ReadonlyMap<string, string>;
  /** The capability table (readCapabilities output or the raw JSON). */
  capabilities: unknown;
  /** C6 file uuid -> project uuid, for the agent scope check. */
  fileProject(file: string): string | undefined;
}

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** An agent scope the agent source refuses at creation (§16.3 point 4). */
export class AgentScopeError extends Error {}

export const toPermission = (capability: Capability | string): string => capabilityPermission(capability);

export function toResourceRef(resource: Resource): ResourceRef {
  switch (resource.kind) {
    case 'org':
      return { type: 'org', id: resource.org };
    case 'project':
      return { type: 'project', id: resource.project };
    case 'file':
      return { type: 'file', id: resource.file };
    case 'branch':
      return branchRef(resource.project, resource.file, resource.branch);
  }
}

/**
 * Design §8.5 "Agent session". A ceiling's `resources` is any-of while C6 wants a listed project
 * and a listed file, so listed files must lie in listed projects and then stand alone.
 */
export function agentPrincipal(agent: AgentPrincipal, fileProject: (file: string) => string | undefined): EnginePrincipal {
  const { scope } = agent;
  let resources: ResourceRef[];
  if (scope.files === null) {
    resources = scope.projects.map((id) => ({ type: 'project', id }));
  } else {
    for (const file of scope.files) {
      const project = fileProject(file);
      if (project === undefined) throw new AgentScopeError(`agent ${agent.session}: unknown file ${file}`);
      if (!scope.projects.includes(project)) throw new AgentScopeError(`agent ${agent.session}: file ${file} lies in project ${project}, outside the listed projects`);
    }
    resources = scope.files.map((id) => ({ type: 'file', id }));
  }
  return kitAgentPrincipal(agent.session, userPrincipal(agent.on_behalf_of), {
    delegation: 'inherit',
    permissions: scope.capabilities.map(toPermission),
    resources,
  });
}

export async function toPrincipal(principal: Principal, deps: Pick<C6FacadeDeps, 'linkPrincipal' | 'linkIds' | 'fileProject'>): Promise<EnginePrincipal> {
  switch (principal.kind) {
    case 'user':
      return userPrincipal(principal.user);
    case 'group':
      return groupPrincipal(principal.group);
    case 'link':
      // An unknown C6 id goes through as is: the link store does not know it, so the ceiling covers nothing (B42).
      return deps.linkPrincipal(deps.linkIds.get(principal.link) ?? principal.link, principal.user === null ? undefined : userPrincipal(principal.user));
    case 'agent':
      return agentPrincipal(principal, deps.fileProject);
  }
}

const ENGINE_ONLY_KEYS = new Set(['code', 'model', 'priority', 'sortKey', 'ladder']);

function pick(r: EngineDenyReason, code: string, keys: readonly string[]): DenyReason {
  const out: Record<string, unknown> = { code };
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
  return out as unknown as DenyReason;
}

const SAME_CODE: Readonly<Record<string, readonly string[]>> = {
  policy: ['rule'],
  branch_protected: ['pattern', 'needed'],
  link_invalid: [],
  out_of_scope: [],
  agents_disabled: [],
  no_access: [],
  unknown_resource: [],
};

/** Engine reason -> C6 reason; a code C6 does not know keeps its engine name so a conformance run shows it. */
export function toDenyReason(r: EngineDenyReason, orgLevel: boolean): DenyReason {
  if (orgLevel && (r.code === 'role_too_low' || r.code === 'no_access')) return { code: 'org_role_needed' };
  switch (r.code) {
    case 'tag_missing':
      return { code: 'addon_missing', addon: r.tag } as DenyReason;
    case 'provenance':
      return { code: 'file_only' };
    case 'role_too_low':
      return { code: 'role_too_low', role: (r.role ?? 'none') as Role, needed: r.needed as Role };
  }
  const keys = SAME_CODE[r.code];
  if (keys) return pick(r, r.code, keys);
  const out: Record<string, unknown> = { code: r.code };
  for (const [k, v] of Object.entries(r)) if (!ENGINE_ONLY_KEYS.has(k)) out[k] = v;
  return out as unknown as DenyReason;
}

/**
 * Engine decision -> C6 decision. A conditional residual is no allow for a check without a subject,
 * so it becomes the deny code `residual`, which C6 does not have.
 */
export function toDecision(d: EngineDecision, permission: string, orgPermissions: ReadonlySet<string> | readonly string[]): Decision {
  if (d.allowed) {
    if (d.residual.op === 'true') return { allowed: true, role: (d.roles.project ?? 'none') as Role };
    return { allowed: false, reason: { code: 'residual' } as unknown as DenyReason };
  }
  const orgLevel = 'has' in orgPermissions ? orgPermissions.has(permission) : orgPermissions.includes(permission);
  if (!d.reason) return { allowed: false, reason: { code: 'no_reason' } as unknown as DenyReason };
  return { allowed: false, reason: toDenyReason(d.reason, orgLevel) };
}

/** C6's `Authz` over the engine's check: shapes and names only, no decision of its own (design §16.4). */
export class C6Facade extends Authz {
  private readonly orgPermissions: ReadonlySet<string>;

  constructor(private readonly deps: C6FacadeDeps) {
    super();
    this.orgPermissions = new Set(orgLevelPermissions(deps.capabilities));
  }

  async can(principal: Principal, capability: Capability, resource: Resource): Promise<Decision> {
    const permission = toPermission(capability);
    const decision = await this.deps.check({ principal: await toPrincipal(principal, this.deps), permission, resource: toResourceRef(resource) });
    return toDecision(decision, permission, this.orgPermissions);
  }
}

// Source: contracts/ts/server-api/src/reference.ts at coderush/canvas 1803e0c
import {
  type Addon,
  type Capability,
  capabilityInfo,
  defaultAddons,
  maxRole,
  minRole,
  type OrgRole,
  type Role,
  roleAtLeast,
} from "./access.js";
import { allow, Authz, type Decision, deny, type PolicyRule, type Principal, type Resource } from "./authz.js";
import type { AccessState, Grantee, Org } from "./state.js";

interface Target {
  org: string;
  project: string | null;
  file: string | null;
  branch: string | null;
}

interface Access {
  role: Role;
  /** Role from project-derived grants only; project-wide capabilities need it. */
  project_role: Role;
  addons: ReadonlySet<Addon>;
  /** False when all access comes from file grants or a file link. */
  via_project: boolean;
  org_admin: boolean;
}

const isOrgAdmin = (role: OrgRole | undefined): boolean => role === "owner" || role === "admin";

/**
 * Reference role evaluation: the flow chart of access design §1 in code,
 * step by step as the plan's "The evaluation flow" lists it. It is the
 * conformance oracle for every other `Authz`.
 */
export function evaluate(state: AccessState, principal: Principal, capability: Capability, resource: Resource): Decision {
  const target = resolve(state, resource);
  if (target === null) return deny({ code: "unknown_resource" });
  const org = state.orgs.get(target.org)!;

  if (principal.kind === "agent") {
    if (!org.policies.agents_allowed) return deny({ code: "agents_disabled" });
    const { scope } = principal;
    const projectOk = target.project !== null && scope.projects.includes(target.project);
    const fileOk = scope.files === null || (target.file !== null && scope.files.includes(target.file));
    if (!projectOk || !fileOk || !scope.capabilities.includes(capability)) return deny({ code: "out_of_scope" });
    return evaluate(state, { kind: "user", user: principal.on_behalf_of }, capability, resource);
  }

  const info = capabilityInfo(capability);
  if (info.min_role === null) return orgLevel(org, principal, info.org_role);
  if (target.project === null) return deny({ code: "no_access" });

  const access = effectiveAccess(state, org, principal, target);
  if ("code" in access) return deny(access);
  const { role } = access;
  if (!roleAtLeast(role, info.min_role)) return deny({ code: "role_too_low", role, needed: info.min_role });
  if (info.addon !== null && !access.addons.has(info.addon)) return deny({ code: "addon_missing", addon: info.addon });
  if (info.project_wide && !access.via_project) return deny({ code: "file_only" });
  if (info.project_wide && !roleAtLeast(access.project_role, info.min_role)) {
    return deny({ code: "role_too_low", role: access.project_role, needed: info.min_role });
  }

  const policies = org.policies;
  const gatingRole = info.project_wide ? access.project_role : role;
  let rule: PolicyRule | null = null;
  if ((capability === "export" || capability === "repo.read") && !roleAtLeast(gatingRole, "editor") && !policies.viewers_may_download) {
    rule = "no_download";
  } else if (capability === "grants.invite" && gatingRole === "editor" && !policies.editors_may_invite) {
    rule = "editors_may_not_invite";
  } else if (capability === "project.delete" && !access.org_admin && !policies.maintainers_may_delete) {
    rule = "delete_needs_org_admin";
  }
  if (rule !== null) return deny({ code: "policy", rule });

  if (target.branch !== null && info.branch_write) {
    const rules = [...state.projects.get(target.project)!.branch_rules].sort((a, b) => compareCodePoints(a.pattern, b.pattern));
    for (const branchRule of rules) {
      if (!globMatch(branchRule.pattern, target.branch)) continue;
      const needed = capability === "branch.merge" ? branchRule.merge_role : branchRule.push_role;
      if (!roleAtLeast(gatingRole, needed)) return deny({ code: "branch_protected", pattern: branchRule.pattern, needed });
    }
  }
  return allow(role);
}

function resolve(state: AccessState, resource: Resource): Target | null {
  const inProject = (project: string, file: string | null, branch: string | null): Target | null => {
    const org = state.projects.get(project)?.org;
    return org !== undefined && state.orgs.has(org) ? { org, project, file, branch } : null;
  };
  switch (resource.kind) {
    case "org":
      return state.orgs.has(resource.org) ? { org: resource.org, project: null, file: null, branch: null } : null;
    case "project":
      return inProject(resource.project, null, null);
    case "file": {
      const file = state.files.get(resource.file);
      return file === undefined ? null : inProject(file.project, resource.file, null);
    }
    case "branch":
      if (resource.file !== null && state.files.get(resource.file)?.project !== resource.project) return null;
      return inProject(resource.project, resource.file, resource.branch);
  }
}

function orgLevel(org: Org, principal: Principal, needed: "admin" | "owner" | null): Decision {
  const orgRole = principal.kind === "user" ? org.members.get(principal.user) : undefined;
  const allowed = needed === "owner" ? orgRole === "owner" : isOrgAdmin(orgRole);
  return allowed ? allow("maintainer") : deny({ code: "org_role_needed" });
}

type Denied = { code: "no_access" } | { code: "link_invalid" };

function effectiveAccess(state: AccessState, org: Org, principal: Principal, target: Target): Access | Denied {
  const user = principal.kind === "user" ? principal.user : principal.kind === "link" ? principal.user : null;
  const ownGroup = principal.kind === "group" ? principal.group : null;
  const linkId = principal.kind === "link" ? principal.link : null;
  const orgRole = user === null ? undefined : org.members.get(user);
  if (isOrgAdmin(orgRole)) {
    return { role: "maintainer", project_role: "maintainer", addons: new Set(["inspect", "code"]), via_project: true, org_admin: true };
  }

  const groups = new Set<string>();
  if (ownGroup !== null) groups.add(ownGroup);
  else if (user !== null) for (const [id, g] of state.groups) if (g.members.has(user)) groups.add(id);
  const matches = (grantee: Grantee): boolean =>
    grantee.kind === "user" ? grantee.id === user : groups.has(grantee.id);

  const project = state.projects.get(target.project!)!;
  let projectGrants: { role: Role; addons: readonly Addon[] }[] = project.grants.filter((g) => matches(g.grantee));
  if (orgRole === "member") {
    projectGrants.push({ role: project.org_default_role, addons: defaultAddons(project.org_default_role) });
  }
  const fileGrants: { role: Role; addons: readonly Addon[] }[] = [];

  if (linkId !== null) {
    const link = state.links.get(linkId);
    if (link === undefined) return { code: "link_invalid" };
    const covers = link.project === target.project && (link.file === null || link.file === target.file);
    const member = orgRole !== undefined && orgRole !== "file_guest";
    const needsMember = link.org_only || !org.policies.public_links;
    if (link.expired || !covers || (needsMember && !member)) return { code: "link_invalid" };
    const role = minRole(minRole(link.role, org.policies.max_link_role), "commenter");
    const addons = org.policies.addons_for_guests ? link.addons : [];
    (link.file !== null ? fileGrants : projectGrants).push({ role, addons });
  }

  if (target.file !== null) {
    const file = state.files.get(target.file)!;
    if (file.restricted_to !== null && !file.restricted_to.some(matches)) projectGrants = [];
    // File grants are never Maintainer (access design §1.4).
    for (const g of file.grants) if (matches(g.grantee)) fileGrants.push({ role: minRole(g.role, "editor"), addons: g.addons });
  }

  const viaProject = projectGrants.some((g) => g.role !== "none");
  const all = [...projectGrants, ...fileGrants];
  let role = all.reduce<Role>((best, g) => maxRole(best, g.role), "none");
  let addons = new Set<Addon>(all.flatMap((g) => g.addons));
  if (role === "none") return { code: "no_access" };

  const policies = org.policies;
  const external = user !== null && (orgRole === undefined || orgRole === "file_guest");
  const cap: Role =
    orgRole === "guest" ? minRole(policies.guest_max_role, "editor") : external ? policies.external_max_role : "maintainer";
  role = minRole(role, cap);
  const projectRole = minRole(projectGrants.reduce<Role>((best, g) => maxRole(best, g.role), "none"), cap);
  if ((external || orgRole === "guest") && !policies.addons_for_guests) addons = new Set();
  return { role, project_role: projectRole, addons, via_project: viaProject, org_admin: false };
}

const STAR = 0x2a;

/** `*` matches any run of characters, `/` included. */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let from = 0;
  while (t < text.length) {
    const c = pattern.charCodeAt(p);
    if (c === STAR) {
      star = p++;
      from = t;
    } else if (p < pattern.length && c === text.charCodeAt(t)) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++from;
    } else {
      return false;
    }
  }
  while (pattern.charCodeAt(p) === STAR) p++;
  return p === pattern.length;
}

/** UTF-16 `<` misorders astral characters; Postgres `COLLATE "C"` sorts by code point. */
function compareCodePoints(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length; ) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** `Authz` over an `AccessState` in memory. */
export class ReferenceAuthz extends Authz {
  public constructor(public readonly state: AccessState) {
    super();
  }

  public can(principal: Principal, capability: Capability, resource: Resource): Promise<Decision> {
    return Promise.resolve(evaluate(this.state, principal, capability, resource));
  }
}

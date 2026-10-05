// Source: contracts/ts/server-api/src/authz.ts at coderush/canvas 1803e0c
import { type Addon, CAPABILITY_NAMES, type Capability, type Role } from "./access.js";

/** What an agent session may touch: the task scope and the agent profile. */
export interface AgentScope {
  projects: readonly string[];
  /** `null` allows every file of the listed projects. */
  files: readonly string[] | null;
  capabilities: readonly Capability[];
}

export type Principal =
  | { kind: "user"; user: string }
  /** The group's own grants, for share dialogs and audits. */
  | { kind: "group"; group: string }
  /** Someone using a share link; `user` is set when they are signed in. */
  | { kind: "link"; link: string; user: string | null }
  /** Capabilities are the delegator's (checked live) ∩ the scope. */
  | { kind: "agent"; session: string; task: string; on_behalf_of: string; scope: AgentScope };

export type Resource =
  | { kind: "org"; org: string }
  | { kind: "project"; project: string }
  | { kind: "file"; file: string }
  | { kind: "branch"; project: string; file: string | null; branch: string };

export type PolicyRule = "no_download" | "editors_may_not_invite" | "delete_needs_org_admin";

export type DenyReason =
  | { code: "unknown_resource" }
  | { code: "no_access" }
  | { code: "role_too_low"; role: Role; needed: Role }
  | { code: "addon_missing"; addon: Addon }
  | { code: "policy"; rule: PolicyRule }
  /** A project-wide capability asked by someone with file grants only. */
  | { code: "file_only" }
  | { code: "branch_protected"; pattern: string; needed: Role }
  | { code: "org_role_needed" }
  | { code: "agents_disabled" }
  | { code: "out_of_scope" }
  | { code: "link_invalid" };

/** `role` is the effective role on the resource. */
export type Decision = { allowed: true; role: Role } | { allowed: false; reason: DenyReason };

export const allow = (role: Role): Decision => ({ allowed: true, role });
export const deny = (reason: DenyReason): Decision => ({ allowed: false, reason });

/**
 * `can()` from the access design. S3 implements it over Postgres. Also the
 * DI token: `@Autoinject(Authz)` in routes and server plugins, which must
 * call it before acting (access design §2).
 */
export abstract class Authz {
  public abstract can(principal: Principal, capability: Capability, resource: Resource): Promise<Decision>;
}

export interface Granted {
  /** `none` when nothing is allowed. */
  role: Role;
  capabilities: Capability[];
}

/**
 * Every capability the principal holds on the resource, in wire order. Used
 * for realtime tickets and `Joined`; implementations may answer faster.
 */
export async function grantedCapabilities(authz: Authz, principal: Principal, resource: Resource): Promise<Granted> {
  let role: Role = "none";
  const capabilities: Capability[] = [];
  for (const capability of CAPABILITY_NAMES) {
    const decision = await authz.can(principal, capability, resource);
    if (decision.allowed) {
      capabilities.push(capability);
      role = decision.role;
    }
  }
  return { role, capabilities };
}

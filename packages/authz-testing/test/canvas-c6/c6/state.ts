// Source: contracts/ts/server-api/src/state.ts at coderush/canvas 1803e0c
import type { Addon, OrgRole, Role } from "./access.js";

/** The part of `org.policies` that changes decisions (access design §1). */
export interface OrgPolicies {
  agents_allowed: boolean;
  public_links: boolean;
  /** Export and clone for Viewers and Commenters (footnote 1). */
  viewers_may_download: boolean;
  editors_may_invite: boolean;
  /** Lets project Maintainers delete a project without an org admin. */
  maintainers_may_delete: boolean;
  max_link_role: Role;
  guest_max_role: Role;
  external_max_role: Role;
  /** Governs invitations of external people; `evaluate()` does not read it. */
  external_sharing: boolean;
  /** Whether guests, file-only guests and links may hold Inspect and Code. */
  addons_for_guests: boolean;
}

export const DEFAULT_ORG_POLICIES: Readonly<OrgPolicies> = Object.freeze({
  agents_allowed: true,
  public_links: true,
  viewers_may_download: true,
  editors_may_invite: true,
  maintainers_may_delete: false,
  max_link_role: "commenter",
  guest_max_role: "editor",
  external_max_role: "commenter",
  external_sharing: true,
  addons_for_guests: true,
});

export interface Org {
  policies: OrgPolicies;
  members: ReadonlyMap<string, OrgRole>;
}

export interface Group {
  org: string;
  members: ReadonlySet<string>;
}

export interface Grantee {
  kind: "user" | "group";
  id: string;
}

export interface Grant {
  grantee: Grantee;
  role: Role;
  addons: readonly Addon[];
}

/** Every matching rule applies; a denial names the first failing one in code-point order of `pattern`. */
export interface BranchRule {
  /** Branch name where `*` matches any run of characters, `/` included. */
  pattern: string;
  merge_role: Role;
  push_role: Role;
}

export interface Project {
  org: string;
  /** Role of every org Member who has no better grant. */
  org_default_role: Role;
  grants: readonly Grant[];
  branch_rules: readonly BranchRule[];
}

export interface File {
  project: string;
  grants: readonly Grant[];
  /** When set, only these grantees keep project-derived access. */
  restricted_to: readonly Grantee[] | null;
}

export interface ShareLink {
  project: string;
  /** Set for a link to a single file. */
  file: string | null;
  role: Role;
  addons: readonly Addon[];
  expired: boolean;
  /** Only signed-in org members may use it. */
  org_only: boolean;
}

/**
 * In-memory mirror of the access tables (access design §1, "Tables"). Ids
 * are UUID strings. S3 keeps the same data in Postgres.
 */
export interface AccessState {
  orgs: ReadonlyMap<string, Org>;
  groups: ReadonlyMap<string, Group>;
  projects: ReadonlyMap<string, Project>;
  files: ReadonlyMap<string, File>;
  links: ReadonlyMap<string, ShareLink>;
}

export function emptyAccessState(): AccessState {
  return { orgs: new Map(), groups: new Map(), projects: new Map(), files: new Map(), links: new Map() };
}

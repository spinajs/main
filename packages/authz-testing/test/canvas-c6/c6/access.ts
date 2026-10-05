// Source: contracts/ts/server-api/src/access.ts at coderush/canvas 1803e0c
/** Project or file role, weakest first (access design §1). */
export const ROLES = ["none", "viewer", "commenter", "editor", "maintainer"] as const;
export type Role = (typeof ROLES)[number];

export const ORG_ROLES = ["owner", "admin", "member", "guest", "file_guest"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Add-on permissions that travel with a grant, apart from its role (§1.3). */
export const ADDONS = ["inspect", "code"] as const;
export type Addon = (typeof ADDONS)[number];

export interface CapabilityInfo {
  readonly name: string;
  /** Lowest project role that holds it; `null` for org-level capabilities. */
  readonly min_role: Role | null;
  /** Org role needed for org-level capabilities. */
  readonly org_role: "admin" | "owner" | null;
  readonly addon: Addon | null;
  /** Needs project-derived access; file-only users never hold it (§1.4). */
  readonly project_wide: boolean;
  /** Checked against the branch's protection rule when the resource is a branch. */
  readonly branch_write: boolean;
}

const cap = <N extends string>(
  name: N,
  min_role: Role | null,
  flags: { addon?: Addon; project_wide?: boolean; branch_write?: boolean; org_role?: "admin" | "owner" } = {},
): CapabilityInfo & { readonly name: N } => ({
  name,
  min_role,
  org_role: flags.org_role ?? null,
  addon: flags.addon ?? null,
  project_wide: flags.project_wide ?? false,
  branch_write: flags.branch_write ?? false,
});

/**
 * The capability table of access design §1–§2. The order is the wire order
 * shared with `CAPABILITY_NAMES` in `@canvas/api` (C2), the Rust
 * `server_api::Capability::ALL` and `fixtures/authz/capabilities.json`; a
 * new capability goes to the end of all of them in one change.
 */
export const CAPABILITIES = [
  cap("project.read", "viewer"),
  cap("export", "viewer"),
  cap("inspect.view", "viewer", { addon: "inspect" }),
  cap("code.view", "viewer", { addon: "code" }),
  cap("history.read", "viewer"),
  cap("repo.read", "viewer", { project_wide: true }),
  cap("presence.join", "viewer"),
  cap("comment.create", "commenter"),
  cap("comment.resolve", "commenter"),
  cap("mr.comment", "commenter", { project_wide: true }),
  cap("mr.approve", "editor", { project_wide: true }),
  cap("file.edit", "editor", { branch_write: true }),
  cap("branch.create", "editor", { project_wide: true }),
  cap("version.save", "editor", { branch_write: true }),
  cap("version.restore", "editor", { branch_write: true }),
  cap("mr.create", "editor", { project_wide: true }),
  cap("repo.push", "editor", { project_wide: true, branch_write: true }),
  cap("file.manage", "editor", { project_wide: true }),
  cap("library.read", "viewer", { project_wide: true }),
  cap("library.use", "editor", { project_wide: true }),
  cap("library.render", "viewer"),
  cap("branch.merge", "editor", { project_wide: true, branch_write: true }),
  cap("library.publish", "maintainer", { project_wide: true }),
  cap("project.settings", "maintainer", { project_wide: true }),
  cap("grants.invite", "editor", { project_wide: true }),
  cap("grants.manage", "maintainer", { project_wide: true }),
  cap("project.delete", "maintainer", { project_wide: true }),
  cap("org.manage", null, { org_role: "admin" }),
  cap("org.billing", null, { org_role: "owner" }),
  cap("audit.read", null, { org_role: "admin" }),
] as const satisfies readonly CapabilityInfo[];

export type Capability = (typeof CAPABILITIES)[number]["name"];

export const CAPABILITY_NAMES: readonly Capability[] = CAPABILITIES.map((c) => c.name);

const INFO = new Map<string, CapabilityInfo>(CAPABILITIES.map((c) => [c.name, c]));

export function isCapability(name: string): name is Capability {
  return INFO.has(name);
}

export function capabilityInfo(capability: Capability): CapabilityInfo {
  const info = INFO.get(capability);
  if (info === undefined) throw new TypeError(`unknown capability ${JSON.stringify(capability)}`);
  return info;
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleAtLeast(role: Role, needed: Role): boolean {
  return roleRank(role) >= roleRank(needed);
}

export function maxRole(a: Role, b: Role): Role {
  return roleAtLeast(a, b) ? a : b;
}

export function minRole(a: Role, b: Role): Role {
  return roleAtLeast(a, b) ? b : a;
}

/** Add-on defaults when granting: both for Editor and Maintainer, none below. */
export function defaultAddons(role: Role): Addon[] {
  return roleAtLeast(role, "editor") ? ["inspect", "code"] : [];
}

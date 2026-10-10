// Design §8.5: canvas generates `permissions` and `roles` from capabilities.json; the rest is fixed config.

export const PROJECT_LADDER = ['viewer', 'commenter', 'editor', 'maintainer'] as const;
export const ORG_LADDER = ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] as const;
export const PERMISSION_TYPES = ['org', 'project', 'file', 'branch'] as const;
// Group members are written at group:G, and AuthzAdmin checks the command's permission there (RFC K1-1).
const EXTRA_PERMISSION_TYPES: Readonly<Record<string, readonly string[]>> = { 'org:manage': ['group'] };

const PW = ['project', 'org'] as const;
const TABLE_KEYS = ['roles', 'addons', 'capabilities'];
const ROW_KEYS = ['name', 'min_role', 'org_role', 'addon', 'project_wide', 'branch_write'];
const TABLE_ROLES: readonly string[] = ['none', ...PROJECT_LADDER];
const ORG_ROLES: readonly string[] = ['admin', 'owner'];

export type ProjectRole = (typeof PROJECT_LADDER)[number];

export interface CapabilityRow {
  name: string;
  min_role: ProjectRole | null;
  org_role: 'admin' | 'owner' | null;
  addon: string | null;
  project_wide: boolean;
  branch_write: boolean;
}

export interface CapabilityTable {
  roles: string[];
  addons: string[];
  capabilities: CapabilityRow[];
}

export type CanvasGrant = string | { permission: string; requiresTag?: string; grantedAt?: string[] };

export interface CanvasImplies {
  role: string;
  at: 'self-and-descendants';
  tags: string[];
  bypass: ('restrict' | 'cap')[];
}

export interface CanvasRole {
  ladder?: 'project' | 'org';
  subjectSet?: true;
  grants: CanvasGrant[];
  implies?: CanvasImplies[];
}

export type CanvasRule = Record<string, unknown> & { id: string; kind: 'cap' | 'threshold' };
export type CanvasPolicy = Record<string, unknown> & { id: string };

export interface CanvasAuthzConfig {
  permissions: Record<string, { types: string[] }>;
  combine: { default: { algorithm: 'deny-overrides'; models: string[] } };
  rbac: {
    ladders: { project: { roles: string[]; resourceTypes: string[] }; org: { roles: string[] } };
    roles: Record<string, CanvasRole>;
    rules: CanvasRule[];
    stores: { roles: string[]; assignments: string[]; rules: string[]; links: string[] };
  };
  abac: { scopeResiduals: boolean; policies: CanvasPolicy[] };
}

export class CapabilityTableError extends Error {}

const fail = (path: string, what: string): never => {
  throw new CapabilityTableError(`${path}: ${what}`);
};

export function capabilityPermission(name: string): string {
  if (name === 'export') return 'project:export';
  if (typeof name !== 'string' || !/^[^.]+\.[^.]+$/.test(name)) throw new CapabilityTableError(`capability ${JSON.stringify(name)}: expected 'x.y' or 'export'`);
  return name.replace('.', ':');
}

function record(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${path}.${k}`, 'unknown key');
  for (const k of keys) if (!(k in o)) fail(`${path}.${k}`, 'missing');
  return o;
}

function names(v: unknown, path: string, allowed?: readonly string[]): string[] {
  if (!Array.isArray(v)) fail(path, 'expected a list');
  const out = (v as unknown[]).map((s, i) => {
    if (typeof s !== 'string' || s === '') fail(`${path}[${i}]`, 'expected a non-empty string');
    if (allowed && !allowed.includes(s as string)) fail(`${path}[${i}]`, `unknown value ${JSON.stringify(s)}`);
    return s as string;
  });
  if (new Set(out).size !== out.length) fail(path, 'duplicate entries');
  return out;
}

function nullableName(v: unknown, path: string, allowed: readonly string[]): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !allowed.includes(v)) fail(path, `expected null or one of ${allowed.join(', ')}`);
  return v as string;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v as boolean;
}

/** Strict parse of capabilities.json; keeps wire order. */
export function readCapabilities(json: unknown): CapabilityTable {
  const t = record(json, 'capabilities.json', TABLE_KEYS);
  const roles = names(t.roles, 'roles', TABLE_ROLES);
  // The engine ranks by the fixed project ladder, C6 by the list index; they must agree.
  if (roles.join() !== TABLE_ROLES.join()) fail('roles', `expected ${JSON.stringify(TABLE_ROLES)}`);
  const addons = names(t.addons, 'addons');
  if (!Array.isArray(t.capabilities)) fail('capabilities', 'expected a list');
  const seen = new Set<string>();
  const permissions = new Set<string>();
  const capabilities = (t.capabilities as unknown[]).map((raw, i): CapabilityRow => {
    const path = `capabilities[${i}]`;
    const r = record(raw, path, ROW_KEYS);
    if (typeof r.name !== 'string') fail(`${path}.name`, 'expected a string');
    const name = r.name as string;
    const permission = capabilityPermission(name);
    if (seen.has(name)) fail(`${path}.name`, `duplicate capability ${JSON.stringify(name)}`);
    if (permissions.has(permission)) fail(`${path}.name`, `duplicate permission ${JSON.stringify(permission)}`);
    seen.add(name);
    permissions.add(permission);
    const row: CapabilityRow = {
      name,
      min_role: nullableName(r.min_role, `${path}.min_role`, roles.filter((x) => x !== 'none')) as ProjectRole | null,
      org_role: nullableName(r.org_role, `${path}.org_role`, ORG_ROLES) as 'admin' | 'owner' | null,
      addon: nullableName(r.addon, `${path}.addon`, addons),
      project_wide: bool(r.project_wide, `${path}.project_wide`),
      branch_write: bool(r.branch_write, `${path}.branch_write`),
    };
    if ((row.min_role === null) === (row.org_role === null)) fail(path, 'needs exactly one of min_role and org_role');
    if (row.org_role !== null && (row.addon !== null || row.project_wide || row.branch_write)) fail(path, 'an org_role row takes no addon, project_wide or branch_write');
    return row;
  });
  return { roles, addons, capabilities };
}

function grantOf(row: CapabilityRow): CanvasGrant {
  const permission = capabilityPermission(row.name);
  if (row.addon === null && !row.project_wide) return permission;
  return { permission, ...(row.addon === null ? {} : { requiresTag: row.addon }), ...(row.project_wide ? { grantedAt: [...PW] } : {}) };
}

const canvasRules = (): CanvasRule[] => [
  { id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } },
  { id: 'link-cap', kind: 'cap', ladder: 'project', maxRole: 'commenter', assignments: { subjectTypes: ['link'] } },
  { id: 'link-org-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.max_link_role' }, assignments: { subjectTypes: ['link'] } },
  { id: 'guest-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'guest-org-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.guest_max_role' }, subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'external-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.external_max_role' }, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } } },
  {
    id: 'external-sharing-off',
    kind: 'cap',
    ladder: 'project',
    maxRole: null,
    subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } },
    assignments: { subjectTypes: ['user', 'group'] },
    when: { attr: 'scope.org.policies.external_sharing', eq: false },
  },
  { id: 'guest-addons', kind: 'cap', stripTags: true, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.member' } }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  { id: 'link-addons', kind: 'cap', stripTags: true, assignments: { subjectTypes: ['link'] }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  {
    id: 'link-members-only',
    kind: 'threshold',
    permissions: ['*'],
    subjects: { principalTypes: ['link'] },
    when: {
      any: [
        { attr: 'principal.attributes.org_only', eq: true },
        { attr: 'scope.org.policies.public_links', eq: false },
      ],
    },
    ladder: 'org',
    at: 'org',
    minRole: 'org.guest',
    reason: { code: 'link_invalid', priority: 300 },
  },
  { id: 'no-download', kind: 'threshold', permissions: ['project:export', 'repo:read'], minRole: 'editor', when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: { code: 'policy', rule: 'no_download' } },
  { id: 'editors-may-not-invite', kind: 'threshold', permissions: ['grants:invite'], minRole: 'maintainer', when: { attr: 'scope.org.policies.editors_may_invite', eq: false }, reason: { code: 'policy', rule: 'editors_may_not_invite' } },
  { id: 'delete-needs-org-admin', kind: 'threshold', permissions: ['project:delete'], ladder: 'org', at: 'org', minRole: 'org.admin', when: { attr: 'scope.org.policies.maintainers_may_delete', eq: false }, reason: { code: 'policy', rule: 'delete_needs_org_admin' } },
];

export const RULE_IDS: readonly string[] = Object.freeze(canvasRules().map((r) => r.id));

const canvasPolicies = (): CanvasPolicy[] => [
  { id: 'agents-disabled', effect: 'deny', actorTypes: ['agent'], permissions: ['*'], when: { attr: 'scope.org.policies.agents_allowed', eq: false }, reason: 'agents_disabled', priority: 100 },
];

export function canvasAuthzConfig(capabilities: CapabilityTable | unknown): CanvasAuthzConfig {
  const table = readCapabilities(capabilities);
  const rows = table.capabilities;
  const permissions: CanvasAuthzConfig['permissions'] = {};
  for (const row of rows) {
    const name = capabilityPermission(row.name);
    permissions[name] = { types: [...PERMISSION_TYPES, ...(EXTRA_PERMISSION_TYPES[name] ?? [])] };
  }

  const projectGrants = (role: ProjectRole) => rows.filter((r) => r.min_role === role).map(grantOf);
  const orgGrants = (role: 'admin' | 'owner') => rows.filter((r) => r.org_role === role).map(grantOf);

  return {
    permissions,
    combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] } },
    rbac: {
      ladders: {
        project: { roles: [...PROJECT_LADDER], resourceTypes: ['project', 'file', 'branch'] },
        org: { roles: [...ORG_LADDER] },
      },
      roles: {
        viewer: { ladder: 'project', grants: projectGrants('viewer') },
        commenter: { ladder: 'project', grants: projectGrants('commenter') },
        editor: { ladder: 'project', grants: projectGrants('editor') },
        maintainer: { ladder: 'project', grants: projectGrants('maintainer') },
        'org.file_guest': { ladder: 'org', grants: [] },
        'org.guest': { ladder: 'org', grants: [] },
        'org.member': { ladder: 'org', subjectSet: true, grants: [] },
        'org.admin': { ladder: 'org', grants: orgGrants('admin'), implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: [...table.addons], bypass: ['restrict', 'cap'] }] },
        // Inherits org.admin's grants and implies through the org ladder.
        'org.owner': { ladder: 'org', grants: orgGrants('owner') },
        'group.member': { subjectSet: true, grants: [] },
      },
      rules: canvasRules(),
      stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['ConfigRuleStore', 'DbRuleStore'], links: ['DbLinkStore'] },
    },
    // Without it a list request reads agents-disabled's scope.org condition as needs_subject: every agent list is
    // FALSE (RFC K1b-1). It is opt-in because the kit's B19 / B39 expect the old answer.
    abac: { scopeResiduals: true, policies: canvasPolicies() },
  };
}

/** Permissions of the `branch_write` rows, wire order. */
export function branchWritePermissions(capabilities: CapabilityTable | unknown): string[] {
  return readCapabilities(capabilities)
    .capabilities.filter((r) => r.branch_write)
    .map((r) => capabilityPermission(r.name));
}

/** §8.5 data rows: branch-write permissions without `branch:merge` need `push_role`; `branch:merge` needs `merge_role`. */
export function branchRulePermissions(capabilities: CapabilityTable | unknown): { push: string[]; merge: string[] } {
  return { push: branchWritePermissions(capabilities).filter((p) => p !== 'branch:merge'), merge: ['branch:merge'] };
}

/** Permissions of the `org_role` rows, wire order. */
export function orgLevelPermissions(capabilities: CapabilityTable | unknown): string[] {
  return readCapabilities(capabilities)
    .capabilities.filter((r) => r.org_role !== null)
    .map((r) => capabilityPermission(r.name));
}

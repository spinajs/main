import { AuthzContributor, GLOBAL, ScopeResolver } from '@spinajs/authz';
import type { AuthzContribution, ResourceRef, ResourceType, ScopeAttributeSchema } from '@spinajs/authz';

import { ROLES } from './c6/access.js';
import type { AccessState } from './c6/state.js';
import { DEFAULT_ORG_POLICIES } from './c6/state.js';

export const CANVAS_SCOPE_TYPES = ['org', 'project', 'file', 'branch', 'group'] as const satisfies readonly ResourceType[];

export interface BranchId {
  readonly project: string;
  readonly file: string | null;
  readonly name: string;
}

/**
 * A C6 branch has no id of its own: its id is `project:file:name`, each part
 * percent-encoded (so `:` never appears inside one), an absent file as ''.
 */
export function branchRef(project: string, file: string | null, name: string): ResourceRef {
  if (project === '' || name === '' || file === '') throw new Error(`branchRef: project, file and name must not be empty (got ${JSON.stringify({ project, file, name })})`);
  return { type: 'branch', id: [project, file ?? '', name].map((s) => encodeURIComponent(s)).join(':') };
}

/** The parts of a branch id, or null for anything `branchRef` would not produce (only the canonical encoding is accepted). */
export function parseBranchId(id: string): BranchId | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const [project, file, name] = decoded;
  if (project === '' || name === '') return null;
  const parsed = { project, file: file === '' ? null : file, name };
  try {
    if (branchRef(parsed.project, parsed.file, parsed.name).id !== id) return null;
  } catch {
    return null;
  }
  return parsed;
}

const freezeRefs = (refs: ResourceRef[]): readonly ResourceRef[] => Object.freeze(refs.map((r) => Object.freeze({ ...r })));

/** Scope tree over a C6 `AccessState`: org → project → file → branch, and org → group, with the unknown-resource rules of C6 `resolve()`. */
export class CanvasScopeResolver extends ScopeResolver {
  readonly types: readonly ResourceType[] = CANVAS_SCOPE_TYPES;

  constructor(private readonly state: AccessState) {
    super();
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (!(CANVAS_SCOPE_TYPES as readonly string[]).includes(ref.type)) return null;
    // The engine answers a type-level ref with [ref, GLOBAL] before asking a resolver; the same here.
    if (ref.id === undefined) return freezeRefs([{ type: ref.type }, GLOBAL]);
    const chain = this.chain(ref);
    return chain && freezeRefs([...chain, GLOBAL]);
  }

  async attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    if (ref.id === undefined || this.chain(ref) === null) return null;
    if (ref.type !== 'branch') return Object.freeze({});
    return Object.freeze({ name: parseBranchId(ref.id)!.name });
  }

  /** `[self, …, org]`, or null when C6 `resolve()` would answer unknown_resource. */
  private chain(ref: ResourceRef): ResourceRef[] | null {
    const id = ref.id;
    if (typeof id !== 'string') return null;
    switch (ref.type) {
      case 'org':
        return this.state.orgs.has(id) ? [{ type: 'org', id }] : null;
      case 'group': {
        const org = this.state.groups.get(id)?.org;
        return org !== undefined && this.state.orgs.has(org) ? [{ type: 'group', id }, { type: 'org', id: org }] : null;
      }
      case 'project':
        return this.inProject(id);
      case 'file': {
        const file = this.state.files.get(id);
        const above = file && this.inProject(file.project);
        return above ? [{ type: 'file', id }, ...above] : null;
      }
      case 'branch': {
        const b = parseBranchId(id);
        if (!b) return null;
        if (b.file !== null && this.state.files.get(b.file)?.project !== b.project) return null;
        const above = this.inProject(b.project);
        if (!above) return null;
        return [{ type: 'branch', id }, ...(b.file === null ? [] : [{ type: 'file', id: b.file }]), ...above];
      }
      default:
        return null;
    }
  }

  private inProject(project: string): ResourceRef[] | null {
    const org = this.state.projects.get(project)?.org;
    return org !== undefined && this.state.orgs.has(org) ? [{ type: 'project', id: project }, { type: 'org', id: org }] : null;
  }
}

/** `none` is left out: the cap rules read these keys as maxRole refs, and `none` is no rung of the project ladder. */
export const ORG_POLICY_ROLES = ROLES.filter((r) => r !== 'none');

const BOOLEAN_POLICIES = ['agents_allowed', 'public_links', 'viewers_may_download', 'editors_may_invite', 'maintainers_may_delete', 'external_sharing', 'addons_for_guests'] as const;
const ROLE_POLICIES = ['max_link_role', 'guest_max_role', 'external_max_role'] as const;

/** Org policies are scope attributes under `policies`; values come from the attribute store, the defaults from C6. */
export const ORG_ATTRIBUTE_SCHEMA: ScopeAttributeSchema = {
  scopeType: 'org',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      policies: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...Object.fromEntries(BOOLEAN_POLICIES.map((k) => [k, { type: 'boolean' }])),
          ...Object.fromEntries(ROLE_POLICIES.map((k) => [k, { type: 'string', enum: [...ORG_POLICY_ROLES] }])),
        },
      },
    },
  },
  defaults: { policies: { ...DEFAULT_ORG_POLICIES } },
};

export class CanvasScopeContributor extends AuthzContributor {
  contribute(): AuthzContribution {
    return { scopeAttributeSchemas: [ORG_ATTRIBUTE_SCHEMA] };
  }
}

export function canvasScopeContributor(): CanvasScopeContributor {
  return new CanvasScopeContributor();
}

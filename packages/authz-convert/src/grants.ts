import { isFieldGlob, isPermission } from '@spinajs/authz';

import type { Findings } from './findings.js';
import { isPlain, keyPath, sameList } from './values.js';
import type { Plain } from './values.js';

export const VERBS = ['create', 'read', 'update', 'delete'] as const;
export type Verb = (typeof VERBS)[number];

const SCOPE_PREFIX = 'scope:';
// 2.x DEFAULT_PERMISSION_SCOPE: the same policy an :own grant without a token selects.
const DEFAULT_SCOPE = 'default';
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const ACTION_KEY = /^(create|read|update|delete)(?::(own|any))?$/;

/** 2.x resources whose "own" row is the caller's own account; their :own grants become relation 'self'. */
export const DEFAULT_SELF_RESOURCES: readonly string[] = Object.freeze(['user', 'users', 'UserBase']);

export interface GrantFields {
  read?: string[];
  write?: string[];
}

export interface GrantObject {
  permission: string;
  relation?: string | string[];
  fields?: GrantFields;
}

export type Grant = string | GrantObject;

export interface RoleOut {
  description?: string;
  extends?: string[];
  assignable?: false;
  grants: Grant[];
}

export interface GrantsOptions {
  readonly selfResources: readonly string[];
}

export interface GrantsResult {
  /** Role name → definition, in 2.x key order. */
  readonly roles: Map<string, RoleOut>;
  /** Permission → whether some grant on it carries fields. */
  readonly permissions: Map<string, { fields: boolean }>;
  /** Resource → relations its :own grants use ('owner', 'self', or a scope token). */
  readonly relations: Map<string, Set<string>>;
}

interface VerbGrant {
  relation?: string[];
  fields?: string[];
}

/** One 2.x attribute list, split the way 2.x read it; undefined when 2.x granted nothing (no non-negated attribute). */
function readAttributes(raw: unknown, at: string, f: Findings): { tokens: string[]; fields: string[] } | undefined | null {
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string' && a.trim() !== '')) {
    f.refuse(`${at} must be an array of non-empty strings (accesscontrol rejects anything else)`);
    return null;
  }
  const attrs = [...new Set((raw as string[]).map((a) => a.trim()))];
  // accesscontrol's Permission.granted: at least one attribute that is not a negation.
  if (!attrs.some((a) => !a.startsWith('!'))) return undefined;
  const tokens: string[] = [];
  const fields: string[] = [];
  for (const a of attrs) {
    if (a.startsWith(SCOPE_PREFIX)) {
      const token = a.slice(SCOPE_PREFIX.length);
      if (!NAME.test(token)) f.refuse(`${at}: scope token '${a}' does not name a valid relation ([A-Za-z][A-Za-z0-9_.-]*)`);
      else tokens.push(token);
    } else {
      if (!isFieldGlob(a)) f.refuse(`${at}: attribute '${a}' is not a 3.0 field glob (segments '*' or a name, an optional leading '!')`);
      fields.push(a);
    }
  }
  return { tokens, fields };
}

const allFields = (fields: readonly string[]): boolean => fields.length === 0 || sameList(fields, ['*']);

function verbGrants(resource: string, verb: Verb, entries: Map<string, unknown>, at: string, opts: GrantsOptions, f: Findings): VerbGrant[] {
  const out: VerbGrant[] = [];
  const own = opts.selfResources.includes(resource) ? 'self' : 'owner';

  if (entries.has(verb)) {
    f.manual(
      'action-without-possession',
      `'${verb}' has no ':own' or ':any': 2.x looks grants up as '${verb}:own' or '${verb}:any' only, so it granted nothing. Nothing was converted; add the grant by hand if it was meant.`,
      keyPath(at, verb),
    );
  }

  let anyGrant: VerbGrant | undefined;
  const anyRaw = entries.get(`${verb}:any`);
  if (anyRaw !== undefined) {
    const where = keyPath(at, `${verb}:any`);
    const parsed = readAttributes(anyRaw, where, f);
    if (parsed === undefined) f.info('grants-nothing', 'No attribute without "!": 2.x granted nothing, so nothing was converted.', where);
    else if (parsed !== null) {
      if (parsed.tokens.length > 0) {
        f.refuse(`${where}: a scope token on an :any grant; 2.x ignores it and grants every row. Drop the token, or make the grant :own if the scope was meant`);
      } else {
        anyGrant = fieldsFor(verb, parsed.fields, where, f);
        out.push(anyGrant);
      }
    }
  }

  const ownRaw = entries.get(`${verb}:own`);
  if (ownRaw !== undefined) {
    const where = keyPath(at, `${verb}:own`);
    const parsed = readAttributes(ownRaw, where, f);
    if (parsed === undefined) f.info('grants-nothing', 'No attribute without "!": 2.x granted nothing, so nothing was converted.', where);
    else if (parsed !== null) {
      const relations = parsed.tokens.length === 0 ? [own] : [...new Set(parsed.tokens.map((t) => (t === DEFAULT_SCOPE ? own : t)))];
      if (parsed.fields.length > 0 && !parsed.fields.some((a) => !a.startsWith('!'))) {
        f.refuse(`${where}: scope tokens with negated attributes only; 2.x keeps no field there, which 3.0 cannot express. Add the fields the grant should keep (for example '*')`);
      } else {
        const g: VerbGrant = { relation: relations, ...fieldsFor(verb, parsed.fields, where, f) };
        if (anyGrant && sameFields(anyGrant.fields, g.fields)) {
          f.info('own-under-any', `The :own grant adds nothing to the :any grant beside it; only '${resource}:${verb}' was written.`, where);
        } else {
          if (anyGrant) {
            f.warn(
              'own-any-fields',
              `:any and :own carry different attributes. 3.0 gives every row the fields of the unconditional (:any) grant, while 2.x gave the caller's own rows the :own attributes. Check the field lists.`,
              where,
            );
          }
          out.push(g);
        }
      }
    }
  }
  return out;
}

function fieldsFor(verb: Verb, fields: readonly string[], where: string, f: Findings): VerbGrant {
  if (allFields(fields)) return {};
  if (verb === 'delete') {
    f.info('delete-fields', `Attributes on a delete grant only decide whether it is granted; 3.0 delete grants carry no fields.`, where);
    return {};
  }
  return { fields: [...fields] };
}

function sameFields(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameList(a, b);
}

function toGrant(permission: string, verb: Verb | '*', g: VerbGrant): Grant {
  const out: GrantObject = { permission };
  if (g.relation) out.relation = g.relation.length === 1 ? g.relation[0] : [...g.relation];
  if (g.fields) out.fields = verb === 'read' ? { read: [...g.fields] } : { write: [...g.fields] };
  return out.relation === undefined && out.fields === undefined ? permission : out;
}

function sameGrant(a: VerbGrant, b: VerbGrant): boolean {
  return a.fields === undefined && b.fields === undefined && sameFields(a.relation, b.relation);
}

/** Converts one layer's `rbac.grants` and `rbac.roles`. Problems go to `f.refuse`; the caller stops on any. */
export function convertGrants(rbac: Plain, opts: GrantsOptions, f: Findings): GrantsResult {
  const roles = new Map<string, RoleOut>();
  const permissions = new Map<string, { fields: boolean }>();
  const relations = new Map<string, Set<string>>();

  const addPermission = (name: string, fields: boolean) => {
    const known = permissions.get(name);
    permissions.set(name, { fields: (known?.fields ?? false) || fields });
  };

  const grants = rbac.grants;
  if (grants !== undefined && !isPlain(grants)) f.refuse('rbac.grants must be an object of roles');
  for (const [role, def] of Object.entries(isPlain(grants) ? grants : {})) {
    const at = keyPath('rbac.grants', role);
    if (role.trim() === '' || ['*', '!', '$', '$extend'].includes(role)) {
      f.refuse(`${at}: '${role}' is not a valid role name`);
      continue;
    }
    if (!isPlain(def)) {
      f.refuse(`${at} must be an object`);
      continue;
    }
    const out: RoleOut = { grants: [] };
    for (const [resource, actions] of Object.entries(def)) {
      if (resource === '$extend') {
        if (!Array.isArray(actions) || !actions.every((r) => typeof r === 'string' && r.trim() !== '')) f.refuse(`${keyPath(at, '$extend')} must be an array of role names`);
        else if (actions.length > 0) out.extends = [...new Set(actions as string[])];
        continue;
      }
      const rat = keyPath(at, resource);
      if (!NAME.test(resource) || !isPermission(`${resource}:read`)) {
        f.refuse(`${rat}: resource '${resource}' is not a valid 3.0 permission resource ([A-Za-z][A-Za-z0-9_.-]*); rename it in 2.x first`);
        continue;
      }
      if (!isPlain(actions)) {
        f.refuse(`${rat} must be an object of actions`);
        continue;
      }
      const entries = new Map<string, unknown>();
      for (const [key, attrs] of Object.entries(actions)) {
        if (!ACTION_KEY.test(key)) {
          f.refuse(`${keyPath(rat, key)}: '${key}' is not a 2.x action (create|read|update|delete, then :own or :any)`);
          continue;
        }
        entries.set(key, attrs);
      }
      const byVerb = new Map<Verb, VerbGrant[]>(VERBS.map((v) => [v, verbGrants(resource, v, entries, rat, opts, f)]));
      for (const list of byVerb.values()) {
        for (const g of list) {
          for (const r of g.relation ?? []) {
            if (!relations.has(resource)) relations.set(resource, new Set());
            relations.get(resource)!.add(r);
          }
        }
      }

      const first = byVerb.get('create')!;
      const collapsible = VERBS.every((v) => byVerb.get(v)!.length === 1 && sameGrant(byVerb.get(v)![0], first[0]));
      if (collapsible) {
        out.grants.push(toGrant(`${resource}:*`, '*', first[0]));
        for (const v of VERBS) addPermission(`${resource}:${v}`, false);
        continue;
      }
      for (const v of VERBS) {
        for (const g of byVerb.get(v)!) {
          out.grants.push(toGrant(`${resource}:${v}`, v, g));
          addPermission(`${resource}:${v}`, g.fields !== undefined);
        }
      }
    }
    roles.set(role, out);
  }

  const declared = rbac.roles;
  if (declared !== undefined) {
    if (!Array.isArray(declared)) f.refuse('rbac.roles must be an array of { Name, Description }');
    else {
      declared.forEach((entry, i) => {
        const at = `rbac.roles[${i}]`;
        if (!isPlain(entry) || typeof entry.Name !== 'string' || entry.Name.trim() === '') {
          f.refuse(`${at} must be an object with a non-empty Name`);
          return;
        }
        const name = entry.Name;
        const description = typeof entry.Description === 'string' && entry.Description !== '' ? entry.Description : undefined;
        const known = roles.get(name);
        if (known) {
          if (description !== undefined) known.description = description;
          return;
        }
        const twin = [...roles.keys()].find((r) => r.toLowerCase() === name.toLowerCase());
        if (twin !== undefined) {
          f.warn(
            'role-case',
            `Declared role '${name}' differs from the granted role '${twin}' only in case. Role names keep their case in 3.0 (H17), so '${name}' was not written; users holding '${name}' match no role.`,
            at,
          );
          return;
        }
        f.warn('declared-without-grants', `Role '${name}' is declared but has no grants; it was written with no grants so assignments of it stay valid.`, at);
        roles.set(name, { ...(description === undefined ? {} : { description }), grants: [] });
      });
    }
  }

  const names = [...roles.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (names[i].toLowerCase() === names[j].toLowerCase()) {
        f.warn('role-case', `Roles '${names[i]}' and '${names[j]}' differ only in case; 3.0 keeps both as separate roles (H17).`, keyPath('rbac.grants', names[j]));
      }
    }
  }

  return { roles, permissions, relations };
}

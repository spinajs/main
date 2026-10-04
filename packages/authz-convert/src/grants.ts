import { isFieldGlob, isPermission, normalizeFieldGlobs } from '@spinajs/authz';

import type { Findings } from './findings.js';
import { RBAC_2X_PACKAGE_EXTENDS, RBAC_2X_PACKAGE_GRANTS } from './legacy.js';
import { isPlain, keyPath, sameList } from './values.js';
import type { Plain } from './values.js';

export const VERBS = ['create', 'read', 'update', 'delete'] as const;
export type Verb = (typeof VERBS)[number];

const SCOPE_PREFIX = 'scope:';
// 2.x DEFAULT_PERMISSION_SCOPE: the same policy an :own grant without a token selects.
const DEFAULT_SCOPE = 'default';
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESERVED_RELATIONS = ['owner', 'self'];
const POSSESSIONS = ['own', 'any'];

/** 2.x's virtual resource for impersonation; 2.x only ever asked `createAny` of it (design §18.1). */
export const IMPERSONATE_RESOURCE = 'user:impersonate';

/**
 * 2.x resources whose "own" row is the caller's own account; their :own grants become relation 'self'.
 * Only the route-level resource of the 2.x self-service controllers: a resource backed by a model
 * (`users`) ran the app's default OrmPermission policy for :own, which 'self' would ignore.
 */
export const DEFAULT_SELF_RESOURCES: readonly string[] = Object.freeze(['user']);

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

export interface GrantsContext {
  /** Roles `rbac.grants` defines in the merged view this layer belongs to (other layers included). */
  readonly granted: ReadonlySet<string>;
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

/** One 2.x attribute list, split the way 2.x read it; undefined when 2.x granted nothing (no non-negated attribute), null when refused. */
function readAttributes(raw: unknown, at: string, f: Findings): { tokens: string[]; fields: string[] } | undefined | null {
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string' && a.trim() !== '')) {
    f.refuse(`${at} must be an array of non-empty strings (accesscontrol rejects anything else)`);
    return null;
  }
  const spaced = (raw as string[]).filter((a) => a !== a.trim());
  if (spaced.length > 0) {
    // 2.x tested `scope:` on the raw string while field globs trim; one reading cannot be chosen for both.
    f.refuse(`${at}: attribute(s) ${spaced.map((a) => `'${a}'`).join(', ')} carry spaces around them; remove the spaces in 2.x first`);
    return null;
  }
  const attrs = [...new Set(raw as string[])];
  // accesscontrol's Permission.granted: at least one attribute that is not a negation.
  if (!attrs.some((a) => !a.startsWith('!'))) return undefined;
  const tokens: string[] = [];
  const fields: string[] = [];
  for (const a of attrs) {
    if (a.startsWith(SCOPE_PREFIX)) {
      const token = a.slice(SCOPE_PREFIX.length);
      if (!NAME.test(token)) f.refuse(`${at}: scope token '${a}' does not name a valid relation ([A-Za-z][A-Za-z0-9_.-]*)`);
      else if (RESERVED_RELATIONS.includes(token)) f.refuse(`${at}: scope token '${a}' would merge an app policy into the 3.0 relation '${token}'; rename the scope in 2.x first`);
      else tokens.push(token);
    } else {
      if (!isFieldGlob(a)) f.refuse(`${at}: attribute '${a}' is not a 3.0 field glob (segments '*' or a name, an optional leading '!')`);
      fields.push(a);
    }
  }
  return { tokens, fields };
}

function normalized(fields: readonly string[]): string[] | undefined {
  try {
    return normalizeFieldGlobs(fields);
  } catch {
    return undefined; // invalid globs were refused already
  }
}

const allFields = (fields: readonly string[]): boolean => fields.length === 0 || sameList(normalized(fields) ?? fields, ['*']);

function sameFields(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameList(normalized(a) ?? a, normalized(b) ?? b);
}

/**
 * Splits a resource's action keys. accesscontrol accepts `verb`, `verb:`, `verb:own`, `verb:any` and
 * `verb:<possession>:<more>` but looks up only `verb:own` and `verb:any`; it rejects the rest.
 */
function readActions(actions: Plain, at: string, f: Findings): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const [key, attrs] of Object.entries(actions)) {
    const s = key.split(':');
    if (!(VERBS as readonly string[]).includes(s[0]) || (s[1] && !POSSESSIONS.includes(s[1]))) {
      f.refuse(`${keyPath(at, key)}: '${key}' is not a 2.x action (create|read|update|delete, then :own or :any)`);
      continue;
    }
    if (s.length !== 2 || !s[1]) {
      f.manual('action-never-read', `2.x accepts '${key}' but looks grants up as '${s[0]}:own' or '${s[0]}:any' only, so it granted nothing. Nothing was converted; add the grant by hand if it was meant.`, keyPath(at, key));
      continue;
    }
    entries.set(key, attrs);
  }
  return entries;
}

function verbGrants(resource: string, verb: Verb, entries: Map<string, unknown>, at: string, opts: GrantsOptions, f: Findings): VerbGrant[] {
  const out: VerbGrant[] = [];
  const own = opts.selfResources.includes(resource) ? 'self' : 'owner';

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
          if (relations.includes('self')) {
            f.warn(
              'self-relation',
              `:own on '${resource}' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for '${resource}', 2.x used it here and 'self' ignores it; pass --self-resources without '${resource}' to get relation 'owner' instead.`,
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

function toGrant(permission: string, verb: Verb, g: VerbGrant): Grant {
  const out: GrantObject = { permission };
  if (g.relation) out.relation = g.relation.length === 1 ? g.relation[0] : [...g.relation];
  if (g.fields) out.fields = verb === 'read' ? { read: [...g.fields] } : { write: [...g.fields] };
  return out.relation === undefined && out.fields === undefined ? permission : out;
}

/** `'user:impersonate': { 'create:any': [...] }` → permission `user:impersonate`. */
function impersonation(actions: Plain, at: string, f: Findings): Grant[] {
  const entries = readActions(actions, at, f);
  const out: Grant[] = [];
  for (const [key, raw] of entries) {
    const where = keyPath(at, key);
    if (key !== 'create:any') {
      f.manual('impersonate-action', `2.x asked only 'create:any' of '${IMPERSONATE_RESOURCE}', so '${key}' granted nothing. Nothing was converted.`, where);
      continue;
    }
    const parsed = readAttributes(raw, where, f);
    if (parsed === undefined) f.info('grants-nothing', 'No attribute without "!": 2.x granted nothing, so nothing was converted.', where);
    else if (parsed !== null) {
      if (parsed.tokens.length > 0) f.refuse(`${where}: a scope token on an :any grant; 2.x ignores it. Drop the token`);
      else out.push(IMPERSONATE_RESOURCE);
    }
  }
  return out;
}

/**
 * Converts one layer's `rbac.grants` and `rbac.roles`. Problems go to `f.refuse`; the caller stops on any.
 * 2.x actions map one to one: a role holds `X:create|read|update|delete`, never the glob `X:*`, which in
 * 3.0 would also take every other action registered on X (such as `user:impersonate`).
 */
export function convertGrants(rbac: Plain, opts: GrantsOptions, f: Findings, ctx?: GrantsContext): GrantsResult {
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
        else if ((actions as string[]).includes(role)) f.refuse(`${keyPath(at, '$extend')}: role '${role}' extends itself, which 2.x refused at boot`);
        else if (actions.length > 0) {
          out.extends = [...new Set(actions as string[])];
          const pkg = RBAC_2X_PACKAGE_EXTENDS[role];
          if (pkg) f.info('package-extends', `2.x joined this $extend with the package's ${JSON.stringify(pkg)}; only the app's part was written, and the 3.0 packages define their own '${role}'.`, keyPath(at, '$extend'));
        }
        continue;
      }
      const rat = keyPath(at, resource);
      if (!isPlain(actions)) {
        f.refuse(`${rat} must be an object of actions`);
        continue;
      }
      if (resource === IMPERSONATE_RESOURCE) {
        for (const g of impersonation(actions, rat, f)) {
          out.grants.push(g);
          addPermission(IMPERSONATE_RESOURCE, false);
        }
        continue;
      }
      if (!NAME.test(resource) || !isPermission(`${resource}:read`)) {
        f.refuse(`${rat}: resource '${resource}' is not a valid 3.0 permission resource ([A-Za-z][A-Za-z0-9_.-]*); rename it in 2.x first`);
        continue;
      }
      const entries = readActions(actions, rat, f);
      for (const [key, attrs] of entries) {
        const pkg = RBAC_2X_PACKAGE_GRANTS.get(`${role}|${resource}|${key}`);
        if (!pkg || !Array.isArray(attrs)) continue;
        // 2.x joined this list with the package's before it read it; 3.0 keeps the package grant apart, so a
        // token or a negation no longer narrows it.
        const narrows = (a: unknown) => typeof a === 'string' && (a.startsWith(SCOPE_PREFIX) || a.startsWith('!'));
        if (attrs.some(narrows)) {
          f.refuse(`${keyPath(rat, key)}: a 2.x package grants the same key, and 2.x joined the lists, so a negation or scope token here narrowed the package grant; 3.0 keeps the package grant apart. Move the rule to its own role, or narrow it in 3.0 by hand`);
        } else {
          f.info('package-grant', `A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union.`, keyPath(rat, key));
        }
      }
      for (const v of VERBS) {
        for (const g of verbGrants(resource, v, entries, rat, opts, f)) {
          for (const r of g.relation ?? []) {
            if (!relations.has(resource)) relations.set(resource, new Set());
            relations.get(resource)!.add(r);
          }
          out.grants.push(toGrant(`${resource}:${v}`, v, g));
          addPermission(`${resource}:${v}`, g.fields !== undefined);
        }
      }
    }
    roles.set(role, out);
  }

  const granted = new Set([...roles.keys(), ...(ctx?.granted ?? [])]);
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
        if (granted.has(name)) {
          // Granted in another layer: the description merges into that role.
          if (description !== undefined) roles.set(name, { description, grants: [] });
          return;
        }
        const twin = [...granted].find((r) => r.toLowerCase() === name.toLowerCase());
        if (twin !== undefined) {
          f.warn(
            'role-case',
            `Declared role '${name}' differs from the granted role '${twin}' only in case, so it was not written (names keep their case, H17). In 2.x a user holding '${name}' with other roles got no permission at all (accesscontrol refused the role list); in 3.0 '${name}' is ignored and the other roles apply.`,
            at,
          );
          return;
        }
        f.warn(
          'declared-without-grants',
          `Role '${name}' is declared but has no grants; it was written with no grants so it can be assigned. In 2.x a user holding it with other roles got no permission at all (accesscontrol refused the role list); in 3.0 the other roles apply.`,
          at,
        );
        roles.set(name, { ...(description === undefined ? {} : { description }), grants: [] });
      });
    }
  }

  const names = [...roles.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (names[i].toLowerCase() === names[j].toLowerCase()) {
        f.warn('role-case', `Roles '${names[i]}' and '${names[j]}' differ only in case; 3.0 keeps both as separate roles (H17).`, names[j]);
      }
    }
  }

  return { roles, permissions, relations };
}

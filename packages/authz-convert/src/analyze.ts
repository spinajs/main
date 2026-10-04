import type { DbFacts, SourceFacts } from './facts.js';
import { Findings } from './findings.js';
import { VERBS, convertGrants } from './grants.js';
import type { GrantsOptions } from './grants.js';
import { getPath, isPlain, keyPath } from './values.js';
import type { Plain } from './values.js';

export interface AnalyzeOptions extends GrantsOptions {
  readonly db?: DbFacts;
  readonly src?: SourceFacts;
}

const WEB_PROTOCOL = /^(https?|wss?|ftps?|file|data|blob):\/\//i;
const CONFIG_PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//i;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 2.x role definitions of a merged config: role → resource → action key → attributes. */
type Grants2 = Map<string, Plain>;

function grantsOf(merged: Plain): Grants2 {
  const g = getPath(merged, ['rbac', 'grants']);
  return new Map(isPlain(g) ? Object.entries(g).filter((e): e is [string, Plain] => isPlain(e[1])) : []);
}

// accesscontrol's getFlatRoles: the role and everything it reaches through $extend.
function closure(role: string, grants: Grants2): string[] {
  const out = [role];
  for (let i = 0; i < out.length; i++) {
    for (const r of strings(grants.get(out[i])?.$extend)) if (grants.has(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Checks of one merged view (common, or common + one env). The findings are about 2.x behaviour the
 * conversion changes and about data and secrets the app must handle; they never change the output.
 */
export function analyze(merged: Plain, layer: string, opts: AnalyzeOptions): Findings {
  const f = new Findings(layer);
  const grants = grantsOf(merged);

  absorbedScopes(grants, f);
  namesAndCase(merged, grants, f);
  ownership(merged, opts, f);
  if (opts.db) dbFacts(merged, grants, opts.db, f);
  httpAndSecrets(merged, f);
  return f;
}

function absorbedScopes(grants: Grants2, f: Findings): void {
  for (const role of grants.keys()) {
    const roles = closure(role, grants);
    const resources = new Set(roles.flatMap((r) => Object.keys(grants.get(r)!).filter((k) => k !== '$extend')));
    for (const resource of resources) {
      for (const verb of VERBS) {
        const tokens = new Set<string>();
        const absorbers: string[] = [];
        for (const r of roles) {
          const actions = grants.get(r)![resource];
          if (!isPlain(actions)) continue;
          // accesscontrol reads `verb:own || verb:any` per role, then unions the lists.
          const own = actions[`${verb}:own`];
          const attrs = strings(own ?? actions[`${verb}:any`]);
          for (const a of attrs) if (a.startsWith('scope:')) tokens.add(a.slice(6));
          if (own !== undefined && attrs.includes('*')) absorbers.push(r);
        }
        if (tokens.size > 0 && absorbers.length > 0) {
          f.warn(
            'absorbed-scope',
            `For role '${role}', 2.x merged ${[...tokens].map((t) => `'scope:${t}'`).join(', ')} on ${resource} ${verb}:own with '*' from ${absorbers.map((r) => `'${r}'`).join(', ')}, which dropped the scope: 2.x applied only the default (owner) policy. 3.0 keeps every grant, so the role now also reaches rows through relation ${[...tokens].map((t) => `'${t}'`).join(', ')}.`,
            keyPath('rbac.grants', role),
          );
        }
      }
    }
  }
}

function namesAndCase(merged: Plain, grants: Grants2, f: Findings): void {
  const declared = strings((Array.isArray(getPath(merged, ['rbac', 'roles'])) ? (getPath(merged, ['rbac', 'roles']) as unknown[]) : []).map((r) => (isPlain(r) ? r.Name : undefined)));
  const known = new Set([...grants.keys(), ...declared]);
  const twin = (name: string) => [...known].find((k) => k !== name && k.toLowerCase() === name.toLowerCase());

  const outside = new Set<string>();
  for (const [role, def] of grants) {
    for (const r of strings(def.$extend)) {
      if (known.has(r)) continue;
      const t = twin(r);
      if (t !== undefined) f.warn('role-case', `Role '${role}' extends '${r}', which matches '${t}' only in case; 3.0 keeps the case (H17) and finds no role '${r}'.`, keyPath('rbac.grants', role));
      else outside.add(r);
    }
  }
  if (outside.size > 0) {
    f.info('extends-outside', `Roles extended but not defined in these config files: ${[...outside].sort().map((r) => `'${r}'`).join(', ')}. In 3.0 they must come from a package fragment (for example 'admin.users' from @spinajs/users) or boot fails.`);
  }

  const defaultRole = getPath(merged, ['rbac', 'defaultRole']);
  if (typeof defaultRole === 'string' && !known.has(defaultRole)) {
    const t = twin(defaultRole);
    f.warn('default-role', t !== undefined ? `rbac.defaultRole '${defaultRole}' matches role '${t}' only in case.` : `rbac.defaultRole '${defaultRole}' is not defined in these config files; a package fragment must define it.`, 'rbac.defaultRole');
  }

  const resources = new Map<string, string>();
  for (const def of grants.values()) {
    for (const res of Object.keys(def)) {
      if (res === '$extend') continue;
      const lower = res.toLowerCase();
      const seen = resources.get(lower);
      if (seen !== undefined && seen !== res) f.warn('resource-case', `Resources '${seen}' and '${res}' differ only in case; 3.0 keeps them as separate permissions (H17).`);
      else resources.set(lower, res);
    }
  }

  const candidates = [...grants.keys()].filter((r) => !declared.includes(r) && r !== defaultRole && [...grants.values()].some((d) => strings(d.$extend).includes(r)));
  if (candidates.length > 0) {
    f.info(
      'assignable',
      `Roles only used through $extend: ${candidates.map((r) => `'${r}'`).join(', ')}. With --db the converter marks those no user or token holds 'assignable: false'; without it every role stays assignable, as in 2.x.`,
    );
  }
}

function ownership(merged: Plain, opts: AnalyzeOptions, f: Findings): void {
  const rbac = getPath(merged, ['rbac']);
  const scratch = new Findings();
  const { relations } = convertGrants(isPlain(rbac) ? { grants: rbac.grants } : {}, opts, scratch);
  for (const [resource, rels] of relations) {
    for (const rel of rels) {
      if (rel === 'self') {
        f.info('relation-self', `:own grants on ${resource} became relation 'self' (the caller's own account); a RelationResolver for 'self' on type '${resource}' must exist in 3.0.`, resource);
      } else if (rel === 'owner') {
        const files = opts.src?.resources.get(resource);
        if (!opts.src) {
          f.warn('owner-relation', `:own grants on ${resource} became relation 'owner'. Each model of type '${resource}' needs @Owner() (was @ResourceOwner()) or an @OrmScope(Model, 'owner') policy (was a default-scope @OrmPermission policy); route checks need a RelationResolver. Run with --src to check the models.`, resource);
        } else if (!files || files.length === 0) {
          f.warn('owner-relation', `:own grants on ${resource} became relation 'owner', but no @OrmResource('${resource}') model was found; a RelationResolver for 'owner' on type '${resource}' must exist in 3.0.`, resource);
        } else if (!files.some((file) => opts.src!.ownerFiles.has(file))) {
          f.warn('owner-relation', `:own grants on ${resource} became relation 'owner', but its model (${files.join(', ')}) has no @ResourceOwner(): port its default-scope @OrmPermission policy to @OrmScope(Model, 'owner'), or add @Owner().`, resource);
        } else {
          f.info('owner-relation', `:own grants on ${resource} became relation 'owner'; its model has @ResourceOwner(), which becomes @Owner().`, resource);
        }
      } else {
        const missing = opts.src && !opts.src.policyScopes.has(rel);
        f.add(
          missing ? 'warning' : 'info',
          'scope-relation',
          `'scope:${rel}' on ${resource} became relation '${rel}': port @OrmPermission(Model, '${rel}') policies to @OrmScope(Model, '${rel}') (OrmScopePolicy).${missing ? ` No @OrmPermission(…, '${rel}') policy was found under --src.` : ''}`,
          resource,
        );
      }
    }
  }
}

function dbFacts(merged: Plain, grants: Grants2, db: DbFacts, f: Findings): void {
  const declared = (getPath(merged, ['rbac', 'roles']) as unknown[] | undefined) ?? [];
  const known = new Set([...grants.keys(), ...strings(Array.isArray(declared) ? declared.map((r) => (isPlain(r) ? r.Name : undefined)) : [])]);
  const multi = db.users.filter((u) => u.roles.length > 1);
  if (multi.length > 0) {
    f.warn(
      'roles-together',
      `${multi.length} user(s) hold several roles. 3.0 gives each the union of all their roles' grants unless the session switches to one role (H1, ceiling.roles); check that the union is meant: ${multi
        .slice(0, 50)
        .map((u) => `${u.id} (${u.roles.join(', ')})`)
        .join('; ')}${multi.length > 50 ? '; …' : ''}`,
    );
  }
  // accesscontrol refused a role list naming a role rbac.grants does not define, declared or not.
  const voided = db.users.filter((u) => u.roles.length > 1 && u.roles.some((r) => !grants.has(r)));
  if (voided.length > 0) {
    f.warn(
      'roles-voided',
      `${voided.length} user(s) hold a role rbac.grants does not define next to other roles. 2.x gave them no permission at all; 3.0 ignores that role and applies the others: ${voided
        .slice(0, 50)
        .map((u) => `${u.id} (${u.roles.join(', ')})`)
        .join('; ')}${voided.length > 50 ? '; …' : ''}`,
    );
  }
  const held = new Map<string, number>();
  for (const row of [...db.users, ...db.tokens]) for (const r of row.roles) held.set(r, (held.get(r) ?? 0) + 1);
  for (const [role, n] of [...held].sort()) {
    if (known.has(role)) continue;
    const twin = [...known].find((k) => k.toLowerCase() === role.toLowerCase());
    f.warn(
      'held-unknown-role',
      twin !== undefined
        ? `${n} user(s) or token(s) hold role '${role}', which matches '${twin}' only in case; 3.0 ignores the assignment (with a warning) after the users.Role copy.`
        : `${n} user(s) or token(s) hold role '${role}', which these config files do not define; 3.0 ignores such an assignment (with a warning) unless a package fragment defines the role.`,
    );
  }
  const open = db.tokens.filter((t) => t.expiresAt === null || t.expiresAt === undefined || t.expiresAt === '');
  if (open.length > 0) {
    f.warn('token-no-expiry', `${open.length} API token(s) have no expiry; the 3.0 migration gives them CreatedAt + authn.token.maxTtlDays (default 90 days). Tell their owners: ${open.slice(0, 50).map((t) => t.id).join(', ')}${open.length > 50 ? ', …' : ''}`);
  }
}

function httpAndSecrets(merged: Plain, f: Findings): void {
  if (getPath(merged, ['http', 'trustProxy']) === undefined && getPath(merged, ['authn', 'http', 'trustProxy']) === undefined) {
    f.warn('trust-proxy', 'http.trustProxy is not set. Behind a proxy, set it to the hop count or the proxy CIDRs, or every client shares the proxy address for throttling and audit.', 'http.trustProxy');
  }
  const origins = getPath(merged, ['http', 'cors', 'origins']);
  if (!Array.isArray(origins) || origins.length === 0) {
    f.warn('cors-empty', '2.x answered every origin, with credentials, when http.cors.origins was empty or unset; 3.0 then allows no cross-origin request (H33, A31). List every origin a browser client uses (and in authn.http.csrf.allowedOrigins for cookie sessions).', 'http.cors.origins');
  }
  const secret = getPath(merged, ['http', 'cookie', 'secret']);
  if (typeof secret === 'string' && secret !== '' && !(CONFIG_PROTOCOL.test(secret) && !WEB_PROTOCOL.test(secret))) {
    f.warn('cookie-secret', 'http.cookie.secret is written in a config file, so everyone with the code has it. Rotate it and load it through a secret reference (env or a secret store).', 'http.cookie.secret');
  }

  const cookie = getPath(merged, ['rbac', 'session', 'cookie']);
  const hostPrefix = isPlain(cookie) ? cookie.hostPrefix : undefined;
  if (hostPrefix !== false && hostPrefix !== 'false') {
    const name = isPlain(cookie) && typeof cookie.name === 'string' ? cookie.name : 'ssid';
    f.warn(
      'cookie-rename',
      `The session cookie becomes '__Host-${name}' outside development and test (authn.session.cookie.hostPrefix 'auto'). Every 2.x session is logged out at the upgrade, and clients that send '${name}' by name must change.`,
      'rbac.session.cookie',
    );
  }
  if (isPlain(cookie) && (cookie.secure === false || cookie.secure === 'false')) {
    f.warn('cookie-secure', "secure: false alone no longer relaxes the cookie: hostPrefix 'auto' forces Secure outside development and test. For local http set authn.session.cookie.hostPrefix: false in a development config.", 'rbac.session.cookie.secure');
  }
}

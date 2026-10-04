import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { Condition, ParsedCondition, Permission, PermissionRefDecl, PermissionRegistry, RuleDef, ScopeRefDecl } from '@spinajs/authz';

import type { LadderIndex } from '../ladder/ladders.js';
import type { RoleGraph } from '../roles.js';

/** Parses a condition with the registered functions; throws AuthzConfigError naming `where`. */
export type ConditionParser = (c: Condition, where: string) => ParsedCondition;

/** A rule with its conditions parsed and its permissions expanded; built once per rule object. */
export interface CompiledRule {
  readonly def: RuleDef;
  readonly where: string;
  readonly scopeKey: string;
  readonly when?: ParsedCondition;
  readonly subjectsWhen?: ParsedCondition;
  readonly resource?: ParsedCondition;
  /** threshold: the registered permissions its globs match. */
  readonly permissions?: ReadonlySet<Permission>;
  readonly expiresAt?: number;
}

const RULE = 'design §6.5 rule 9';

/**
 * @throws AuthzConfigError for a condition that does not parse, an expiry that is not a date, a
 *   ladder or role the role graph does not hold (rule 9), a condition over `resource.*` that no
 *   vote can follow per row (`subjects.when`; a restrict or cap `when`), or a restrict or cap
 *   with `resource` (as the config schema); permission names are checked by the boot refs
 *   (`ruleRefs`), so an unregistered one fails like any other ref (B02)
 */
export function compileRule(def: RuleDef, graph: RoleGraph, ladders: LadderIndex | undefined, registry: PermissionRegistry, parse: ConditionParser): CompiledRule {
  const where = `rbac rule '${def.id}' (source: ${def.source})`;
  checkNames(def, where, graph, ladders);
  const expires = def.expiresAt == null ? undefined : Date.prototype.getTime.call(def.expiresAt);
  if (expires !== undefined && Number.isNaN(expires)) throw new AuthzConfigError(`${where}: expiresAt is not a valid date`);
  // A store other than ConfigRuleStore is not held to the config schema.
  if (def.kind !== 'threshold' && def.resource !== undefined) throw new AuthzConfigError(`${where}: resource belongs to a threshold; a ${def.kind} rule cannot follow it per row`);
  const when = def.when ? parse(def.when, `${where} when`) : undefined;
  const subjectsWhen = def.subjects?.when ? parse(def.subjects.when, `${where} subjects.when`) : undefined;
  if (subjectsWhen?.facts.roots.includes('resource')) throw new AuthzConfigError(`${where}: subjects.when reads resource.*, but it selects principals before any row is read`);
  if (def.kind !== 'threshold' && when?.facts.roots.includes('resource')) throw new AuthzConfigError(`${where}: its when reads resource.*, which a ${def.kind} rule cannot follow per row (a threshold's resource can)`);
  return Object.freeze({
    def,
    where,
    scopeKey: resourceKey(def.scope),
    ...(when ? { when } : {}),
    ...(subjectsWhen ? { subjectsWhen } : {}),
    ...(def.resource ? { resource: parse(def.resource, `${where} resource`) } : {}),
    ...(def.kind === 'threshold' ? { permissions: expand(def.permissions ?? [], registry) } : {}),
    ...(expires !== undefined ? { expiresAt: expires } : {}),
  });
}

function expand(globs: readonly string[], registry: PermissionRegistry): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const g of globs) {
    if (!g.includes('*')) out.add(g);
    else for (const d of registry.match(g)) out.add(d.name);
  }
  return out;
}

function checkNames(def: RuleDef, where: string, graph: RoleGraph, ladders: LadderIndex | undefined): void {
  const ladderNamed = (name: string, what: string) => {
    const ladder = ladders?.ladders.find((l) => l.name === name);
    if (!ladder) throw new AuthzConfigError(`${where}: ${what} names unknown ladder '${name}' (${RULE})`);
    return ladder;
  };
  const roleOn = (role: string, ladder: string | undefined, what: string) => {
    if (!graph.has(role)) throw new AuthzConfigError(`${where}: ${what} names unknown role '${role}' (${RULE})`);
    const on = ladders?.ladderOf(role);
    if (!on) throw new AuthzConfigError(`${where}: ${what} names role '${role}', which is on no ladder (${RULE})`);
    if (ladder !== undefined && on.name !== ladder) throw new AuthzConfigError(`${where}: ${what} names role '${role}' of ladder '${on.name}', not of ladder '${ladder}' (${RULE})`);
  };
  if (def.ladder !== undefined) ladderNamed(def.ladder, 'ladder');
  if (typeof def.maxRole === 'string') roleOn(def.maxRole, def.ladder, 'maxRole');
  if (typeof def.minRole === 'string') roleOn(def.minRole, def.ladder, 'minRole');
  const rank = def.subjects?.rank;
  if (rank) {
    ladderNamed(rank.ladder, 'subjects.rank');
    for (const k of ['lt', 'eq', 'gte'] as const) if (rank[k] !== undefined) roleOn(rank[k]!, rank.ladder, `subjects.rank.${k}`);
  }
  for (const s of def.allow ?? []) if ('set' in s && !graph.has(s.set.role)) throw new AuthzConfigError(`${where}: allow names unknown role '${s.set.role}' (${RULE})`);
  for (const ref of [def.maxRole, def.minRole]) {
    if (ref !== null && typeof ref === 'object' && !REF.test(ref.ref)) throw new AuthzConfigError(`${where}: '${ref.ref}' is not a ref of the form scope.<type>.<path>, principal.<path>, actor.<path> or env.<path>`);
  }
}

const REF = /^(scope\.[^.]+|principal|actor|env)\.[^.]+(\.[^.]+)*$/;

/** Boot refs (design §6.5 rules 7 and 10): literal permissions, `at` types, and scope types the rule reads. */
export function ruleRefs(rule: CompiledRule): { permissionRefs: PermissionRefDecl[]; scopeRefs: ScopeRefDecl[] } {
  const source = `rbac rule '${rule.def.id}'`;
  const permissionRefs = (rule.def.kind === 'threshold' ? rule.def.permissions ?? [] : []).filter((p) => !p.includes('*')).map((permission) => ({ permission, source }));
  const types = new Set<string>();
  if (rule.def.at) types.add(rule.def.at);
  if (rule.def.subjects?.rank) types.add(rule.def.subjects.rank.at);
  for (const c of [rule.when, rule.subjectsWhen, rule.resource]) for (const t of c?.facts.scopeTypes ?? []) types.add(t);
  for (const ref of [rule.def.maxRole, rule.def.minRole]) if (ref !== null && typeof ref === 'object' && ref.ref.startsWith('scope.')) types.add(ref.ref.split('.')[1]);
  return { permissionRefs, scopeRefs: [...types].map((type) => ({ type, source })) };
}

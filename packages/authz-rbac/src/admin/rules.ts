import { AuthzAdminFailure, AuthzWriteHandler, assertAdminPermission, ConditionCompiler, ConditionFunction, DefaultConditionCompiler, GLOBAL, adminActor, adminContainer } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, Condition, DecisionRequest, EvaluationContext, Permission, PermissionRegistry, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { RuleDef } from '../contracts.js';
import { actorRef, checkPermissionName, event, invalid, isPlainObject, quote, readExpiry, readId, readPrincipal, readScope, readSubject, roleIndex, ruleStore } from './common.js';
import { checkCondition } from './conditions.js';
import type { RoleIndex } from './common.js';
import { sameRef } from './rows.js';

type Rule = Omit<RuleDef, 'source'>;

const MANAGE: Permission = 'authz:rules.manage';
const KINDS = ['restrict', 'cap', 'threshold'];
// What a stored rule may hold: the RuleDef keys but source.
const RULE_KEYS = ['id', 'kind', 'scope', 'resourceTypes', 'subjects', 'when', 'expiresAt', 'allow', 'ladder', 'maxRole', 'stripTags', 'assignments', 'permissions', 'resource', 'minRole', 'at', 'reason'] as const;

/** Thrown by every read of the probe context: a condition that needs data to compile is not refused for it. */
class ProbeRead extends Error {}

function causedByProbe(e: unknown): boolean {
  for (let cur = e, depth = 0; cur instanceof Error && depth < 8; cur = (cur as { cause?: unknown }).cause, depth++) if (cur instanceof ProbeRead) return true;
  return false;
}

const refuseRead = (): never => {
  throw new ProbeRead('the admin compile probe reads no data');
};

const PROBE_REGISTRY = new Proxy({} as PermissionRegistry, { get: () => refuseRead });

/** An EvaluationContext whose reads fail: the probe only asks whether a condition compiles. */
function probeContext(ctx: AdminContext, conditions: ConditionCompiler): EvaluationContext {
  return {
    domain: ctx.domain,
    now: ctx.now,
    permissions: PROBE_REGISTRY,
    conditions,
    cache: new Map(),
    ancestors: async () => refuseRead(),
    attributes: async () => refuseRead(),
    relation: () => refuseRead(),
    check: async () => refuseRead(),
    trace: () => undefined,
  };
}

function roleField(rule: Record<string, unknown>, key: 'minRole' | 'maxRole'): string | undefined {
  const v = rule[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (isPlainObject(v) && typeof v.ref === 'string' && v.ref !== '') return undefined;
  throw invalid(`rule.${key}`, `rule.${key} must be a role name or { ref }`);
}

function stringList(v: unknown, field: string): void {
  if (v !== undefined && (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== ''))) throw invalid(field, `${field} must be a list of non-empty strings`);
}

function roleOnLadder(roles: RoleIndex, role: string, ladder: string | undefined, field: string): void {
  if (!roles.roles.has(role)) throw new AuthzAdminFailure('unknown_role', `role ${quote(role)} does not exist`, field);
  if (ladder !== undefined && !roles.ladders.get(ladder)!.roles.includes(role) && roles.ladderOf(role) !== ladder) throw new AuthzAdminFailure('unknown_role', `role ${quote(role)} is not on ladder ${quote(ladder)}`, field);
}

function knownLadder(roles: RoleIndex, ladder: unknown, field: string): string {
  const name = readId(ladder, field);
  if (!roles.ladders.has(name)) throw new AuthzAdminFailure('unknown_ladder', `ladder ${quote(name)} does not exist`, field);
  return name;
}

/** rule.put (insert or replace by id, at the same scope) and rule.delete, on the AdminRuleStore. */
@Singleton()
@Injectable(AuthzWriteHandler)
export class RbacRuleHandler extends AuthzWriteHandler {
  readonly kinds = ['rule.put', 'rule.delete'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind === 'rule.delete') {
      readId(c.id);
      return;
    }
    if (c.kind !== 'rule.put') throw new AuthzAdminFailure('not_found', `RbacRuleHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    const rule = await this.ruleOf(c);
    const roles = await roleIndex(ctx);
    const r = rule as unknown as Record<string, unknown>;

    const ladder = rule.ladder === undefined ? undefined : knownLadder(roles, rule.ladder, 'rule.ladder');
    for (const key of ['minRole', 'maxRole'] as const) {
      const role = roleField(r, key);
      if (role !== undefined) roleOnLadder(roles, role, ladder, `rule.${key}`);
    }
    if (rule.at !== undefined) readId(rule.at, 'rule.at');
    if (rule.kind === 'threshold' && rule.minRole === undefined) throw invalid('rule.minRole', 'a threshold rule needs minRole');
    if (rule.kind === 'threshold' && rule.at !== undefined && rule.ladder === undefined) throw invalid('rule.ladder', 'a threshold rule names at only with a ladder');
    if (rule.kind === 'cap' && rule.maxRole === undefined && rule.stripTags !== true) throw invalid('rule.maxRole', 'a cap rule needs maxRole (null drops the assignment) or stripTags');
    if (rule.kind === 'cap' && rule.maxRole !== undefined && rule.ladder === undefined) throw new AuthzAdminFailure('rule_not_compilable', 'a cap with maxRole needs the ladder it caps', 'rule.ladder');
    stringList(rule.resourceTypes, 'rule.resourceTypes');
    if (rule.permissions !== undefined) {
      if (!Array.isArray(rule.permissions)) throw invalid('rule.permissions', 'rule.permissions must be a list');
      for (const [i, p] of rule.permissions.entries()) await checkPermissionName(ctx, p, `rule.permissions.${i}`);
    }
    if (rule.allow !== undefined) {
      if (!Array.isArray(rule.allow)) throw invalid('rule.allow', 'rule.allow must be a list of subjects');
      rule.allow.forEach((s, i) => readSubject(s, `rule.allow.${i}`, roles));
    }
    if (rule.assignments !== undefined) {
      if (!isPlainObject(rule.assignments)) throw invalid('rule.assignments', 'rule.assignments must be { scopeTypes?, subjectTypes? }');
      stringList(rule.assignments.scopeTypes, 'rule.assignments.scopeTypes');
      stringList(rule.assignments.subjectTypes, 'rule.assignments.subjectTypes');
    }
    if (rule.subjects !== undefined) this.subjectsOf(rule.subjects, roles);
    if (rule.stripTags !== undefined && typeof rule.stripTags !== 'boolean') throw invalid('rule.stripTags', 'rule.stripTags must be a boolean');
    if (rule.reason !== undefined && !(isPlainObject(rule.reason) && typeof rule.reason.code === 'string' && rule.reason.code !== '')) throw invalid('rule.reason', 'rule.reason must be { code, ... }');

    await this.compiles(rule, ctx);
    await this.sameScope(rule, ctx);
    (await ruleStore(ctx)).assertStorable(rule);
  }

  async permission(c: AuthzCommand, ctx: AdminContext): Promise<{ permission: Permission; resource: ResourceRef }> {
    if (c.kind === 'rule.put') return { permission: MANAGE, resource: readScope((c.rule as { scope?: unknown } | undefined)?.scope, 'rule.scope') };
    return { permission: MANAGE, resource: (await this.row(c as Extract<AuthzCommand, { kind: 'rule.delete' }>, ctx)).scope };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ id?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const store = await ruleStore(ctx);
    if (c.kind === 'rule.put') {
      const rule = await this.ruleOf(c);
      // Again inside the transaction: an earlier command of the batch may have put this id elsewhere.
      await this.sameScope(rule, ctx);
      await store.put(rule, actorRef(ctx), tx);
      return { id: rule.id, affected: 1, tags: [`rule:${rule.id}`], events: [event(ctx, 'RuleChanged', { id: rule.id, scope: rule.scope, op: 'put' })] };
    }
    const row = await this.row(c as Extract<AuthzCommand, { kind: 'rule.delete' }>, ctx);
    // Again inside the transaction: another batch may have moved the rule since permission() read its scope.
    await assertAdminPermission(ctx, 'rule.delete', row.scope, MANAGE);
    await store.delete(row.id, tx);
    return { id: row.id, affected: 1, tags: [`rule:${row.id}`], events: [event(ctx, 'RuleChanged', { id: row.id, scope: row.scope, op: 'delete' })] };
  }

  private async ruleOf(c: Extract<AuthzCommand, { kind: 'rule.put' }>): Promise<Rule> {
    const rule: unknown = c.rule;
    if (!isPlainObject(rule)) throw invalid('rule', 'rule must be an object');
    readId(rule.id, 'rule.id');
    if (typeof rule.kind !== 'string' || !KINDS.includes(rule.kind)) throw invalid('rule.kind', `rule.kind must be one of ${KINDS.join(', ')}`);
    const scope = readScope(rule.scope, 'rule.scope');
    const expiresAt = readExpiry(rule.expiresAt, 'rule.expiresAt');
    const known: Record<string, unknown> = {};
    for (const k of RULE_KEYS) if (rule[k] !== undefined) known[k] = rule[k];
    return { ...(known as unknown as Rule), scope, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }

  private subjectsOf(v: unknown, roles: RoleIndex): void {
    if (!isPlainObject(v)) throw invalid('rule.subjects', 'rule.subjects must be a subject selector');
    stringList(v.principalTypes, 'rule.subjects.principalTypes');
    stringList(v.actorTypes, 'rule.subjects.actorTypes');
    if (v.refs !== undefined) {
      if (!Array.isArray(v.refs)) throw invalid('rule.subjects.refs', 'rule.subjects.refs must be a list of principal refs');
      v.refs.forEach((p, i) => readPrincipal(p, `rule.subjects.refs.${i}`));
    }
    if (v.rank !== undefined) {
      if (!isPlainObject(v.rank)) throw invalid('rule.subjects.rank', 'rule.subjects.rank must be { ladder, at, lt?, eq?, gte? }');
      const ladder = knownLadder(roles, v.rank.ladder, 'rule.subjects.rank.ladder');
      readId(v.rank.at, 'rule.subjects.rank.at');
      for (const key of ['lt', 'eq', 'gte'] as const) {
        const role = v.rank[key];
        if (role !== undefined) roleOnLadder(roles, readId(role, `rule.subjects.rank.${key}`), ladder, `rule.subjects.rank.${key}`);
      }
    }
  }

  /** Conditions compile through the domain's ConditionCompiler; without one a rule with a condition cannot be evaluated. */
  private async compiles(rule: Rule, ctx: AdminContext): Promise<void> {
    const conditions: [string, Condition][] = [];
    if (rule.when !== undefined) conditions.push(['rule.when', rule.when]);
    if (rule.resource !== undefined) conditions.push(['rule.resource', rule.resource]);
    if (rule.subjects?.when !== undefined) conditions.push(['rule.subjects.when', rule.subjects.when]);
    if (conditions.length === 0) return;
    const container = adminContainer(ctx);
    const hasCompiler = container.hasRegistered(ConditionCompiler);
    const compiler = hasCompiler ? ((await container.resolve(ConditionCompiler)) as ConditionCompiler) : undefined;
    // The core's DefaultConditionCompiler parses with its own functions; then it alone judges fn names. Any other compiler keeps the name check.
    const parses = compiler instanceof DefaultConditionCompiler;
    const functions = !parses && container.hasRegistered(ConditionFunction) ? [...(await container.resolveChain(ConditionFunction))].map((f) => (f as ConditionFunction).name) : [];
    // No function registered: every fn is unknown, which matters only where conditions compile at all.
    const fnKnown = (name: string) => parses || (functions.length > 0 ? functions.includes(name) : !hasCompiler);
    for (const [field, condition] of conditions) checkCondition(condition, field, fnKnown);
    if (!compiler) throw new AuthzAdminFailure('rule_not_compilable', `authz domain ${quote(ctx.domain)} has no ConditionCompiler, so a rule condition cannot be evaluated`, conditions[0][0]);
    if (parses) {
      for (const [field, condition] of conditions) {
        try {
          compiler.parse(condition, field);
        } catch (e) {
          // The parse error names the field already (its where).
          throw new AuthzAdminFailure('rule_not_compilable', e instanceof Error ? e.message : String(e), field);
        }
      }
    }
    const literal = rule.permissions?.find((p) => !p.includes('*'));
    const req: DecisionRequest = { principal: adminActor(ctx), permission: literal ?? MANAGE, resource: GLOBAL };
    for (const [field, condition] of conditions) {
      try {
        await compiler.compile(condition, req, probeContext(ctx, compiler));
      } catch (e) {
        if (causedByProbe(e)) continue;
        throw new AuthzAdminFailure('rule_not_compilable', `${field} does not compile: ${e instanceof Error ? e.message : String(e)}`, field);
      }
    }
  }

  private async sameScope(rule: Rule, ctx: AdminContext): Promise<void> {
    const existing = await (await ruleStore(ctx)).byId(rule.id);
    if (existing && !sameRef(existing.scope, rule.scope)) throw new AuthzAdminFailure('conflict', `rule ${quote(rule.id)} exists at another scope; delete it there first`, 'rule.id');
  }

  private async row(c: { readonly id: unknown }, ctx: AdminContext): Promise<RuleDef> {
    const id = readId(c.id);
    const row = await (await ruleStore(ctx)).byId(id);
    if (!row) throw new AuthzAdminFailure('not_found', `no rule ${quote(id)}`, 'id');
    return row;
  }
}

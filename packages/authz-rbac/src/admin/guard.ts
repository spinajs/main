import { AdminGuard, AuthzAdminFailure, AuthzConfigError, GLOBAL, adminContainer, isPermission, principalKey, resourceKey } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, Permission, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';

import type { Assignment, AssignmentSubject } from '../contracts.js';
import { assignmentStore, grantClosure, grantsPermission, isPlainObject, ladderAppliesAt, linkGrants, linkStore, plannedRemovals, quote, rankOf, readExpiry, readId, readScope, roleIndex } from './common.js';
import type { PlannedRemovals, RoleIndex } from './common.js';
import { RbacAdminFacts } from './facts.js';
import { isLive, isSetSubject } from './rows.js';

export interface AdminGuardConfig {
  /** Required while preventSelfLockout or preventLastPrivilegedRemoval is on. */
  readonly privilegedPermission?: Permission;
  readonly protectSystemRole: boolean;
  readonly preventEscalation: boolean;
  readonly preventSelfLockout: boolean;
  readonly preventLastPrivilegedRemoval: boolean;
}

const KEY = 'authz.admin.guard';
const SWITCHES = ['protectSystemRole', 'preventEscalation', 'preventSelfLockout', 'preventLastPrivilegedRemoval'] as const;

/** The `authz.admin.guard` section; an absent switch is on (fail closed). */
export function readGuardConfig(section: unknown, where: string): AdminGuardConfig {
  const fail = (key: string, expected: string, got: unknown): never => {
    throw new AuthzConfigError(`${where}: configuration key ${KEY}${key} must be ${expected}, got ${quote(got)}`);
  };
  if (section !== undefined && !isPlainObject(section)) fail('', 'an object', section);
  const s = (section ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of SWITCHES) {
    const v = s[name] ?? true;
    if (typeof v !== 'boolean') fail(`.${name}`, 'a boolean', v);
    out[name] = v;
  }
  if (out.preventSelfLockout || out.preventLastPrivilegedRemoval) {
    if (!isPermission(s.privilegedPermission)) fail('.privilegedPermission', 'a permission name (the self-lockout and last-holder checks need it)', s.privilegedPermission);
    out.privilegedPermission = s.privilegedPermission;
  }
  return out as unknown as AdminGuardConfig;
}

type Kind = AuthzCommand['kind'];

// Every kind of the contract, so a misspelt or missing kind fails to compile; true marks the guarded ones.
const GUARDED: Readonly<Record<Kind, boolean>> = {
  'assignment.grant': true,
  'assignment.revoke': true,
  'assignment.revokeWhere': true,
  'assignment.setTags': true,
  'assignment.addTags': true,
  'assignment.removeTags': true,
  'assignment.setExpiry': true,
  'set.addMember': true,
  'set.removeMember': true,
  'link.create': true,
  'link.update': true,
  'link.revoke': true,
  'rule.put': true,
  // Deleting a rule grants no role; its permission (authz:rules.manage) is the guard.
  'rule.delete': false,
  'policy.put': false,
  'policy.delete': false,
  'scope.setAttributes': false,
  'scope.replaceAttributes': false,
  // Design §6.6.2: guarded by its permission only.
  'scope.forget': false,
};

/** A role granted at a scope; `field` names the command field the refusal points at. */
interface Target {
  readonly role: string;
  readonly scope: ResourceRef;
  readonly field: string;
}

interface Call {
  readonly actor: Principal;
  readonly ctx: AdminContext;
  readonly cfg: AdminGuardConfig;
  readonly roles: RoleIndex;
  readonly privileged: (role: string) => boolean;
  /** The actor's effective role per ladder and scope, asked once per command. */
  readonly ranks: Map<string, Promise<string | undefined>>;
}

const refuse = (code: string, message: string, field?: string): AuthzAdminFailure => new AuthzAdminFailure(code, message, field);
const sameSubject = (s: AssignmentSubject, p: PrincipalRef): boolean => !isSetSubject(s) && principalKey(s) === principalKey(p);

/**
 * The AdminGuard of authz.admin.guard.service (design §6.6.2, lane design §4.3). Runs inside the batch
 * transaction, so it reads the batch's own earlier writes. Never injects AuthzService: it checks through
 * ctx.authz and RbacAdminFacts, and reads authz.admin.guard on every call.
 */
@Singleton()
@Injectable(AdminGuard)
export class DefaultAdminGuard extends AdminGuard {
  async check(actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const kind: unknown = isPlainObject(c) ? c.kind : undefined;
    // Unknown kinds reach no handler (not_found); the handler owns validation.
    if (typeof kind !== 'string' || !Object.hasOwn(GUARDED, kind) || !GUARDED[kind as Kind]) return;
    const container = adminContainer(ctx);
    const where = `Authz domain ${quote(ctx.domain)}`;
    const configuration = (await container.resolve(Configuration)) as unknown as Configuration;
    const cfg = readGuardConfig(configuration.get(['authz', 'admin', 'guard']), where);
    const roles = await roleIndex(ctx);
    const memo = new Map<string, boolean>();
    const privileged = (role: string): boolean => {
      if (cfg.privilegedPermission === undefined) return false;
      if (!memo.has(role)) memo.set(role, roles.roles.has(role) && grantsPermission(roles, role, cfg.privilegedPermission));
      return memo.get(role)!;
    };
    const call: Call = { actor, ctx, cfg, roles, privileged, ranks: new Map() };
    if (cfg.preventEscalation) await this.escalation(call, c);
    await this.removals(call, c);
  }

  // ---- escalation ----

  private async escalation(call: Call, c: AuthzCommand): Promise<void> {
    const facts = await this.facts(call.ctx);
    if (c.kind === 'rule.put') {
      await this.ruleRoles(call, facts, c.rule as unknown as Record<string, unknown>);
      return;
    }
    for (const t of await this.granted(call, c)) {
      const what = `${principalKey(call.actor)} may not grant ${quote(t.role)} at ${quote(t.scope)}`;
      if (!(await facts.covers(call.actor, t.role, t.scope, call.ctx))) throw refuse('escalation', `${what}: it does not hold every permission of the role there`, t.field);
      // Every ladder role the grant gives, through extends and implies too, must rank at or below the actor's own.
      const holds = (ladder: string, name: string) => this.ranksAtLeast(call, facts, ladder, name, t.scope);
      for (const { name } of (await grantClosure(call.roles, t.role, holds)).defs) {
        const ladder = call.roles.ladderOf(name);
        if (ladder === undefined || (await holds(ladder, name))) continue;
        const which = name === t.role ? 'the role' : `it gives ${quote(name)}, which`;
        throw refuse('escalation', `${what}: ${which} ranks above its own on ladder ${quote(ladder)}`, t.field);
      }
    }
  }

  /** The roles a command gives someone, each at its scope. */
  private async granted(call: Call, c: AuthzCommand): Promise<Target[]> {
    const { ctx } = call;
    switch (c.kind) {
      case 'assignment.grant': {
        const scope = readScope(c.scope, 'scope');
        const role = readId(c.role, 'role');
        return [{ role, scope, field: 'role' }, ...(isSetSubject(c.subject) ? [] : await this.reach(call, role, scope, 'role'))];
      }
      case 'set.addMember': {
        const set = c.set as { role?: unknown; scope?: unknown };
        const role = readId(set.role, 'set.role');
        const scope = readScope(set.scope, 'set.scope');
        return [{ role, scope, field: 'set.role' }, ...(await this.reach(call, role, scope, 'set.role'))];
      }
      case 'link.create': {
        const role = readId(c.role, 'role');
        const scope = readScope(c.scope, 'scope');
        return [{ role, scope, field: 'role' }, ...(await this.reach(call, role, scope, 'role'))];
      }
      case 'link.update': {
        const link = await (await linkStore(ctx)).byId(readId(c.id));
        if (!link) return [];
        // A new role replaces the link's grant, so it covers whatever else the command changes.
        if (c.role !== undefined) {
          const role = readId(c.role, 'role');
          return [{ role, scope: link.scope, field: 'role' }, ...(await this.reach(call, role, link.scope, 'role'))];
        }
        const current = (await linkGrants(link.id, ctx, true)) ?? [];
        const out: Target[] = [];
        if (extendsExpiry(link.expiresAt, c.expiresAt)) for (const a of current) out.push({ role: a.role, scope: a.scope, field: 'expiresAt' }, ...(await this.reach(call, a.role, a.scope, 'expiresAt')));
        if (c.tags !== undefined) out.push(...current.filter((a) => adds(a, c.tags)).map((a) => ({ role: a.role, scope: a.scope, field: 'tags' })));
        return out;
      }
      case 'assignment.setExpiry': {
        const row = await (await assignmentStore(ctx)).byId(readId(c.id));
        if (!row || !extendsExpiry(row.expiresAt, c.expiresAt)) return [];
        return [{ role: row.role, scope: row.scope, field: 'expiresAt' }, ...(isSetSubject(row.subject) ? [] : await this.reach(call, row.role, row.scope, 'expiresAt'))];
      }
      case 'assignment.setTags':
      case 'assignment.addTags': {
        const row = await (await assignmentStore(ctx)).byId(readId(c.id));
        return row && adds(row, c.tags) ? [{ role: row.role, scope: row.scope, field: 'tags' }] : [];
      }
      default:
        return [];
    }
  }

  /** Holding a subject set role at a scope also gives every role assigned to that set. */
  private async reach(call: Call, role: string, scope: ResourceRef, field: string): Promise<Target[]> {
    if (call.roles.roles.get(role)?.subjectSet !== true) return [];
    const { items } = await (await assignmentStore(call.ctx)).find({ subject: { set: { role, scope } }, at: call.ctx.now });
    return items.map((a) => ({ role: a.role, scope: a.scope, field }));
  }

  /** A role a rule names (minRole, a string maxRole) must not rank above the actor's own at the rule scope. */
  private async ruleRoles(call: Call, facts: RbacAdminFacts, rule: Record<string, unknown>): Promise<void> {
    const scope = readScope(rule.scope, 'rule.scope');
    const ladderOfRule = typeof rule.ladder === 'string' ? rule.ladder : undefined;
    for (const key of ['minRole', 'maxRole'] as const) {
      const role = rule[key];
      if (typeof role !== 'string') continue;
      const ladder = ladderOfRule ?? call.roles.ladderOf(role);
      const what = `${principalKey(call.actor)} may not name ${quote(role)} in a rule at ${quote(scope)}`;
      if (ladder !== undefined) {
        if (!(await this.ranksAtLeast(call, facts, ladder, role, scope))) throw refuse('escalation', `${what}: it ranks above its own on ladder ${quote(ladder)}`, `rule.${key}`);
      } else if (!(await facts.covers(call.actor, role, scope, call.ctx))) {
        throw refuse('escalation', `${what}: it does not hold every permission of the role there`, `rule.${key}`);
      }
    }
  }

  private async ranksAtLeast(call: Call, facts: RbacAdminFacts, ladder: string, role: string, scope: ResourceRef): Promise<boolean> {
    const wanted = rankOf(call.roles, ladder, role);
    // A role its ladder does not list has no rank anyone can reach; a ladder that does not apply at the
    // scope's type gives no rank there.
    if (wanted < 0 || !ladderAppliesAt(call.roles, ladder, scope)) return false;
    const key = `${ladder}\u0000${resourceKey(scope)}`;
    if (!call.ranks.has(key)) call.ranks.set(key, facts.effectiveRole(call.actor, ladder, scope, call.ctx));
    const own = await call.ranks.get(key)!;
    return own !== undefined && rankOf(call.roles, ladder, own) >= wanted;
  }

  // ---- removals ----

  private async removals(call: Call, c: AuthzCommand): Promise<void> {
    const { ctx, cfg, roles } = call;
    const planned = await plannedRemovals(c, ctx);
    // Rows whose tags or expiry change count for protectSystemRole and the rank check, besides the removed ones.
    const touched: Assignment[] = [...planned.revoke, ...planned.expire];
    if (c.kind === 'assignment.setTags' || c.kind === 'assignment.addTags' || c.kind === 'assignment.removeTags' || c.kind === 'assignment.setExpiry') {
      const row = await (await assignmentStore(ctx)).byId(readId(c.id));
      if (row) touched.push(row);
    }
    if (c.kind === 'link.update' && (c.tags !== undefined || c.expiresAt !== undefined) && planned.revoke.length === 0) touched.push(...((await linkGrants(readId(c.id), ctx, true)) ?? []));

    if (cfg.protectSystemRole) {
      const system = touched.find((a) => roles.roles.get(a.role)?.assignable === false);
      if (system) throw refuse('protected_role', `assignment ${quote(system.id)} holds the system role ${quote(system.role)}; only SYSTEM changes it`, idField(c));
    }

    if (cfg.preventEscalation) await this.removalRanks(call, c, planned, touched);

    const until = 'expiresAt' in c ? readExpiry(c.expiresAt) : undefined;
    const removed = [
      ...planned.revoke.filter((a) => isLive(a.expiresAt, ctx.now)),
      // Moving an expiry later takes nothing away; renewing a lapsed row is such a move.
      ...planned.expire.filter((a) => !(a.expiresAt != null && until != null && until.getTime() > a.expiresAt.getTime())),
    ];
    if (removed.length === 0 || cfg.privilegedPermission === undefined) return;
    if (cfg.preventSelfLockout && (await this.locksOut(call, removed))) throw refuse('self_lockout', `${principalKey(call.actor)} would lose ${quote(cfg.privilegedPermission)}`, idField(c));
    if (cfg.preventLastPrivilegedRemoval && (await this.lastHolder(call, removed))) throw refuse('last_holder', `no principal would keep ${quote(cfg.privilegedPermission)} at GLOBAL`, idField(c));
  }

  /**
   * Design §6.6.2: a ladder role a command revokes, re-expires or edits ranks at or below the actor's own on
   * that ladder at the row scope. A removed or re-expired principal row also takes the roles of the subject
   * sets it makes the principal a member of. Expired rows count; a role on no ladder is not checked.
   */
  private async removalRanks(call: Call, c: AuthzCommand, planned: PlannedRemovals, touched: readonly Assignment[]): Promise<void> {
    if (touched.length === 0) return;
    const facts = await this.facts(call.ctx);
    const revoked = new Set(planned.revoke.map((a) => a.id));
    const field = (a: Assignment): string | undefined => {
      if (c.kind !== 'assignment.grant' && c.kind !== 'set.addMember') return idField(c);
      return revoked.has(a.id) ? 'replaceLadder' : 'expiresAt';
    };
    const check = async (a: Assignment, role: string, scope: ResourceRef, via: string): Promise<void> => {
      const ladder = call.roles.ladderOf(role);
      if (ladder === undefined || (await this.ranksAtLeast(call, facts, ladder, role, scope))) return;
      const what = `${principalKey(call.actor)} may not ${revoked.has(a.id) ? 'revoke' : 'change'} ${quote(a.role)} at ${quote(a.scope)} (assignment ${quote(a.id)})`;
      throw refuse('escalation', `${what}: ${via} ranks above its own on ladder ${quote(ladder)}`, field(a));
    };
    for (const a of touched) await check(a, a.role, a.scope, 'the role');
    for (const a of [...planned.revoke, ...planned.expire]) {
      if (isSetSubject(a.subject)) continue;
      for (const t of await this.reach(call, a.role, a.scope, '')) await check(a, t.role, t.scope, `the set holds ${quote(t.role)} at ${quote(t.scope)}, which`);
    }
  }

  /** The actor reaches privilegedPermission through a removed row: its own, its set's, or a set membership. */
  private async locksOut(call: Call, removed: readonly Assignment[]): Promise<boolean> {
    const store = await assignmentStore(call.ctx);
    for (const a of removed) {
      if (isSetSubject(a.subject)) {
        if (!call.privileged(a.role)) continue;
        const { items } = await store.find({ scope: a.subject.set.scope, role: a.subject.set.role, at: call.ctx.now });
        if (items.some((m) => sameSubject(m.subject, call.actor))) return true;
        continue;
      }
      if (!sameSubject(a.subject, call.actor)) continue;
      if (call.privileged(a.role)) return true;
      if (call.roles.roles.get(a.role)?.subjectSet === true) {
        const { items } = await store.find({ subject: { set: { role: a.role, scope: a.scope } }, at: call.ctx.now });
        if (items.some((s) => call.privileged(s.role))) return true;
      }
    }
    return false;
  }

  /**
   * Every principal holding privilegedPermission at GLOBAL (a GLOBAL row of a role that grants it, directly
   * or through a set it is a member of) would lose it. Nobody holding it before is no reason to refuse.
   */
  private async lastHolder(call: Call, removed: readonly Assignment[]): Promise<boolean> {
    const store = await assignmentStore(call.ctx);
    const gone = new Set(removed.map((a) => a.id));
    const before = new Set<string>();
    const after = new Set<string>();
    const path = (holder: AssignmentSubject, rows: readonly string[]) => {
      if (isSetSubject(holder)) return;
      const key = principalKey(holder);
      before.add(key);
      if (!rows.some((id) => gone.has(id))) after.add(key);
    };
    for (const role of call.roles.roles.keys()) {
      if (!call.privileged(role)) continue;
      for (const a of (await store.find({ scope: GLOBAL, role, at: call.ctx.now })).items) {
        if (!isSetSubject(a.subject)) {
          path(a.subject, [a.id]);
          continue;
        }
        for (const m of (await store.find({ scope: a.subject.set.scope, role: a.subject.set.role, at: call.ctx.now })).items) path(m.subject, [a.id, m.id]);
      }
    }
    return before.size > 0 && after.size === 0;
  }

  private async facts(ctx: AdminContext): Promise<RbacAdminFacts> {
    const container = adminContainer(ctx);
    if (!container.hasRegistered(RbacAdminFacts)) throw new AuthzConfigError(`Authz domain ${quote(ctx.domain)}: no RbacAdminFacts is registered; DefaultAdminGuard needs one`);
    return (await container.resolve(RbacAdminFacts)) as RbacAdminFacts;
  }
}

/**
 * The new expiry (null: none) lies after the current one. Renewing a lapsed row or link is such a move: it
 * gives the role again, so the guard treats it as a grant. Moving it earlier is a removal instead.
 */
function extendsExpiry(current: Date | null | undefined, next: unknown): boolean {
  if (next === undefined || current == null) return false;
  const until = readExpiry(next);
  return until == null || until.getTime() > current.getTime();
}

/** The command adds a tag the row does not hold yet. */
function adds(row: Assignment, tags: unknown): boolean {
  const held = new Set(row.tags ?? []);
  return Array.isArray(tags) && tags.some((t) => !held.has(t as string));
}

const idField = (c: AuthzCommand): string | undefined => ('id' in c ? 'id' : undefined);

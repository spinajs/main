import { Container, Inject, Injectable, PerChildInstance, ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { AdminGuard, AuthzAdmin, AuthzAdminFailure, AuthzCommandValidator, AuthzEventSink, AuthzWriteHandler } from '../contracts/admin.js';
import type { AuthzAdminOptions, AuthzAdminQuery, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzTx } from '../contracts/admin.js';
import type { Assignment, LinkDef, Policy, RuleDef } from '../contracts/data.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Permission } from '../contracts/permission.js';
import { SYSTEM, principalKey } from '../contracts/principal.js';
import type { Principal, PrincipalRef, ResourceRef } from '../contracts/principal.js';
import { GLOBAL } from '../contracts/resource.js';
import { AuthzDomains, AuthzService, ChangeBus, DecisionAudit } from '../contracts/service.js';
import { readDomainConfig } from '../host/config/domain-config.js';
import { AuthzClock } from '../host/clock.js';
import { DefaultAuthzDomains } from '../host/domains.js';
import { engineLog } from '../host/log.js';
import { AuthzAdminBackend } from './backend.js';
import { mapPermission, readAdminConfig } from './config.js';
import type { AdminConfig } from './config.js';
import type { AdminCallContext } from './context.js';
import { requirePermitted } from './permit.js';
import { AuthzAdminReader } from './ports.js';
// The default AuthzEventSink registration.
import './sink.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SECRET_KEY = /token|secret|password/i;

type Applied = { readonly id?: string; readonly token?: string; readonly affected: number; readonly tags: readonly string[]; readonly events: readonly AuthzEvent[]; readonly row?: unknown };
type Checked = { readonly handler: AuthzWriteHandler; readonly permission: Permission; readonly resource: ResourceRef };
type OkResult = Extract<AuthzCommandResult, { ok: true }>;
/** What a sugar method needs from apply; checked inside the transaction. */
type Needs = { readonly row?: boolean; readonly token?: boolean };

interface Env {
  readonly where: string;
  readonly domain: string;
  readonly service: AuthzService;
  readonly cfg: AdminConfig;
  readonly guard: AdminGuard;
  readonly backend: AuthzAdminBackend;
  readonly clock: AuthzClock;
  readonly bus: ChangeBus | undefined;
  readonly audit: DecisionAudit | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const q = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};
const describeError = (e: unknown): string => (e instanceof Error ? e.message : q(e));
const typeName = (t: unknown): string => (typeof t === 'function' && typeof t.name === 'string' ? t.name : '');
const className = (v: unknown): string => (isObject(v) ? typeName(v.constructor) : '') || q(v);
const kindOf = (c: unknown): AuthzCommand['kind'] => (isObject(c) && typeof c.kind === 'string' ? c.kind : q(isObject(c) ? c.kind : c)) as AuthzCommand['kind'];
const refOf = (p: Principal): PrincipalRef => Object.freeze({ type: p.type, id: p.id });

/** A deep copy without keys that look like secrets; a link token never reaches events, audit or the idempotency store. */
function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (!isObject(value)) return value;
  if (seen.has(value)) return '[circular]' as T;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, seen)) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      Object.defineProperty(out, k, { value: redact(v, seen), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Thrown inside the transaction to roll it back; never leaves execute. */
class Rollback extends Error {}

/**
 * The command bus of design §6.6.2 for one domain container. Everything it needs it resolves per call,
 * never in the constructor: the domain's AuthzService resolves this class during its own boot.
 */
@PerChildInstance()
@Injectable(AuthzAdmin)
@Inject(Container)
export class DefaultAuthzAdmin extends AuthzAdmin {
  private readonly log = engineLog('authz-admin');

  constructor(private readonly container: IContainer) {
    super();
  }

  async execute(actor: Principal, commands: readonly AuthzCommand[], opts?: AuthzAdminOptions): Promise<readonly AuthzCommandResult[]> {
    return (await this.run(actor, commands, opts, 'execute')).results;
  }

  async assign(actor: Principal, a: Omit<Extract<AuthzCommand, { kind: 'assignment.grant' }>, 'kind'>, opts?: AuthzAdminOptions): Promise<Assignment> {
    const { row } = await this.one(actor, { ...a, kind: 'assignment.grant' }, opts, { row: true });
    if (!isObject(row) || typeof row.id !== 'string') throw new AuthzConfigError('AuthzAdmin.assign: the handler of "assignment.grant" returned no Assignment row');
    return row as unknown as Assignment;
  }

  async revoke(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'assignment.revoke', id }, opts);
  }

  async createLink(actor: Principal, l: Omit<Extract<AuthzCommand, { kind: 'link.create' }>, 'kind'>, opts?: AuthzAdminOptions): Promise<{ link: LinkDef; token: string }> {
    const { result, row, replayed, dryRun } = await this.one(actor, { ...l, kind: 'link.create' }, opts, { row: true, token: true });
    if (replayed) throw new AuthzAdminFailure('conflict', 'the link token is shown once; this idempotency key already created the link', 'idempotencyKey');
    if (!isObject(row) || typeof row.id !== 'string') throw new AuthzConfigError('AuthzAdmin.createLink: the handler of "link.create" returned no LinkDef row');
    const link = row as unknown as LinkDef;
    // A dry run returns token '': the link was rolled back, so no token was ever valid.
    if (dryRun) return { link, token: '' };
    if (typeof result.token !== 'string') throw new AuthzConfigError('AuthzAdmin.createLink: the handler of "link.create" returned no token');
    return { link, token: result.token };
  }

  async revokeLink(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'link.revoke', id }, opts);
  }

  async setTags(actor: Principal, assignmentId: string, tags: readonly string[], opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'assignment.setTags', id: assignmentId, tags }, opts);
  }

  async putRule(actor: Principal, rule: Omit<RuleDef, 'source'>, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'rule.put', rule }, opts);
  }

  async deleteRule(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'rule.delete', id }, opts);
  }

  async putPolicy(actor: Principal, policy: Omit<Policy, 'source'>, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'policy.put', policy }, opts);
  }

  async deletePolicy(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'policy.delete', id }, opts);
  }

  async setScopeAttributes(actor: Principal, scope: ResourceRef, patch: Readonly<Record<string, unknown>>, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'scope.setAttributes', scope, patch }, opts);
  }

  async forgetScope(actor: Principal, scope: ResourceRef, opts?: AuthzAdminOptions): Promise<void> {
    await this.one(actor, { kind: 'scope.forget', scope }, opts);
  }

  async list(actor: Principal, query: AuthzAdminQuery): Promise<{ items: readonly unknown[]; total: number }> {
    const env = await this.env();
    assertActor(actor, env.where, 'list');
    const qn = readQuery(query);
    const ctx = this.context(env, actor, env.clock.now(), undefined, false);
    const resource = qn.scope ?? GLOBAL;
    const permission = mapPermission(env.cfg.permissions, `list.${qn.kind}`, resource.type, `authz:${qn.kind}.read`);
    await this.permit(env, actor, permission, resource);

    const readers = new Map<string, AuthzAdminReader>();
    for (const r of await this.chain(AuthzAdminReader)) {
      if (!isObject(r) || !Array.isArray(r.kinds) || typeof r.list !== 'function') throw new AuthzConfigError(`${env.where}: ${className(r)} is not an AuthzAdminReader (kinds, list)`);
      for (const kind of r.kinds) {
        const other = readers.get(kind);
        if (other !== undefined && other !== r) throw new AuthzConfigError(`${env.where}: two AuthzAdminReaders claim query kind ${q(kind)}: ${className(other)} and ${className(r)}`);
        readers.set(kind, r);
      }
    }
    const reader = readers.get(qn.kind);
    if (!reader) throw new AuthzAdminFailure('not_found', `no AuthzAdminReader answers query kind ${q(qn.kind)}`, 'kind');
    const out: unknown = await reader.list(qn, ctx);
    if (!isObject(out) || !Array.isArray(out.items) || typeof out.total !== 'number' || !Number.isInteger(out.total) || out.total < 0) throw new AuthzConfigError(`${env.where}: ${className(reader)}.list() must return { items, total }, got ${q(out)}`);
    return { items: out.items as unknown[], total: out.total };
  }

  /** One command through run(); a failed result throws its error. */
  private async one(actor: Principal, command: AuthzCommand, opts: AuthzAdminOptions | undefined, needs: Needs = {}): Promise<{ result: OkResult; row: unknown; replayed: boolean; dryRun: boolean }> {
    const out = await this.run(actor, [command], opts, command.kind, needs);
    const r = out.results[0];
    if (!r) throw new AuthzConfigError(`AuthzAdmin: ${q(command.kind)} produced no result`);
    if (out.replayed && (out.results.length !== 1 || r.kind !== command.kind)) throw new AuthzAdminFailure('conflict', `idempotency key ${q(opts?.idempotencyKey)} belongs to another batch`, 'idempotencyKey');
    if (!r.ok) throw new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
    return { result: r, row: out.rows[0] ?? undefined, replayed: out.replayed, dryRun: out.dryRun };
  }

  private context(env: Env, actor: Principal, now: Date, reason: string | undefined, dryRun: boolean): AdminCallContext {
    return Object.freeze({
      domain: env.domain,
      now,
      authz: env.service,
      ...(reason === undefined ? {} : { reason }),
      actor,
      container: this.container,
      dryRun,
    });
  }

  private async permit(env: Env, actor: Principal, permission: Permission, resource: ResourceRef): Promise<void> {
    await requirePermitted(env.service, actor, permission, resource);
  }

  private async run(actor: Principal, commands: readonly AuthzCommand[], opts: AuthzAdminOptions | undefined, what: string, needs: Needs = {}): Promise<{ results: readonly AuthzCommandResult[]; rows: readonly unknown[]; replayed: boolean; dryRun: boolean }> {
    const env = await this.env();
    assertActor(actor, env.where, what);
    if (!Array.isArray(commands)) throw new AuthzAdminFailure('invalid_batch', 'commands must be an array');
    if (commands.length > env.cfg.maxBatch) throw new AuthzAdminFailure('invalid_batch', `a batch holds at most ${env.cfg.maxBatch} commands (authz.admin.maxBatch), got ${commands.length}`);
    const options = readOptions(opts);
    const none = { rows: [], replayed: false, dryRun: options.dryRun };
    if (commands.length === 0) return { results: [], ...none };
    // One frozen copy: the command checked is the command applied, audited and evented.
    const list: readonly AuthzCommand[] = commands.map((c, i) => {
      try {
        return deepFreeze(structuredClone(c));
      } catch (e) {
        throw new AuthzAdminFailure('invalid_batch', `command ${i} is not plain data: ${describeError(e)}`, String(i));
      }
    });

    const now = env.clock.now();
    const ctx = this.context(env, actor, now, options.reason, options.dryRun);
    const actorKey = principalKey(actor);
    const key = options.dryRun ? undefined : options.idempotencyKey;
    if (key !== undefined) {
      const stored = await env.backend.recall(env.domain, actorKey, key, now);
      if (stored !== undefined) return { results: structuredClone(stored.results), rows: structuredClone(stored.rows), replayed: true, dryRun: false };
    }

    // Phase A, outside the transaction: validate, app validators, permission check.
    const handlers = await this.handlers(env.where);
    const validators = await this.chain(AuthzCommandValidator);
    const checked: Checked[] = [];
    for (const [i, c] of list.entries()) {
      try {
        checked.push(await this.check(env, handlers, validators, actor, c, ctx));
      } catch (e) {
        if (e instanceof AuthzAdminFailure) return { results: failedAt(list, i, e), ...none };
        throw e;
      }
    }

    // Phase B: the guard runs inside the transaction so that it sees the batch's own earlier writes.
    const rollback = new Rollback('rollback');
    const state: { failure?: { index: number; error: AuthzAdminFailure }; raced?: boolean; results?: OkResult[]; applied?: Applied[] } = {};
    try {
      await env.backend.transaction(env.domain, async (tx: AuthzTx) => {
        const applied: Applied[] = [];
        for (const [i, c] of list.entries()) {
          try {
            if (actor !== SYSTEM) await env.guard.check(actor, c, ctx);
            const a = appliedOf(await checked[i].handler.apply(c, ctx, tx), c.kind, env.where);
            // Checked here, not by the caller: a missing row or token must roll the write back.
            if (needs.row && !(isObject(a.row) && typeof a.row.id === 'string')) throw new AuthzConfigError(`${env.where}: AuthzAdmin.${what}: the handler of ${q(c.kind)} returned no row with an id`);
            if (needs.token && typeof a.token !== 'string') throw new AuthzConfigError(`${env.where}: AuthzAdmin.${what}: the handler of ${q(c.kind)} returned no token`);
            applied.push(a);
          } catch (e) {
            if (e instanceof AuthzAdminFailure) {
              state.failure = { index: i, error: e };
              throw rollback;
            }
            throw e;
          }
        }
        await env.backend.bumpVersion(env.domain, tx);
        const results = applied.map((a, i) => okResult(list[i].kind, a));
        const rows = applied.map((a) => (a.row === undefined ? null : redact(a.row)));
        if (key !== undefined && (await env.backend.remember(env.domain, actorKey, key, { results: results.map(withoutToken), rows }, new Date(now.getTime() + IDEMPOTENCY_TTL_MS), tx)) === 'exists') {
          state.raced = true;
          throw rollback;
        }
        state.results = results;
        state.applied = applied;
        if (options.dryRun) throw rollback;
      });
    } catch (e) {
      // A backend may wrap the rejection of fn.
      if (e !== rollback && !(isObject(e) && (e as { cause?: unknown }).cause === rollback)) throw e;
    }

    if (state.failure) return { results: failedAt(list, state.failure.index, state.failure.error), ...none };
    if (state.raced) {
      const stored = await env.backend.recall(env.domain, actorKey, key!, now);
      if (stored === undefined) throw new AuthzConfigError(`${env.where}: idempotency key ${q(key)} was taken by another batch whose results the backend no longer holds`);
      return { results: structuredClone(stored.results), rows: structuredClone(stored.rows), replayed: true, dryRun: false };
    }
    if (!state.results || !state.applied) throw new AuthzConfigError(`${env.where}: ${className(env.backend)}.transaction() ended without running the batch`);
    const applied = state.applied;
    const rows = applied.map((a) => a.row);
    if (options.dryRun) return { results: state.results.map(withoutToken), rows, replayed: false, dryRun: true };
    await this.afterCommit(env, actor, list, checked, applied, ctx);
    return { results: state.results, rows, replayed: false, dryRun: false };
  }

  private async check(env: Env, handlers: ReadonlyMap<string, AuthzWriteHandler>, validators: readonly AuthzCommandValidator[], actor: Principal, c: AuthzCommand, ctx: AdminCallContext): Promise<Checked> {
    const kind = kindOf(c);
    const handler = handlers.get(kind);
    if (!handler) throw new AuthzAdminFailure('not_found', `no AuthzWriteHandler handles command kind ${q(kind)}`);
    await handler.validate(c, ctx);
    for (const v of validators) await v.validate(actor, c, ctx);
    const wanted: unknown = await handler.permission(c, ctx);
    if (!isObject(wanted) || typeof wanted.permission !== 'string' || !isObject(wanted.resource) || typeof wanted.resource.type !== 'string') {
      throw new AuthzConfigError(`${env.where}: ${className(handler)}.permission() for ${q(kind)} must return { permission, resource }, got ${q(wanted)}`);
    }
    const resource = wanted.resource as unknown as ResourceRef;
    const permission = mapPermission(env.cfg.permissions, kind, resource.type, wanted.permission);
    await this.permit(env, actor, permission, resource);
    return { handler, permission, resource };
  }

  /** Bus, sinks and audit; the batch is committed, so their failures are logged, never thrown. */
  private async afterCommit(env: Env, actor: Principal, list: readonly AuthzCommand[], checked: readonly Checked[], applied: readonly Applied[], ctx: AdminCallContext): Promise<void> {
    const actorRef = refOf(actor);
    const fail = (what: string) => (e: unknown) => this.log.error(`${env.where}: ${what} after a committed admin batch failed: ${describeError(e)}`);

    const tags = [...new Set(applied.flatMap((a) => a.tags))];
    if (env.bus) {
      try {
        await env.bus.publish(Object.freeze({ domain: env.domain, tags: Object.freeze(tags), actor: actorRef, at: new Date(ctx.now.getTime()) }));
      } catch (e) {
        fail('ChangeBus.publish')(e);
      }
    }

    let events: readonly AuthzEvent[] = [];
    try {
      events = deepFreeze(applied.flatMap((a) => a.events).map((e): AuthzEvent => ({ type: e.type, domain: env.domain, actor: { ...actorRef }, at: new Date(ctx.now.getTime()), data: redact(e.data) })));
    } catch (e) {
      fail('preparing the AuthzEvents')(e);
    }
    if (events.length > 0) {
      let sinks: AuthzEventSink[] = [];
      try {
        sinks = await this.chain(AuthzEventSink);
      } catch (e) {
        fail('resolving the AuthzEventSinks')(e);
      }
      for (const sink of sinks) {
        try {
          await sink.publish(events);
        } catch (e) {
          fail(`${className(sink)}.publish`)(e);
        }
      }
    }

    if (env.audit) {
      for (const [i, c] of list.entries()) {
        try {
          await env.audit.record({ kind: 'admin', principal: actorRef, permission: checked[i].permission, resource: checked[i].resource, ...(ctx.reason === undefined ? {} : { reason: ctx.reason }), command: redact(c) });
        } catch (e) {
          fail('DecisionAudit.record')(e);
        }
      }
    }
  }

  private async env(): Promise<Env> {
    const c = this.container;
    if (!isObject(c) || typeof c.resolve !== 'function') throw new AuthzConfigError('DefaultAuthzAdmin needs the container it is resolved in');
    const service = (await c.resolve(AuthzService)) as AuthzService;
    const domain = service.domain;
    const where = `Authz domain ${q(domain)}`;
    const configuration = (await c.resolve(Configuration)) as unknown as Configuration;
    if (!isObject(configuration) || typeof configuration.get !== 'function') throw new AuthzConfigError(`${where}: the resolved Configuration has no get()`);
    const get = (path: string[]): unknown => configuration.get(path);
    const cfg = readAdminConfig(get(['authz', 'admin']), where);

    if (cfg.guard === undefined) throw new AuthzConfigError(`${where}: authz.admin.guard.service is not set; AuthzAdmin refuses every call until it names a registered AdminGuard class`);
    const guard = await this.named(AdminGuard, cfg.guard, 'authz.admin.guard.service', where);
    if (!isObject(guard) || typeof guard.check !== 'function') throw new AuthzConfigError(`${where}: authz.admin.guard.service resolved to ${q(guard)}, which has no check()`);
    const backend = await this.named(AuthzAdminBackend, cfg.backend, 'authz.admin.backend', where);
    if (!isObject(backend) || typeof backend.transaction !== 'function') throw new AuthzConfigError(`${where}: authz.admin.backend resolved to ${q(backend)}, which has no transaction()`);
    const clock = (await c.resolve(AuthzClock)) as AuthzClock;
    if (!isObject(clock) || typeof clock.now !== 'function') throw new AuthzConfigError(`${where}: the resolved AuthzClock has no now()`);

    // The bus and audit the domain's AuthzService picked at boot, chosen the same way.
    const domains: unknown = await c.resolve(AuthzDomains);
    if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError(`${where}: AuthzAdmin needs DefaultAuthzDomains as the AuthzDomains singleton`);
    const domainCfg = readDomainConfig(get(['authz']), domains.lineage(domain));
    const bus = await this.pick(ChangeBus, domainCfg.bus.service, 'authz.bus.service', where);
    const audit = await this.pick(DecisionAudit, domainCfg.audit.service, 'authz.audit.service', where);

    return { where, domain, service, cfg, guard, backend, clock, bus, audit };
  }

  private async handlers(where: string): Promise<ReadonlyMap<string, AuthzWriteHandler>> {
    const map = new Map<string, AuthzWriteHandler>();
    for (const h of await this.chain(AuthzWriteHandler)) {
      if (!isObject(h) || !Array.isArray(h.kinds) || typeof h.validate !== 'function' || typeof h.permission !== 'function' || typeof h.apply !== 'function') {
        throw new AuthzConfigError(`${where}: ${className(h)} is not an AuthzWriteHandler (kinds, validate, permission, apply)`);
      }
      for (const kind of h.kinds) {
        const other = map.get(kind);
        if (other !== undefined && other !== h) throw new AuthzConfigError(`${where}: two AuthzWriteHandlers claim command kind ${q(kind)}: ${className(other)} and ${className(h)}`);
        map.set(kind, h);
      }
    }
    return map;
  }

  private async chain<T>(token: Class<T>): Promise<T[]> {
    if (!this.container.hasRegistered(token)) return [];
    return [...(await this.container.resolve(Array.chainOf(token)))];
  }

  /** The class named `service` among the registrations of `token`; a missing one is an AuthzConfigError naming `key`. */
  private async named<T>(token: Class<T>, service: string, key: string, where: string): Promise<T> {
    // Factories have no usable name.
    const entry = this.container.Registry.getTypesChain(token)
      .filter((e) => !isFactory(e.type) && typeName(e.type) === service)
      .pop();
    if (!entry) throw new AuthzConfigError(`${where}: ${key} names ${q(service)}, but no ${token.name} class of that name is registered`);
    const type = entry.type as Class<T>;
    // Resolved where Array.chainOf would: per-child classes here, the rest in the registering container.
    const at = this.container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? this.container : entry.container;
    return (await at.resolve(type)) as T;
  }

  /** DefaultAuthzService.pick: the class named by `service`, else the last registration; undefined when none. */
  private async pick<T>(token: Class<T>, service: string | undefined, key: string, where: string): Promise<T | undefined> {
    if (service !== undefined) return this.named(token, service, key, where);
    if (!this.container.hasRegistered(token)) return undefined;
    return (await this.container.resolve(token)) as T;
  }
}

function readOptions(opts: unknown): { readonly reason?: string; readonly idempotencyKey?: string; readonly dryRun: boolean } {
  if (opts === undefined || opts === null) return { dryRun: false };
  if (!isObject(opts)) throw new AuthzAdminFailure('invalid_batch', `options must be an object, got ${q(opts)}`);
  const { reason, idempotencyKey, dryRun } = opts;
  if (reason !== undefined && typeof reason !== 'string') throw new AuthzAdminFailure('invalid_batch', 'reason must be a string', 'reason');
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey === '')) throw new AuthzAdminFailure('invalid_batch', 'idempotencyKey must be a non-empty string', 'idempotencyKey');
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new AuthzAdminFailure('invalid_batch', 'dryRun must be a boolean', 'dryRun');
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    dryRun: dryRun === true,
  };
}

function appliedOf(out: unknown, kind: string, where: string): Applied {
  const bad = (what: string): never => {
    throw new AuthzConfigError(`${where}: the handler of ${q(kind)} returned ${what} from apply()`);
  };
  if (!isObject(out)) return bad(q(out));
  if (typeof out.affected !== 'number' || !Number.isInteger(out.affected) || out.affected < 0) bad(`affected ${q(out.affected)}`);
  if (!Array.isArray(out.tags) || !out.tags.every((t) => typeof t === 'string')) bad('tags that are not an array of strings');
  if (!Array.isArray(out.events) || !out.events.every((e) => isObject(e) && typeof e.type === 'string' && isObject(e.data))) bad('events without a type and a data object');
  if (out.id !== undefined && typeof out.id !== 'string') bad(`id ${q(out.id)}`);
  if (out.token !== undefined && typeof out.token !== 'string') bad('a token that is not a string');
  if (out.row !== undefined && !isObject(out.row)) bad(`row ${q(out.row)}`);
  return out as unknown as Applied;
}

function assertActor(actor: unknown, where: string, what: string): asserts actor is Principal {
  if (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string') throw new AuthzConfigError(`${where}: AuthzAdmin.${what} needs a principal as the actor, got ${q(actor)}`);
}

const QUERY_KINDS: ReadonlySet<string> = new Set<AuthzAdminQuery['kind']>(['assignments', 'links', 'rules', 'policies', 'attributes']);
const DEFAULT_PAGE = Object.freeze({ limit: 50, offset: 0 });

function copyOf(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch (e) {
    throw new AuthzAdminFailure('invalid_query', `a query must be plain data: ${describeError(e)}`);
  }
}
const MAX_LIMIT = 500;

/** A copy of the query with its page normalised; malformed input is an AuthzAdminFailure('invalid_query'). */
function readQuery(query: unknown): AuthzAdminQuery {
  const bad = (message: string, field?: string): never => {
    throw new AuthzAdminFailure('invalid_query', message, field);
  };
  if (!isObject(query)) return bad(`a query must be an object, got ${q(query)}`);
  const kind = query.kind;
  if (typeof kind !== 'string' || !QUERY_KINDS.has(kind)) return bad(`a query needs a kind of ${[...QUERY_KINDS].join(', ')}, got ${q(kind)}`, 'kind');
  const scope = query.scope;
  if (scope !== undefined && (!isObject(scope) || typeof scope.type !== 'string' || (scope.id !== undefined && typeof scope.id !== 'string'))) bad(`scope must be a resource ref, got ${q(scope)}`, 'scope');
  if (kind === 'attributes') {
    if (scope === undefined) bad('an attributes query needs a scope', 'scope');
    return { kind, scope: copyOf(scope) } as AuthzAdminQuery;
  }
  let page: { limit: number; offset: number } = { ...DEFAULT_PAGE };
  if (query.page !== undefined) {
    const p = query.page;
    if (!isObject(p)) return bad(`page must be { limit, offset }, got ${q(p)}`, 'page');
    const limit = p.limit ?? DEFAULT_PAGE.limit;
    const offset = p.offset ?? DEFAULT_PAGE.offset;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) bad(`page.limit must be an integer >= 1, got ${q(limit)}`, 'page.limit');
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) bad(`page.offset must be an integer >= 0, got ${q(offset)}`, 'page.offset');
    page = { limit: Math.min(limit as number, MAX_LIMIT), offset: offset as number };
  }
  return { ...(copyOf(query) as object), page } as unknown as AuthzAdminQuery;
}

function okResult(kind: AuthzCommand['kind'], a: Applied): OkResult {
  return { ok: true, kind, ...(a.id === undefined ? {} : { id: a.id }), ...(a.token === undefined ? {} : { token: a.token }), affected: a.affected };
}

function withoutToken(r: OkResult): OkResult {
  const { token: _token, ...rest } = r;
  return rest;
}

function failedAt(list: readonly AuthzCommand[], index: number, e: AuthzAdminFailure): AuthzCommandResult[] {
  const out: AuthzCommandResult[] = list.slice(0, index).map((c) => ({ ok: true, kind: c.kind, affected: 0 }));
  out.push({ ok: false, kind: kindOf(list[index]), error: { code: e.code, message: e.message, ...(e.field === undefined ? {} : { field: e.field }) } });
  return out;
}

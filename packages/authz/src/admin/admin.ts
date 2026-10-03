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
import { resourceKey } from '../contracts/resource.js';
import { AuthzDomains, AuthzService, ChangeBus, DecisionAudit } from '../contracts/service.js';
import { readDomainConfig } from '../host/config/domain-config.js';
import { AuthzClock } from '../host/clock.js';
import { DefaultAuthzDomains } from '../host/domains.js';
import { engineLog } from '../host/log.js';
import { AuthzAdminBackend } from './backend.js';
import { mapPermission, readAdminConfig } from './config.js';
import type { AdminConfig } from './config.js';
import type { AdminCallContext } from './context.js';
// The default AuthzEventSink registration.
import './sink.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SECRET_KEY = /token|secret|password/i;

type Applied = { readonly id?: string; readonly token?: string; readonly affected: number; readonly tags: readonly string[]; readonly events: readonly AuthzEvent[] };
type Checked = { readonly handler: AuthzWriteHandler; readonly permission: Permission; readonly resource: ResourceRef };
type OkResult = Extract<AuthzCommandResult, { ok: true }>;

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
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
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
    const env = await this.env();
    if (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string') throw new AuthzConfigError(`${env.where}: AuthzAdmin.execute needs a principal as the actor, got ${q(actor)}`);
    if (!Array.isArray(commands)) throw new AuthzAdminFailure('invalid_batch', 'commands must be an array');
    if (commands.length > env.cfg.maxBatch) throw new AuthzAdminFailure('invalid_batch', `a batch holds at most ${env.cfg.maxBatch} commands (authz.admin.maxBatch), got ${commands.length}`);
    const options = readOptions(opts);
    if (commands.length === 0) return [];
    const list: readonly AuthzCommand[] = [...commands];

    const now = env.clock.now();
    const ctx: AdminCallContext = Object.freeze({
      domain: env.domain,
      now,
      authz: env.service,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      actor,
      container: this.container,
      dryRun: options.dryRun,
    });
    const actorKey = principalKey(actor);
    const key = options.dryRun ? undefined : options.idempotencyKey;
    if (key !== undefined) {
      const stored = await env.backend.recall(env.domain, actorKey, key, now);
      if (stored !== undefined) return structuredClone(stored);
    }

    // Phase A, outside the transaction: validate, app validators, permission check.
    const handlers = await this.handlers(env.where);
    const validators = await this.chain(AuthzCommandValidator);
    const checked: Checked[] = [];
    for (const [i, c] of list.entries()) {
      try {
        checked.push(await this.check(env, handlers, validators, actor, c, ctx));
      } catch (e) {
        if (e instanceof AuthzAdminFailure) return failedAt(list, i, e);
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
            applied.push(appliedOf(await checked[i].handler.apply(c, ctx, tx), c.kind, env.where));
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
        if (key !== undefined && (await env.backend.remember(env.domain, actorKey, key, results.map(withoutToken), new Date(now.getTime() + IDEMPOTENCY_TTL_MS), tx)) === 'exists') {
          state.raced = true;
          throw rollback;
        }
        state.results = results;
        state.applied = applied;
        if (options.dryRun) throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }

    if (state.failure) return failedAt(list, state.failure.index, state.failure.error);
    if (state.raced) {
      const stored = await env.backend.recall(env.domain, actorKey, key!, now);
      if (stored === undefined) throw new AuthzConfigError(`${env.where}: idempotency key ${q(key)} was taken by another batch whose results the backend no longer holds`);
      return structuredClone(stored);
    }
    const results = state.results!;
    if (!options.dryRun) await this.afterCommit(env, actor, list, checked, state.applied!, ctx);
    return results;
  }

  assign(_actor: Principal, _a: Omit<Extract<AuthzCommand, { kind: 'assignment.grant' }>, 'kind'>, _opts?: AuthzAdminOptions): Promise<Assignment> {
    return notYet();
  }

  revoke(_actor: Principal, _id: string, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  createLink(_actor: Principal, _l: Omit<Extract<AuthzCommand, { kind: 'link.create' }>, 'kind'>, _opts?: AuthzAdminOptions): Promise<{ link: LinkDef; token: string }> {
    return notYet();
  }

  revokeLink(_actor: Principal, _id: string, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  setTags(_actor: Principal, _assignmentId: string, _tags: readonly string[], _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  putRule(_actor: Principal, _rule: Omit<RuleDef, 'source'>, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  deleteRule(_actor: Principal, _id: string, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  putPolicy(_actor: Principal, _policy: Omit<Policy, 'source'>, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  deletePolicy(_actor: Principal, _id: string, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  setScopeAttributes(_actor: Principal, _scope: ResourceRef, _patch: Readonly<Record<string, unknown>>, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  forgetScope(_actor: Principal, _scope: ResourceRef, _opts?: AuthzAdminOptions): Promise<void> {
    return notYet();
  }

  list(_actor: Principal, _q: AuthzAdminQuery): Promise<{ items: readonly unknown[]; total: number }> {
    return notYet();
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
    const d = await env.service.check({ principal: actor, permission, resource });
    // A conditional allow is a refusal: a command has no row to evaluate the residual against.
    if (!d.allowed || d.residual?.op !== 'true') {
      const why = d.allowed ? 'only conditionally' : d.reason?.code ?? 'denied';
      throw new AuthzAdminFailure('forbidden', `${principalKey(actor)} may not ${permission} on ${resourceKey(resource)} (${why})`);
    }
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

    const events = deepFreeze(applied.flatMap((a) => a.events).map((e): AuthzEvent => ({ type: e.type, domain: env.domain, actor: { ...actorRef }, at: new Date(ctx.now.getTime()), data: redact(e.data) })));
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
    const domainCfg = readDomainConfig(get, domains.lineage(domain));
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
    return [...(await this.container.resolveChain(token))];
  }

  /** The class named `service` among the registrations of `token`; a missing one is an AuthzConfigError naming `key`. */
  private async named<T>(token: Class<T>, service: string, key: string, where: string): Promise<T> {
    // Factories have no usable name.
    const entry = this.container.Registry.getTypesChain(token)
      .filter((e) => !isFactory(e.type) && typeName(e.type) === service)
      .pop();
    if (!entry) throw new AuthzConfigError(`${where}: ${key} names ${q(service)}, but no ${token.name} class of that name is registered`);
    const type = entry.type as Class<T>;
    // Resolved where resolveChain would: per-child classes here, the rest in the registering container.
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

function notYet(): Promise<never> {
  return Promise.reject(new Error('not implemented yet (L9 task 2)'));
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
  return out as unknown as Applied;
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

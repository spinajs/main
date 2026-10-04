import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';

import { AuthzConfigError, AuthzDomains, SYSTEM, currentPrincipal, engineLog, principalKey, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { fs } from '@spinajs/fs';

import { fsAccessConfig } from '../config/index.js';
import type { FsAccessConfig } from '../config/index.js';
import { effectiveFsOperations } from '../operations/index.js';
import type { FsOperation, FsPathSpec } from '../operations/index.js';
import { normalizeFsPath } from '../refs/index.js';
import type { FsPathKind } from '../refs/index.js';

/** The part of AuthzService the guard calls. */
export interface FsGuardService {
  check(req: CheckInput): Promise<Decision>;
  assert(principal: Principal, permission: Permission, resource?: ResourceRef | object): Promise<Decision>;
}

export interface FsGuardLog {
  warn(message: string): void;
}

export interface FsGuardOptions {
  /** Default: `authz.fs.<fsName>` of the Configuration in `container`. */
  readonly config?: FsAccessConfig;
  /** Where the Configuration (also of destination filesystems) and AuthzDomains are resolved; default the root. */
  readonly container?: IContainer;
  /** The service that decides for a domain; default `AuthzDomains.service(domain)`. */
  readonly service?: (domain: string) => Promise<FsGuardService>;
  /** Default: the ALS principal, else UNATTENDED (what AuthzService.current() returns). */
  readonly principal?: () => Principal;
  readonly log?: FsGuardLog;
}

interface Env {
  readonly container: IContainer;
  readonly principal: () => Principal;
  readonly log: FsGuardLog;
  service(domain: string): Promise<FsGuardService>;
}

interface Guard {
  readonly name: string;
  readonly raw: fs;
  readonly config: FsAccessConfig;
  readonly operations: Readonly<Record<string, FsOperation>>;
  readonly env: Env;
  service(): Promise<FsGuardService>;
}

interface Need {
  readonly guard: Guard;
  readonly permission: Permission;
  readonly ref: ResourceRef;
}

/**
 * Open while an authorised operation runs: guarded calls the provider makes inside it (a guarded dstFs, an fsTemp
 * backend) pass unchecked. It closes when the operation settles, because callbacks of streams the operation
 * created run later in its async context and must be checked again.
 */
interface Frame {
  active: boolean;
}

const operationFrame = new AsyncLocalStorage<Frame>();
const guards = new WeakMap<object, Guard>();

// Pure or DI lifecycle (design §13); non-function properties and symbols pass through as well.
const UNCHECKED = new Set(['resolvePath', 'tmppath', 'tmpname', 'resolve', 'dispose', '__checkInstance__']);

const inOperation = (): boolean => operationFrame.getStore()?.active === true;

/**
 * A Proxy over the raw provider (design §13): every method of the operation table checks its paths before the
 * raw method runs on the raw instance, with the normalised paths it checked. `instanceof` and `Options.basePath`
 * keep working. Mode 'off' returns `raw`.
 */
export function guardFs<T extends fs>(raw: T, fsName: string, opts: FsGuardOptions = {}): T {
  const container = opts.container ?? DI.RootContainer;
  const config = opts.config ?? fsAccessConfig(fsName, container);
  if (config.mode === 'off') return raw;

  const env: Env = {
    container,
    principal: opts.principal ?? currentPrincipal,
    log: opts.log ?? engineLog('authz-fs'),
    service: opts.service ?? (async (domain) => ((await container.resolve(AuthzDomains)) as AuthzDomains).service(domain)),
  };
  const guard = makeGuard(fsName, raw, config, env);
  const wrappers = new Map<string, { readonly fn: unknown; readonly wrapper: unknown }>();

  // The target is an empty stand-in, not `raw`: a Proxy must return a non-configurable, non-writable own property
  // of its target unchanged, so such a method (or any method of a frozen instance) could not be guarded.
  const shadow = Object.create(Object.getPrototypeOf(raw) as object | null) as T;
  const proxy = new Proxy(shadow, {
    get(_shadow, prop) {
      const value: unknown = Reflect.get(raw, prop, raw);
      if (typeof prop === 'symbol' || typeof value !== 'function') return value;
      const cached = wrappers.get(prop);
      if (cached?.fn === value) return cached.wrapper;
      const wrapper = wrap(guard, prop, value as (...args: unknown[]) => unknown);
      wrappers.set(prop, { fn: value, wrapper });
      return wrapper;
    },
    set: (_shadow, prop, value) => Reflect.set(raw, prop, value, raw),
    has: (_shadow, prop) => Reflect.has(raw, prop),
    ownKeys: () => Reflect.ownKeys(raw),
    getOwnPropertyDescriptor(_shadow, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, prop);
      return descriptor && { ...descriptor, configurable: true };
    },
    defineProperty: (_shadow, prop, descriptor) => Reflect.defineProperty(raw, prop, descriptor),
    deleteProperty: (_shadow, prop) => Reflect.deleteProperty(raw, prop),
    getPrototypeOf: () => Reflect.getPrototypeOf(raw),
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  guards.set(proxy, guard);
  return proxy;
}

export function isGuardedFs(value: unknown): boolean {
  return value !== null && typeof value === 'object' && guards.has(value);
}

function makeGuard(name: string, raw: fs, config: FsAccessConfig, env: Env): Guard {
  if (typeof name !== 'string' || name === '' || name.includes(':')) {
    throw new InvalidArgument(`fs name must be a non-empty string without ':', got ${JSON.stringify(name)}`, 'fsName');
  }
  let pending: Promise<FsGuardService> | undefined;
  return {
    name,
    raw,
    config,
    operations: effectiveFsOperations(config),
    env,
    service() {
      pending ??= env.service(config.domain).catch((e: unknown) => {
        pending = undefined;
        throw e;
      });
      return pending;
    },
  };
}

function wrap(guard: Guard, method: string, fn: (...args: unknown[]) => unknown): unknown {
  const operation = guard.operations[method];
  if (operation) {
    return function (this: unknown, ...args: unknown[]) {
      if (inOperation()) return Reflect.apply(fn, guard.raw, args);
      return runOperation(guard, method, operation, fn, args);
    };
  }
  if (method === 'constructor') return fn;
  if (UNCHECKED.has(method) || method in Object.prototype) {
    return function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(fn, guard.raw, args);
    };
  }
  return function (this: unknown, ...args: unknown[]) {
    if (!inOperation()) refuse(guard, guard.env.principal(), `${method} is not in the operation table; map it in authz.fs.${guard.name}.operations`);
    return Reflect.apply(fn, guard.raw, args);
  };
}

async function runOperation(guard: Guard, method: string, operation: FsOperation, fn: (...args: unknown[]) => unknown, args: unknown[]): Promise<unknown> {
  const plan = planCall(guard, operation, args);
  const principal = guard.env.principal();
  if (plan.unknownDestination) refuse(guard, principal, `${method} names a destination path without a destination filesystem (dstFs), so its destination cannot be checked`);
  for (const need of plan.needs) await decide(need, principal);

  const frame: Frame = { active: true };
  let result: unknown;
  try {
    result = await operationFrame.run(frame, () => Reflect.apply(fn, guard.raw, plan.args));
  } finally {
    frame.active = false;
  }

  if (method === 'list' && guard.config.list === 'each' && Array.isArray(result)) return statEach(guard, principal, plan.args[0] as string, result);
  return result;
}

/** enforce: AuthzConfigError unless SYSTEM; audit: a warning. */
function refuse(guard: Guard, principal: Principal, problem: string): void {
  if (principal === SYSTEM) return;
  const message = `authz.fs.${guard.name}: ${problem}`;
  if (guard.config.mode === 'enforce') throw new AuthzConfigError(message);
  guard.env.log.warn(`${message}; allowed in audit mode`);
}

/** One normalizeFsPath result per path argument feeds both the checked ref and the argument the raw method gets. */
function planCall(guard: Guard, operation: FsOperation, args: readonly unknown[]): { args: unknown[]; needs: Need[]; unknownDestination: boolean } {
  const out = [...args];
  const needs: Need[] = [];
  let unknownDestination = false;

  // null: a destination with mode 'off'; undefined: a temp filesystem the provider picks.
  let destination: Guard | null | undefined = guard;
  if (operation.dstFs) {
    const named = args[operation.dstFs.arg];
    destination = named !== undefined && named !== null ? guardOf(named, guard.env) : operation.dstFs.absent === 'self' ? guard : undefined;
  }

  for (const spec of operation.paths) {
    const target = spec.onDestination ? destination : guard;
    if (target === undefined) {
      if (args[spec.arg] !== undefined && args[spec.arg] !== null) unknownDestination = true;
      continue;
    }
    if (target === null) continue;

    const at = (path: unknown): string => {
      const normalised = normalizeFsPath(path as string, basePathOf(target.raw));
      for (const permission of spec.permissions) needs.push({ guard: target, permission, ref: refOf(target.name, normalised, spec.kind) });
      return normalised;
    };
    const value = args[spec.arg] === undefined && spec.default ? defaultName(spec.default, args, target) : args[spec.arg];
    out[spec.arg] = spec.sources && Array.isArray(value) ? value.map((entry: unknown) => (Array.isArray(entry) ? [at(entry[0]), ...entry.slice(1)] : at(entry))) : at(value);
  }
  return { args: out, needs, unknownDestination };
}

function defaultName(spec: NonNullable<FsPathSpec['default']>, args: readonly unknown[], target: Guard): string | undefined {
  if ('basenameOf' in spec) {
    const source = args[spec.basenameOf];
    return typeof source === 'string' ? basename(source) : undefined;
  }
  return target.raw.tmpname(spec.tmpname === '' ? undefined : spec.tmpname);
}

/** The guard of a filesystem passed as an argument: its own when guarded, else one built from its config (null when off). */
function guardOf(value: unknown, env: Env): Guard | null {
  if (value === null || typeof value !== 'object') throw new InvalidArgument('dstFs must be a filesystem', 'dstFs');
  const known = guards.get(value);
  if (known) return known;
  const name: unknown = (value as { Name?: unknown }).Name;
  if (typeof name !== 'string') throw new InvalidArgument('dstFs must be a filesystem with a Name', 'dstFs');
  const config = fsAccessConfig(name, env.container);
  return config.mode === 'off' ? null : makeGuard(name, value as fs, config, env);
}

async function decide({ guard, permission, ref }: Need, principal: Principal): Promise<void> {
  const service = await guard.service();
  if (guard.config.mode === 'enforce') {
    await service.assert(principal, permission, ref);
    return;
  }
  const decision = await service.check({ principal, permission, resource: ref });
  if (!decision.allowed) warnDenied(guard, principal, permission, ref, decision);
}

async function statEach(guard: Guard, principal: Principal, dir: string, entries: unknown[]): Promise<unknown[]> {
  const service = await guard.service();
  const enforce = guard.config.mode === 'enforce';
  const keep = await Promise.all(
    entries.map(async (entry) => {
      let ref: ResourceRef;
      try {
        // Local providers list names inside the dir, S3 lists whole keys.
        const path = typeof entry === 'string' && dir !== '' && !entry.includes('/') ? `${dir}/${entry}` : entry;
        ref = refOf(guard.name, normalizeFsPath(path as string, basePathOf(guard.raw)), 'file');
      } catch {
        return !enforce;
      }
      const decision = await service.check({ principal, permission: 'fs:stat', resource: ref });
      if (!decision.allowed && !enforce) warnDenied(guard, principal, 'fs:stat', ref, decision);
      return decision.allowed || !enforce;
    }),
  );
  return entries.filter((_, i) => keep[i]);
}

function warnDenied(guard: Guard, principal: Principal, permission: Permission, ref: ResourceRef, decision: Decision): void {
  guard.env.log.warn(`authz.fs.${guard.name}: ${principalKey(principal)} lacks ${permission} on ${resourceKey(ref)}${decision.reason ? ` (${decision.reason.code})` : ''}; allowed in audit mode`);
}

const refOf = (fsName: string, normalised: string, kind: FsPathKind): ResourceRef => (normalised === '' ? { type: 'fs', id: fsName } : { type: kind, id: `${fsName}:${normalised}` });

function basePathOf(raw: fs): string | undefined {
  const basePath: unknown = (raw as { Options?: { basePath?: unknown } }).Options?.basePath;
  return typeof basePath === 'string' && basePath !== '' ? basePath : undefined;
}

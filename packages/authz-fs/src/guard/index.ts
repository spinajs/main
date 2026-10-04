import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';

import { AccessDenied, AuthzConfigError, AuthzDomains, FALSE, SYSTEM, currentPrincipal, engineLog, principalKey, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { fsNative, fsTemp } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';

import { fsAccessConfig } from '../config/index.js';
import type { FsAccessConfig } from '../config/index.js';
import { FS_UNCHECKED_METHODS, effectiveFsOperations } from '../operations/index.js';
import type { FsOperation, FsPathSpec } from '../operations/index.js';
import { fsRowOf, normalizeFsPath } from '../refs/index.js';
import type { FsPathKind, FsRow } from '../refs/index.js';

/** The part of AuthzService the guard calls. */
export interface FsGuardService {
  check(req: CheckInput): Promise<Decision>;
  assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision>;
}

export interface FsGuardLog {
  warn(message: string): void;
}

export interface FsGuardOptions {
  /** Default: `authz.fs.<fsName>` of the Configuration in `container`. */
  readonly config?: FsAccessConfig;
  /** Where the Configuration (also of destination filesystems), the published providers and AuthzDomains are resolved; default the root. */
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
  readonly subject: FsRow;
}

interface Plan {
  readonly args: unknown[];
  readonly needs: Need[];
  /** Normalised path per argument index. */
  readonly paths: ReadonlyMap<number, string>;
  readonly unknownDestination: boolean;
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

  const member = (prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(raw, prop, raw);
    if (typeof prop === 'symbol' || typeof value !== 'function') return value;
    const cached = wrappers.get(prop);
    if (cached?.fn === value) return cached.wrapper;
    const wrapper = wrap(guard, prop, value as (...args: unknown[]) => unknown);
    wrappers.set(prop, { fn: value, wrapper });
    return wrapper;
  };

  // The target is an empty stand-in, not `raw`: a Proxy must return a non-configurable, non-writable own property
  // of its target unchanged, so such a method (or any method of a frozen instance) could not be guarded.
  const shadow = Object.create(Object.getPrototypeOf(raw) as object | null) as T;
  const proxy = new Proxy(shadow, {
    get: (_shadow, prop) => member(prop),
    set: (_shadow, prop, value) => Reflect.set(raw, prop, value, raw),
    has: (_shadow, prop) => Reflect.has(raw, prop),
    ownKeys: () => Reflect.ownKeys(raw),
    getOwnPropertyDescriptor(_shadow, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, prop);
      if (!descriptor) return undefined;
      return 'value' in descriptor ? { ...descriptor, value: member(prop), configurable: true } : { ...descriptor, configurable: true };
    },
    // The stand-in cannot hold a non-configurable property, so defining one would break a Proxy invariant after raw changed.
    defineProperty: (_shadow, prop, descriptor) => descriptor.configurable !== false && Reflect.defineProperty(raw, prop, descriptor),
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
    operations: effectiveFsOperations(config, name),
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
  // A provider method that only shares a name with an Object.prototype member is not exempt.
  if (FS_UNCHECKED_METHODS.has(method) || (method in Object.prototype && fn === (Object.prototype as Record<string, unknown>)[method])) {
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
  const plan = planCall(guard, method, operation, args);
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

  if (method === 'list' && guard.config.list === 'each' && Array.isArray(result)) return statEach(guard, principal, plan.paths.get(0) ?? '', result);
  return result;
}

/** enforce: AuthzConfigError unless SYSTEM; audit: a warning. */
function refuse(guard: Guard, principal: Principal, problem: string): void {
  if (principal === SYSTEM) return;
  const message = `authz.fs.${guard.name}: ${problem}`;
  if (guard.config.mode === 'enforce') throw new AuthzConfigError(message);
  guard.env.log.warn(`${message}; allowed in audit mode`);
}

/** One normalizeFsPath result per path argument feeds the checked ref, the subject row and the argument the raw method gets. */
function planCall(guard: Guard, method: string, operation: FsOperation, args: readonly unknown[]): Plan {
  const out = [...args];
  const needs: Need[] = [];
  const paths = new Map<number, string>();
  let unknownDestination = false;

  // null: a destination with mode 'off'; undefined: a destination the guard cannot place.
  let destination: Guard | null | undefined = guard;
  if (operation.dstFs) {
    const { arg, absent } = operation.dstFs;
    const named = args[arg];
    if (named !== undefined && named !== null) {
      destination = guardOf(named, guard.env);
    } else if (absent === 'self') {
      destination = guard;
    } else {
      const fallback = providerDestination(guard, method);
      if (fallback === 'self') {
        destination = guard;
      } else if (fallback !== undefined) {
        destination = guardOf(fallback, guard.env);
        // Passed explicitly, so the filesystem checked is the one written to.
        out[arg] = fallback;
      } else {
        destination = undefined;
      }
    }
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
      const ref = refOf(target.name, normalised, spec.kind);
      const subject = fsRowOf(target.name, normalised, spec.kind);
      for (const permission of spec.permissions) needs.push({ guard: target, permission, ref, subject });
      return normalised;
    };
    const value = args[spec.arg] === undefined && spec.default ? defaultName(spec.default, args, target) : args[spec.arg];
    if (spec.sources && Array.isArray(value)) {
      out[spec.arg] = value.map((entry: unknown) => (Array.isArray(entry) ? [at(entry[0]), ...entry.slice(1)] : at(entry)));
      continue;
    }
    const normalised = at(value);
    paths.set(spec.arg, normalised);
    out[spec.arg] = spec.dirSlash && normalised !== '' ? `${normalised}/` : normalised;
  }
  return { args: out, needs, paths, unknownDestination };
}

/**
 * Where zip and unzip write when dstFs is absent, as the providers of `@spinajs/fs` do it: fsTemp into itself,
 * fsNative unzip into itself and fsNative zip into the published 'fs-temp'. Undefined for other providers (S3
 * uses its own temp filesystem, FTP and unknown providers are not known to the guard).
 */
function providerDestination(guard: Guard, method: string): 'self' | object | undefined {
  const raw = guard.raw;
  if (raw instanceof fsTemp) return 'self';
  if (!(raw instanceof fsNative)) return undefined;
  if (method === 'unzip') return 'self';
  const published: unknown = guard.env.container.get('__file_provider_instance__');
  const temp: unknown = published instanceof Map ? published.get('fs-temp') : undefined;
  return temp !== null && typeof temp === 'object' ? temp : undefined;
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

// A permit with a residual left (a relation or a resource.* condition the subject did not settle) is no permit here.
const definite = (decision: Decision): boolean => decision.allowed && decision.residual?.op === 'true';

async function decide({ guard, permission, ref, subject }: Need, principal: Principal): Promise<void> {
  const service = await guard.service();
  if (guard.config.mode === 'enforce') {
    const decision = await service.assert(principal, permission, ref, subject);
    if (!definite(decision)) throw new AccessDenied(conditional(decision));
    return;
  }
  const decision = await service.check({ principal, permission, resource: ref, subject });
  if (!definite(decision)) warnDenied(guard, principal, permission, ref, decision);
}

function conditional(decision: Decision): Decision {
  return { ...decision, allowed: false, residual: FALSE, reason: { code: 'needs_subject' } };
}

async function statEach(guard: Guard, principal: Principal, dir: string, entries: unknown[]): Promise<unknown[]> {
  const service = await guard.service();
  const enforce = guard.config.mode === 'enforce';
  const keep = await Promise.all(
    entries.map(async (entry) => {
      let normalised: string;
      try {
        // Local providers list names inside the dir, S3 lists whole keys.
        const path = typeof entry === 'string' && dir !== '' && !entry.includes('/') ? `${dir}/${entry}` : entry;
        normalised = normalizeFsPath(path as string, basePathOf(guard.raw));
      } catch {
        return !enforce;
      }
      const ref = refOf(guard.name, normalised, 'file');
      const decision = await service.check({ principal, permission: 'fs:stat', resource: ref, subject: fsRowOf(guard.name, normalised, 'file') });
      if (definite(decision)) return true;
      if (!enforce) warnDenied(guard, principal, 'fs:stat', ref, decision);
      return !enforce;
    }),
  );
  return entries.filter((_, i) => keep[i]);
}

function warnDenied(guard: Guard, principal: Principal, permission: Permission, ref: ResourceRef, decision: Decision): void {
  const why = decision.allowed ? 'conditional' : decision.reason?.code;
  guard.env.log.warn(`authz.fs.${guard.name}: ${principalKey(principal)} lacks ${permission} on ${resourceKey(ref)}${why ? ` (${why})` : ''}; allowed in audit mode`);
}

const refOf = (fsName: string, normalised: string, kind: FsPathKind): ResourceRef => (normalised === '' ? { type: 'fs', id: fsName } : { type: kind, id: `${fsName}:${normalised}` });

function basePathOf(raw: fs): string | undefined {
  const basePath: unknown = (raw as { Options?: { basePath?: unknown } }).Options?.basePath;
  return typeof basePath === 'string' && basePath !== '' ? basePath : undefined;
}

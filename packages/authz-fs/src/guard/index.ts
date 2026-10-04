import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';

import { AuthzConfigError, SYSTEM, UNATTENDED, currentPrincipal, engineLog } from '@spinajs/authz';
import type { Decision, Permission, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { fsNative, fsTemp } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';

import type { FileMetadataStore } from '../api.js';
import { fsAccessConfig } from '../access-config/index.js';
import type { FsAccessConfig } from '../access-config/index.js';
import { FS_UNCHECKED_METHODS, effectiveFsOperations } from '../operations/index.js';
import type { FsOperation, FsPathSpec } from '../operations/index.js';
import { FS_NO_OWNER_TYPES } from '../metadata/meta.js';
import { fileMetadataStore } from '../metadata/select.js';
import { fsRowOf, normalizeFsPath } from '../refs/index.js';
import type { FsRow } from '../refs/index.js';
import { planMetadata } from './metadata.js';
import type { MetadataPath } from './metadata.js';
import { rememberRaw } from './raw.js';
import { basePathOf, decideFs, definite, domainNow, domainService, publishedFs, refOf, warnDenied } from './shared.js';
import type { FsGuardLog, FsGuardService } from './shared.js';
import { SIGNING_METHODS, askedUntil, signingCall, signingUntil } from './signed-url.js';

export type { FsGuardLog, FsGuardService } from './shared.js';

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
  /** How long a writeStream's 'close' waits for the metadata store; default 30 s. */
  readonly metadataTimeoutMs?: number;
  /** The time signed URL lifetimes count from; default the AuthzClock of the filesystem's domain, else the system time. */
  readonly now?: () => Date;
}

interface Env {
  readonly container: IContainer;
  readonly principal: () => Principal;
  readonly log: FsGuardLog;
  readonly metadataTimeoutMs: number;
  service(domain: string): Promise<FsGuardService>;
  now(domain: string): Promise<Date>;
}

interface Guard {
  readonly name: string;
  readonly raw: fs;
  readonly config: FsAccessConfig;
  readonly operations: Readonly<Record<string, FsOperation>>;
  readonly env: Env;
  readonly stampOwner: boolean;
  service(): Promise<FsGuardService>;
  /** The FileMetadataStore `authz.fs.<name>.metadata` names; resolved once, a failure is not kept. */
  metadata(): Promise<FileMetadataStore | undefined>;
}

interface Need {
  readonly arg: number;
  readonly guard: Guard;
  readonly permission: Permission;
  readonly ref: ResourceRef;
  readonly subject: FsRow;
}

interface Plan {
  readonly args: unknown[];
  readonly needs: Need[];
  /** The filesystem and normalised path per argument index (zip sources left out). */
  readonly paths: ReadonlyMap<number, { readonly guard: Guard; readonly path: string }>;
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
    metadataTimeoutMs: opts.metadataTimeoutMs ?? 30_000,
    service: opts.service ?? ((domain) => domainService(container, domain)),
    now: opts.now ? async () => opts.now!() : (domain) => domainNow(container, domain),
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
  rememberRaw(proxy, raw);
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
  let store: Promise<FileMetadataStore | undefined> | undefined;
  return {
    name,
    raw,
    config,
    operations: effectiveFsOperations(config, name),
    env,
    stampOwner: config.stampOwner === true,
    service() {
      pending ??= env.service(config.domain).catch((e: unknown) => {
        pending = undefined;
        throw e;
      });
      return pending;
    },
    metadata() {
      store ??= fileMetadataStore(name, env.container, config).catch((e: unknown) => {
        store = undefined;
        throw e;
      });
      return store;
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
  const signing = SIGNING_METHODS.has(method);
  const asked = signing ? askedUntil(method, plan.args) : undefined;
  const decisions: Decision[] = [];
  for (const need of plan.needs) decisions.push(await decide(need, principal));
  let call = { fn, args: plan.args };
  if (signing) {
    // D9 rev.: the URL never outlives the asked until (else the default lifetime), the TTL cap or the permit; audit mode narrows it too.
    const { maxTtlSeconds, defaultTtlSeconds } = guard.config.signedUrl ?? {};
    const now = await guard.env.now(guard.config.domain);
    const until = signingUntil({ asked, defaultTtlSeconds, maxTtlSeconds, now, decisions: decisions.filter((_, i) => plan.needs[i].arg === 0) });
    call = signingCall(guard.raw, method, fn, plan.args, until);
  }
  const metadataPath = (arg: number): MetadataPath | undefined => {
    const at = plan.paths.get(arg);
    // The filesystem root has no metadata.
    if (!at || at.path === '') return undefined;
    // Only a definite allow stamps: an audit-mode denial or a conditional answer must not leave owner rights behind.
    const decided = plan.needs.map((n, i) => (n.arg === arg && n.guard === at.guard ? decisions[i] : undefined)).filter((d): d is Decision => d !== undefined);
    const owner = decided.length > 0 && decided.every(definite) ? ownerOf(principal, decided[0]) : undefined;
    return { target: at.guard, path: at.path, owner };
  };
  const log = guard.env.log;
  const afterIo = await planMetadata(method, metadataPath, {
    error: (message) => (log.error ?? log.warn).call(log, `authz.fs.${guard.name}: ${message}`),
    warn: (message) => log.warn(`authz.fs.${guard.name}: ${message}`),
    timeoutMs: guard.env.metadataTimeoutMs,
  });

  const frame: Frame = { active: true };
  let result: unknown;
  try {
    result = await operationFrame.run(frame, () => Reflect.apply(call.fn, guard.raw, call.args));
  } finally {
    frame.active = false;
  }

  if (afterIo) result = await afterIo(result);
  if (method === 'list' && guard.config.list === 'each' && Array.isArray(result)) return statEach(guard, principal, plan.paths.get(0)?.path ?? '', result);
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
  const paths = new Map<number, { guard: Guard; path: string }>();
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
      for (const permission of spec.permissions) needs.push({ arg: spec.arg, guard: target, permission, ref, subject });
      return normalised;
    };
    const value = args[spec.arg] === undefined && spec.default ? defaultName(spec.default, args, target) : args[spec.arg];
    if (spec.sources && Array.isArray(value)) {
      out[spec.arg] = value.map((entry: unknown) => (Array.isArray(entry) ? [at(entry[0]), ...entry.slice(1)] : at(entry)));
      continue;
    }
    const normalised = at(value);
    paths.set(spec.arg, { guard: target, path: normalised });
    out[spec.arg] = spec.dirSlash && normalised !== '' ? `${normalised}/` : normalised;
  }
  return { args: out, needs, paths, unknownDestination };
}

/**
 * Where zip and unzip write when dstFs is absent, as the providers of `@spinajs/fs` do it: fsTemp into itself,
 * fsNative unzip into itself and fsNative zip into the published 'fs-temp'. Undefined for other providers (S3
 * uses its own temp filesystem, FTP and unknown providers are not known to the guard). Matched with instanceof, so
 * a subclass that overrides zip or unzip to write elsewhere is still checked where the base class writes.
 */
function providerDestination(guard: Guard, method: string): 'self' | object | undefined {
  const raw = guard.raw;
  if (raw instanceof fsTemp) return 'self';
  if (!(raw instanceof fsNative)) return undefined;
  if (method === 'unzip') return 'self';
  return publishedFs(guard.env.container, 'fs-temp');
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

async function decide({ guard, permission, ref, subject }: Need, principal: Principal): Promise<Decision> {
  const mode = guard.config.mode === 'enforce' ? 'enforce' : 'audit';
  return decideFs({ fsName: guard.name, mode, service: await guard.service(), log: guard.env.log, principal, permission, ref, subject });
}

/**
 * Who owns what an operation writes: the principal the decision ran for (under 'inherit' delegation the delegate,
 * as the owner relation is later evaluated for the delegate too), else the request principal. SYSTEM, UNATTENDED
 * and anonymous principals own nothing.
 */
function ownerOf(principal: Principal, decision: Decision | undefined): PrincipalRef | undefined {
  if (principal === SYSTEM || principal === UNATTENDED) return undefined;
  const ran: unknown = decision?.principal;
  const who = ran !== null && typeof ran === 'object' && typeof (ran as PrincipalRef).type === 'string' && typeof (ran as PrincipalRef).id === 'string' ? (ran as PrincipalRef) : principal;
  return FS_NO_OWNER_TYPES.has(who.type) || who.id === '' ? undefined : { type: who.type, id: who.id };
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
      if (!enforce) warnDenied(guard.name, guard.env.log, principal, 'fs:stat', ref, decision);
      return !enforce;
    }),
  );
  return entries.filter((_, i) => keep[i]);
}

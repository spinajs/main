import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';

import { AuthorizationModel, AuthzDomains, DefaultAuthzDomains, DefaultAuthzService, InProcessChangeBus, LogDecisionAudit, SystemClock } from '@spinajs/authz';
import { isPlainObject as isRecord } from '@spinajs/util';

import { TestLog, installTestLog } from './log.js';

type Path = string | readonly string[];

const segments = (path: Path): string[] => (Array.isArray(path) ? [...path] : (path as string).split('.').filter((s) => s !== ''));

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// `cur['__proto__']` is Object.prototype, which passes isRecord, so a write through it would pollute every object.
function writableSegments(path: Path): string[] {
  const segs = segments(path);
  const unsafe = segs.find((s) => UNSAFE_SEGMENTS.has(s));
  if (unsafe !== undefined) throw new Error(`TestConfiguration: path '${segs.join('.')}' contains the reserved segment '${unsafe}'`);
  return segs;
}

/** In-memory Configuration over a plain object; paths are dotted strings or segment arrays. */
export class TestConfiguration extends Configuration {
  private data: Record<string, unknown> = {};

  public get RootConfig(): IConfigLike {
    return this.data as IConfigLike;
  }

  public get<T>(path: string[] | string, defaultValue?: T): T {
    let cur: unknown = this.data;
    for (const seg of segments(path)) {
      if (!isRecord(cur) || !Object.hasOwn(cur, seg)) return defaultValue as T;
      cur = cur[seg];
    }
    return (cur === undefined ? defaultValue : cur) as T;
  }

  public set(path: string[] | string, value: unknown): void {
    const segs = writableSegments(path);
    if (segs.length === 0) {
      this.data = isRecord(value) ? value : {};
      return;
    }
    let cur = this.data;
    for (const seg of segs.slice(0, -1)) {
      if (!isRecord(cur[seg])) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]] = value;
  }

  public merge(path: string[] | string, value: unknown): void {
    const existing = this.get<unknown>(path);
    this.set(path, isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value);
  }

  public unset(path: Path): void {
    const segs = writableSegments(path);
    let cur: unknown = this.data;
    for (const seg of segs.slice(0, -1)) {
      if (!isRecord(cur)) return;
      cur = cur[seg];
    }
    if (isRecord(cur)) delete cur[segs[segs.length - 1]];
  }

  public reset(): void {
    this.data = {};
  }

  public async mergeSource(_source: Class<ConfigurationSource>): Promise<void> {}

  public async load(): Promise<void> {}

  protected onLoad(): unknown {
    return undefined;
  }
}

// Root types the host creates while tests run; only those not cached before setup are uncached.
const ROOT_CREATED: readonly Class<unknown>[] = [DefaultAuthzService, DefaultAuthzDomains, TestConfiguration, InProcessChangeBus, LogDecisionAudit, SystemClock, AsyncLocalStorage];

interface RootRegistration {
  readonly token: Class<unknown> | string;
  readonly factory: Factory<unknown> | Class<unknown>;
}

let installed: { cachedBefore: Set<Class<unknown>>; config: TestConfiguration; uninstallLog: () => void } | undefined;
const rootRegistrations: RootRegistration[] = [];

/** The installed TestConfiguration; throws before `installHost()`. */
export function config(): TestConfiguration {
  if (!installed) throw new Error('test host is not installed: call installHost() in a before hook');
  return installed.config;
}

/** Registers TestConfiguration in root (last, so it wins) and resolves it, and {@link TestLog} when no Log is registered. */
export async function installHost(): Promise<TestConfiguration> {
  if (installed) return installed.config;
  const root = DI.RootContainer;
  const cachedBefore = new Set(ROOT_CREATED.filter((t) => root.Cache.has(t)));
  const uninstallLog = installTestLog();
  DI.register(TestConfiguration).as(Configuration);
  const cfg = (await DI.resolve(Configuration)) as unknown;
  if (!(cfg instanceof TestConfiguration)) throw new Error('container.resolve(Configuration) did not return the TestConfiguration');
  installed = { cachedBefore, config: cfg, uninstallLog };
  return cfg;
}

/** Disposes every live child domain, then the root service, and removes what installHost and the tests added to root. */
export async function uninstallHost(): Promise<void> {
  if (!installed) return;
  await disposeDomains();
  await resetRoot();
  for (const r of rootRegistrations.splice(0)) DI.unregister(r.token, r.factory);
  const root = DI.RootContainer;
  for (const t of ROOT_CREATED) if (!installed.cachedBefore.has(t)) root.uncache(t);
  DI.unregister(TestConfiguration);
  installed.uninstallLog();
  installed = undefined;
}

/** Between tests: no child domains, no root service, no root registrations of the tests, an empty config. */
export async function resetHost(): Promise<void> {
  await disposeDomains();
  await resetRoot();
  for (const r of rootRegistrations.splice(0)) DI.unregister(r.token, r.factory);
  config().reset();
  TestLog.clear();
}

/** The root AuthzDomains if root has created it, without creating it. */
export function rootDomains(): DefaultAuthzDomains | undefined {
  const d = DI.RootContainer.Cache.has(DefaultAuthzDomains) ? DI.get(AuthzDomains) : undefined;
  return d instanceof DefaultAuthzDomains ? d : undefined;
}

export async function domains(): Promise<DefaultAuthzDomains> {
  const d = await DI.resolve(AuthzDomains);
  if (!(d instanceof DefaultAuthzDomains)) throw new Error('AuthzDomains is not the DefaultAuthzDomains');
  return d;
}

/** Disposes the live child domains (parents dispose their children). */
export async function disposeDomains(): Promise<void> {
  const d = rootDomains();
  if (!d) return;
  for (const name of [...d.names()].reverse()) {
    if (name === 'root' || !d.names().includes(name)) continue;
    await d.container(name).dispose();
  }
}

/** Disposes and uncaches the root AuthzService so the next resolve boots root again. */
export async function resetRoot(): Promise<void> {
  const root = DI.RootContainer;
  if (root.Cache.has(DefaultAuthzService)) {
    const svc = root.get(DefaultAuthzService);
    root.uncache(DefaultAuthzService);
    if (svc) await svc.dispose();
  }
}

/** Registers a factory or class in root; uninstallHost, resetHost or the returned function removes exactly that registration. */
export function registerInRoot<T>(token: Class<T> | string, factory: Factory<T> | Class<T>): () => void {
  DI.register(factory).as(token);
  const entry: RootRegistration = { token: token as Class<unknown> | string, factory: factory as Factory<unknown> | Class<unknown> };
  rootRegistrations.push(entry);
  return () => {
    const i = rootRegistrations.indexOf(entry);
    if (i >= 0) rootRegistrations.splice(i, 1);
    DI.unregister(entry.token, entry.factory);
  };
}

/** A factory registration for one instance: `c.register(instance(x)).as(Token)`. */
export const instance =
  <T>(value: T): Factory<T> =>
  () =>
    value;

/** Gives a factory the name an `authz.models` list activates it by: `c.register(named('A', instance(m))).as(AuthorizationModel)`. */
export const named = <T>(name: string, factory: Factory<T>): Factory<T> => Object.defineProperty(factory, 'name', { value: name });

/**
 * Registers `model` in `container` under its model name and appends that name to the domain's models list
 * (`authz.models` for 'root', else `authz.domains.<domain>.models`). In root it goes through registerInRoot, so
 * resetHost removes it.
 */
export function activate(container: IContainer, domain: string, model: AuthorizationModel): void {
  const factory = named(model.name, instance(model));
  if (container === DI.RootContainer) registerInRoot(AuthorizationModel, factory);
  else container.register(factory).as(AuthorizationModel);
  const path = domain === 'root' ? ['authz', 'models'] : ['authz', 'domains', domain, 'models'];
  config().set(path, [...(config().get<string[] | undefined>(path) ?? []), model.name]);
}

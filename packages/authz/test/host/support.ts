import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';

import { DefaultAuthzService } from '../../src/host/service.js';
import { DefaultAuthzDomains } from '../../src/host/domains.js';
import { InProcessChangeBus } from '../../src/host/bus.js';
import { LogDecisionAudit } from '../../src/host/audit.js';
import { SystemClock } from '../../src/host/clock.js';
import { AuthzDomains, AuthzService } from '../../src/index.js';

type Path = string | readonly string[];

const segments = (path: Path): string[] => (Array.isArray(path) ? [...path] : (path as string).split('.').filter((s) => s !== ''));

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

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
    const segs = segments(path);
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
    const segs = segments(path);
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

let installed: { cachedBefore: Set<Class<unknown>>; config: TestConfiguration } | undefined;
const rootRegistrations: { token: Class<unknown>; factory: Factory<unknown> | Class<unknown>; createdKey: boolean }[] = [];

export function config(): TestConfiguration {
  if (!installed) throw new Error('test host is not installed: call installHost() in a before hook');
  return installed.config;
}

export const setConfig = (path: Path, value: unknown): void => config().set(segments(path), value);
export const clearConfig = (path: Path): void => config().unset(path);
export const resetConfig = (): void => config().reset();

/** Registers TestConfiguration in root (last, so it wins) and resolves it. */
export async function installHost(): Promise<TestConfiguration> {
  if (installed) return installed.config;
  const root = DI.RootContainer;
  const cachedBefore = new Set(ROOT_CREATED.filter((t) => root.Cache.has(t)));
  DI.register(TestConfiguration).as(Configuration);
  const cfg = (await DI.resolve(Configuration)) as unknown;
  if (!(cfg instanceof TestConfiguration)) throw new Error('container.resolve(Configuration) did not return the TestConfiguration');
  installed = { cachedBefore, config: cfg };
  return cfg;
}

/** Disposes every live child domain, then the root service, and removes what installHost and the tests added to root. */
export async function uninstallHost(): Promise<void> {
  if (!installed) return;
  await disposeDomains();
  await resetRoot();
  for (const r of rootRegistrations.splice(0)) unregisterFromRoot(r);
  const root = DI.RootContainer;
  for (const t of ROOT_CREATED) if (!installed.cachedBefore.has(t)) root.uncache(t);
  DI.unregister(TestConfiguration);
  installed = undefined;
}

/** Between tests: no child domains, no root service, no root registrations of the tests, an empty config. */
export async function resetHost(): Promise<void> {
  await disposeDomains();
  await resetRoot();
  for (const r of rootRegistrations.splice(0)) unregisterFromRoot(r);
  resetConfig();
}

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

export async function rootService(): Promise<AuthzService> {
  return DI.resolve(AuthzService);
}

/** Registers a factory or class in root; uninstallHost (or the returned function) removes exactly that registration. */
export function registerInRoot<T>(token: Class<T>, factory: Factory<T> | Class<T>): () => void {
  const root = DI.RootContainer;
  const createdKey = !root.Registry.ownsRegistration(token);
  root.register(factory).as(token);
  const entry = { token: token as Class<unknown>, factory: factory as Factory<unknown> | Class<unknown>, createdKey };
  rootRegistrations.push(entry);
  return () => {
    const i = rootRegistrations.indexOf(entry);
    if (i >= 0) rootRegistrations.splice(i, 1);
    unregisterFromRoot(entry);
  };
}

function unregisterFromRoot(entry: { token: Class<unknown>; factory: Factory<unknown> | Class<unknown>; createdKey: boolean }): void {
  const root = DI.RootContainer;
  const list = root.Registry.getTypes(entry.token, false);
  if (!list) return;
  const i = list.indexOf(entry.factory);
  if (i >= 0) list.splice(i, 1);
  // Registry.unregister matches by name, which every arrow factory shares; drop the key we created.
  if (entry.createdKey && list.length === 0) (root.Registry as unknown as { registry: Map<string, unknown[]> }).registry.delete(entry.token.name);
}

/** A factory registration for one instance: `c.register(instance(x)).as(Token)`. */
export const instance =
  <T>(value: T): Factory<T> =>
  () =>
    value;

export type { IContainer };

import { DI_DESCRIPTION_SYMBOL } from './decorators.js';
import { ResolveType } from './enums.js';
import { getTypeName, isConstructor, isFactory, isTypedArray } from './helpers.js';
import { AsyncService } from './interfaces.js';
import type { ContainerDescription, IContainer, IInjectDescriptor, IToInject, ImplementationDescription, InjectionDescription, ServiceDescription, ServiceLifetime } from './interfaces.js';
import type { Class } from './types.js';

const LIFETIMES: Record<ResolveType, ServiceLifetime> = {
  [ResolveType.Singleton]: 'singleton',
  [ResolveType.NewInstance]: 'new-instance',
  [ResolveType.PerChildContainer]: 'per-child',
  [ResolveType.PerInstance]: 'per-instance',
  [ResolveType.PerInstanceCheck]: 'per-instance-check',
};

function describeInjection(x: IToInject<unknown>): InjectionDescription {
  return {
    token: getTypeName(x.inject),
    kind: !x.autoinject ? 'ctor' : x.lazy ? 'lazy' : 'property',
    optional: x.optional === true,
    array: isTypedArray(x.inject),
    ...(x.mapFunc ? { mapped: true } : {}),
    ...(x.autoinject ? { property: String(x.autoinjectKey) } : {}),
  };
}

// The cache also holds the container itself (under 'Container'); no registered class matches it, so it is harmless here.
function liveTypes(container: IContainer): Set<unknown> {
  const live = new Set<unknown>();
  for (const { value } of container.Cache) {
    if (typeof value === 'object' && value !== null) live.add((value as object).constructor);
  }
  return live;
}

function describeClass(container: IContainer, type: Class<unknown>, live: ReadonlySet<unknown>): ImplementationDescription {
  // getTypeName, not type.name: an anonymous class keys by a generated name, and Studio joins on it.
  const base = { name: getTypeName(type), kind: 'class' as const, instantiated: live.has(type), async: (type.prototype as object) instanceof AsyncService };
  try {
    const descriptor = container.extractDescriptor(type, { record: false });
    return { ...base, lifetime: LIFETIMES[descriptor.resolver], injects: descriptor.inject.map(describeInjection) };
  } catch (e) {
    const declared = Reflect.getMetadata(DI_DESCRIPTION_SYMBOL, type) as IInjectDescriptor<unknown> | undefined;
    return { ...base, lifetime: LIFETIMES[declared?.resolver ?? ResolveType.Singleton], injects: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function describeImplementation(container: IContainer, impl: unknown, live: ReadonlySet<unknown>): ImplementationDescription {
  if (isConstructor(impl)) return describeClass(container, impl, live);
  if (isFactory(impl)) return { name: impl.name, kind: 'factory', lifetime: 'factory', instantiated: false, async: false, injects: [] };
  return { name: getTypeName(impl as object), kind: 'value', lifetime: 'value', instantiated: true, async: false, injects: [] };
}

export function describeContainer(container: IContainer): ContainerDescription {
  const live = liveTypes(container);
  const pending = new Set(container.Cache.pendingKeys());
  const services = new Map<string, ServiceDescription>();
  const service = (token: string): ServiceDescription => {
    let found = services.get(token);
    if (!found) services.set(token, (found = { token, resolving: pending.has(token), implementations: [] }));
    return found;
  };

  for (const [token, list] of container.Registry.entries()) {
    const described = service(token);
    // In-flight resolutions are keyed by the implementation class, not by the token it is registered as.
    described.resolving ||= list.some((impl) => isConstructor(impl) && pending.has(getTypeName(impl)));
    for (const impl of list) described.implementations.push(describeImplementation(container, impl, live));
  }
  for (const { key } of container.Registry.valueEntries()) {
    service(key).implementations.push({ name: key, kind: 'value', lifetime: 'value', instantiated: true, async: false, injects: [] });
  }

  return { services: [...services.values()].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0)) };
}

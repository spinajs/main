import type { ContainerDescription, ImplementationDescription, InjectionDescription } from '@spinajs/di';
import type { Condition, Manifest, PropertyInject, ServiceEntry, SourceRef } from '@spinajs/manifest';

import type { DiImplementation, DiInjection, DiServiceDetail, GraphNode, StudioGraph, StudioSource } from '../contracts/index.js';
import { truncate } from '../span.js';
import { GraphBuilder } from './graph.js';

export const svcId = (name: string): string => `svc:${name}`;
export const tokId = (key: string): string => `tok:${key}`;
export const valId = (key: string): string => `val:${key}`;
export const facId = (key: string, index: number): string => `fac:${key}:${index}`;

const PREFIXES = ['svc:', 'tok:', 'val:'] as const;

export function tokenOf(nodeId: string): string {
  if (nodeId.startsWith('fac:')) return nodeId.slice(4, nodeId.lastIndexOf(':'));
  const prefix = PREFIXES.find((p) => nodeId.startsWith(p));
  return prefix ? nodeId.slice(prefix.length) : nodeId;
}

// The node an injection of `key` points at: the class of that name, else its token or value node, else a new bare token.
function targetOf(b: GraphBuilder, key: string): string {
  const found = [svcId(key), tokId(key), valId(key)].find((id) => b.has(id));
  if (found) return found;
  b.node({ id: tokId(key), label: key, kind: 'token', attributes: { registered: false } });
  return tokId(key);
}

function implementationNode(b: GraphBuilder, key: string, impl: ImplementationDescription, index: number): string {
  if (impl.kind === 'value') {
    b.node({ id: valId(key), label: key, kind: 'value', attributes: { instantiated: true } });
    return valId(key);
  }
  if (impl.kind === 'factory') {
    b.node({ id: facId(key, index), label: impl.name || key, kind: 'factory', attributes: { lifetime: impl.lifetime } });
    return facId(key, index);
  }
  b.node({ id: svcId(impl.name), label: impl.name, kind: 'service', attributes: { lifetime: impl.lifetime, instantiated: impl.instantiated, async: impl.async, ...(impl.error ? { error: impl.error } : {}) } });
  return svcId(impl.name);
}

export function runtimeDiGraph(description: ContainerDescription): StudioGraph {
  const b = new GraphBuilder();
  const injections: { from: string; inject: InjectionDescription }[] = [];
  for (const service of description.services) {
    service.implementations.forEach((impl, i) => {
      const id = implementationNode(b, service.token, impl, i);
      if (impl.kind !== 'value' && impl.name !== service.token) {
        b.node({ id: tokId(service.token), label: service.token, kind: 'token', attributes: { resolving: service.resolving } });
        b.edge(id, tokId(service.token), 'implements');
      }
      for (const inject of impl.injects) injections.push({ from: id, inject });
    });
  }
  // After every node exists, so an injection prefers the class over a bare token.
  for (const { from, inject } of injections) b.edge(from, targetOf(b, inject.token), inject.kind, inject.kind === 'ctor' ? undefined : inject.property);
  return b.build('runtime');
}

export function manifestDiGraph(manifest: Manifest): StudioGraph {
  const b = new GraphBuilder();
  for (const s of manifest.services) {
    b.node({ id: svcId(s.className), label: s.className, kind: 'service', group: s.source.package, attributes: { lifetime: s.lifetime, async: s.async, bootstrapper: s.bootstrapper, manifestId: s.id } });
  }
  for (const v of manifest.values) b.node({ id: valId(v.token), label: v.token, kind: 'value', group: v.source.package, attributes: {} });
  for (const s of manifest.services) {
    const from = svcId(s.className);
    for (const key of s.registeredAs.filter((k) => k !== s.className)) {
      b.node({ id: tokId(key), label: key, kind: 'token', attributes: {} });
      b.edge(from, tokId(key), 'implements');
    }
    for (const key of s.ctorInjects) b.edge(from, targetOf(b, key), 'ctor');
    for (const p of s.propertyInjects) b.edge(from, targetOf(b, p.token), p.lazy ? 'lazy' : 'property', p.property);
    for (const r of s.imperativeResolves ?? []) b.edge(from, targetOf(b, r.token), 'imperative', `${r.method}()`);
  }
  return b.build('manifest');
}

const isBareToken = (n: GraphNode): boolean => n.kind === 'token' && n.attributes.registered === false;

export function mergeDiGraphs(manifest: StudioGraph, runtime: StudioGraph): StudioGraph {
  const b = new GraphBuilder();
  // Each side adds a bare token for a key it injects but does not register; the other side may register that key.
  const bare = new Set([...manifest.nodes, ...runtime.nodes].filter(isBareToken).map((n) => n.id));
  for (const n of manifest.nodes) if (!bare.has(n.id)) b.node({ ...n, attributes: { ...n.attributes, instantiated: false } });
  for (const n of runtime.nodes) if (!bare.has(n.id)) b.node(b.has(n.id) ? n : { ...n, attributes: { ...n.attributes, unknownToManifest: true } });
  for (const e of [...manifest.edges, ...runtime.edges]) b.edge(e.source, bare.has(e.target) ? targetOf(b, tokenOf(e.target)) : e.target, e.kind, e.label);
  return b.build('merged');
}

export function resolveDiFocus(graph: StudioGraph, focus: string): string | undefined {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return ids.has(focus) ? focus : [svcId(focus), tokId(focus), valId(focus)].find((id) => ids.has(id));
}

const toInjection = (x: InjectionDescription): DiInjection => ({ token: truncate(x.token), kind: x.kind, optional: x.optional, array: x.array, ...(x.mapped ? { mapped: true } : {}), ...(x.property ? { property: truncate(x.property) } : {}) });

const toImplementation = (i: ImplementationDescription): DiImplementation => ({ name: truncate(i.name), kind: i.kind, lifetime: i.lifetime, instantiated: i.instantiated, async: i.async, injects: i.injects.map(toInjection), ...(i.error ? { error: truncate(i.error) } : {}) });

// Field by field, never a spread: a hand-written manifest is not schema-checked for unknown fields.
const cutRef = (r: SourceRef): SourceRef => ({ file: truncate(r.file), line: r.line, col: r.col, package: truncate(r.package) });

const cutProperty = (p: PropertyInject): PropertyInject => ({
  property: truncate(p.property),
  token: truncate(p.token),
  optional: p.optional,
  array: p.array,
  ...(p.lazy === undefined ? {} : { lazy: p.lazy }),
  ...(p.concrete === undefined ? {} : { concrete: p.concrete }),
  ...(p.check === undefined ? {} : { check: p.check }),
  ...(p.tokenRef ? { tokenRef: { package: truncate(p.tokenRef.package), file: truncate(p.tokenRef.file), export: truncate(p.tokenRef.export) } } : {}),
});

// `expected` is dropped: the compiler never writes it, and a hand-made manifest could put a configuration value there.
const cutCondition = (c: Condition): Condition => (c.kind === 'config' ? { kind: 'config', path: truncate(c.path) } : { kind: 'dynamic', reason: truncate(c.reason) });

type ImperativeResolve = NonNullable<ServiceEntry['imperativeResolves']>[number];
const cutResolve = (r: ImperativeResolve): ImperativeResolve => ({ token: truncate(r.token), method: truncate(r.method), awaited: r.awaited, source: cutRef(r.source) });

function cutEntry(s: ServiceEntry): ServiceEntry {
  return {
    id: truncate(s.id),
    className: truncate(s.className),
    registeredAs: s.registeredAs.map(truncate),
    lifetime: s.lifetime,
    async: s.async,
    bootstrapper: s.bootstrapper,
    ctorInjects: s.ctorInjects.map(truncate),
    ...(s.ctorConcrete ? { ctorConcrete: s.ctorConcrete.map((c) => c === true) } : {}),
    propertyInjects: s.propertyInjects.map(cutProperty),
    ...(s.imperativeResolves ? { imperativeResolves: s.imperativeResolves.map(cutResolve) } : {}),
    ...(s.condition ? { condition: cutCondition(s.condition) } : {}),
    source: cutRef(s.source),
  };
}

const fromManifest = (s: ServiceEntry): DiImplementation => ({
  name: s.className,
  kind: 'class',
  lifetime: s.lifetime,
  instantiated: false,
  async: s.async,
  injects: [
    ...s.ctorInjects.map((token): DiInjection => ({ token, kind: 'ctor', optional: false, array: false })),
    ...s.propertyInjects.map((p): DiInjection => ({ token: p.token, kind: p.lazy ? 'lazy' : 'property', optional: p.optional, array: p.array, property: p.property })),
  ],
});

function injectedBy(token: string, description: ContainerDescription, entries: readonly ServiceEntry[]): { token: string; kind: string }[] {
  const out = new Map<string, { token: string; kind: string }>();
  const add = (from: string, kind: string) => out.set(`${from}|${kind}`, { token: truncate(from), kind });
  for (const s of description.services) for (const i of s.implementations) for (const x of i.injects) if (x.token === token) add(i.name, x.kind);
  for (const s of entries) {
    if (s.ctorInjects.includes(token)) add(s.className, 'ctor');
    for (const p of s.propertyInjects) if (p.token === token) add(s.className, p.lazy ? 'lazy' : 'property');
  }
  return [...out.values()];
}

// The runtime reports a class with one untyped property as `injects: []` plus `error`; the manifest knows its injections.
function readable(impl: DiImplementation, known: readonly ServiceEntry[]): DiImplementation {
  if (impl.error === undefined) return impl;
  const entry = known.find((s) => s.className === impl.name);
  return entry ? { ...impl, injects: fromManifest(cutEntry(entry)).injects } : impl;
}

// A class registered only under other keys (`register(Impl).as(Contract)`) has a `svc:` node but no key of its own.
function runtimeOf(token: string, description: ContainerDescription): { implementations: ImplementationDescription[]; resolving: boolean } | undefined {
  const keyed = description.services.find((s) => s.token === token);
  if (keyed) return keyed;
  const isClass = (i: ImplementationDescription): boolean => i.kind === 'class' && i.name === token;
  const holders = description.services.filter((s) => s.implementations.some(isClass));
  const implementation = holders.flatMap((s) => s.implementations).find(isClass);
  return implementation ? { implementations: [implementation], resolving: holders.some((s) => s.resolving) } : undefined;
}

export function serviceDetail(token: string, description: ContainerDescription, manifest: Manifest | undefined): DiServiceDetail | undefined {
  const known = manifest?.services ?? [];
  const runtime = runtimeOf(token, description);
  const entries = known.filter((s) => s.className === token || s.registeredAs.includes(token)).map(cutEntry);
  if (!runtime && entries.length === 0) return undefined;
  const source: StudioSource = runtime && manifest ? 'merged' : runtime ? 'runtime' : 'manifest';
  return {
    token,
    source,
    implementations: runtime ? runtime.implementations.map((i) => readable(toImplementation(i), known)) : entries.map(fromManifest),
    injectedBy: injectedBy(token, description, known),
    manifest: entries,
    ...(entries[0] ? { sourceRef: entries[0].source } : {}),
    ...(runtime ? { runtime: { resolving: runtime.resolving } } : {}),
  };
}

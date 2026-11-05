import type { Value } from '../../contracts/filter.js';
import type { AuthorizationModel } from '../../contracts/model.js';
import type { Principal, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import type { DecisionReadSet } from '../../contracts/tap.js';
import type { DecisionRequest } from '../../contracts/decision.js';

type AttributeRead = DecisionReadSet['attributes'][number];

/** The reads of one top-level decision; it exists only while a DecisionTap is registered. */
export class ReadRecorder {
  /** The decision came from the L1 or the L2, so nothing below was read now. */
  cached = false;
  private readonly env: Record<string, unknown> = {};
  private readonly attributes = new Map<string, AttributeRead>();
  private readonly relations = new Map<string, DecisionReadSet['relations'][number]>();

  /** A frozen copy of `env` whose properties record a read; spreading or cloning it reads every key. */
  watch(env: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const watched = {};
    for (const [key, value] of Object.entries(env)) {
      Object.defineProperty(watched, key, {
        enumerable: true,
        get: () => {
          Object.defineProperty(this.env, key, { value, enumerable: true, writable: true, configurable: true });
          return value;
        },
      });
    }
    return Object.freeze(watched);
  }

  attribute(ref: AttributeRead['ref'], path: string, value: unknown): void {
    this.attributes.set(`${typeof ref === 'string' ? ref : resourceKey(ref)}\u0000${path}`, { ref, path, value });
  }

  relation(model: string, object: ResourceRef, relation: string): void {
    this.relations.set(JSON.stringify([model, resourceKey(object), relation]), { model, object, relation });
  }

  /** What a binder resolved: `principal.*` from the principal, `actor.*` and `scope.<type>.*` from the bound values. */
  bound(refs: readonly string[], values: ReadonlyMap<string, Value>, principal: Principal, nodes: ReadonlyMap<string, ResourceRef>): void {
    for (const ref of refs) {
      const [head, ...rest] = ref.split('.');
      if (head === 'principal') this.attribute('principal', rest.join('.'), readPath(principal, rest));
      else if (head === 'actor' && values.has(ref)) this.attribute('actor', rest.join('.'), values.get(ref));
      else if (head === 'scope' && values.has(ref)) {
        const node = nodes.get(rest[0]);
        if (node) this.attribute(node, rest.slice(1).join('.'), values.get(ref));
      }
    }
  }

  readSet(models: readonly AuthorizationModel[]): DecisionReadSet {
    return { env: { ...this.env }, attributes: [...this.attributes.values()], relations: [...this.relations.values()], modelVersions: modelVersions(models) };
  }
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let v = root;
  for (const p of path) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p)) return undefined;
    v = (v as Record<string, unknown>)[p];
  }
  return v;
}

function modelVersions(models: readonly AuthorizationModel[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of models) {
    try {
      const v: unknown = typeof m.version === 'function' ? m.version() : undefined;
      if (typeof v === 'string') Object.defineProperty(out, m.name, { value: v, enumerable: true, writable: true, configurable: true });
    } catch {
      // a failing version() is left out, as the cache key leaves the decision uncached then
    }
  }
  return out;
}

export const watchEnv = (reads: ReadRecorder | undefined, env: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => (reads ? reads.watch(env) : env);

export const watchRequest = (reads: ReadRecorder | undefined, req: DecisionRequest): DecisionRequest => (reads && req.env ? Object.freeze({ ...req, env: reads.watch(req.env) }) : req);

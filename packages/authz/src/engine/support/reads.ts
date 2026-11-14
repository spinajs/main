import type { AuthorizationModel } from '../../contracts/model.js';
import type { ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import type { DecisionReadSet } from '../../contracts/tap.js';

type AttributeRead = DecisionReadSet['attributes'][number];
type RelationRead = DecisionReadSet['relations'][number];

/**
 * The reads of one top-level decision; it exists only while a DecisionTap is registered. Recording only appends:
 * the models see the same request and env as without a tap, and duplicates are dropped when the read set is built.
 */
export class ReadRecorder {
  /** The decision came from the L1 or the L2, so nothing below was read now. */
  cached = false;
  /** The env the models received; undefined when the check ended before the models. */
  env: Readonly<Record<string, unknown>> | undefined;
  private readonly attributes: AttributeRead[] = [];
  private readonly relations: RelationRead[] = [];

  /** The env the check runs with (the caller's keys and `now`), as the models receive it. */
  given(env: Readonly<Record<string, unknown>>): void {
    this.env ??= env;
  }

  attribute(ref: AttributeRead['ref'], path: string, value: unknown): void {
    this.attributes.push({ ref, path, value });
  }

  relation(model: string, object: ResourceRef, relation: string): void {
    this.relations.push({ model, object, relation });
  }

  /** Built on first use: a tap that does not look at the reads (a decision log skipping allows) pays nothing for them. */
  readSet(models: readonly AuthorizationModel[]): DecisionReadSet {
    return new LazyReadSet(this, models);
  }

  /** `now` is left out of `env`: it is the decision's instant, which a record keeps on its own. */
  build(models: readonly AuthorizationModel[]): DecisionReadSet {
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.env ?? {})) if (key !== 'now') Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true });
    const attributes = unique(this.attributes, (a) => `${typeof a.ref === 'string' ? a.ref : resourceKey(a.ref)}\u0000${a.path}`);
    const relations = unique(this.relations, (r) => JSON.stringify([r.model, resourceKey(r.object), r.relation]));
    return { env, attributes, relations, modelVersions: modelVersions(models) };
  }
}

/** Its properties are computed together on the first read; JSON.stringify gives the plain read set. */
class LazyReadSet implements DecisionReadSet {
  #built: DecisionReadSet | undefined;

  constructor(
    private readonly recorder: ReadRecorder,
    private readonly models: readonly AuthorizationModel[],
  ) {}

  get env(): DecisionReadSet['env'] {
    return this.built().env;
  }

  get attributes(): DecisionReadSet['attributes'] {
    return this.built().attributes;
  }

  get relations(): DecisionReadSet['relations'] {
    return this.built().relations;
  }

  get modelVersions(): DecisionReadSet['modelVersions'] {
    return this.built().modelVersions;
  }

  toJSON(): DecisionReadSet {
    return this.built();
  }

  private built(): DecisionReadSet {
    return (this.#built ??= this.recorder.build(this.models));
  }
}

/** The last entry of each key, in first-seen order. */
function unique<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const x of xs) byKey.set(key(x), x);
  return [...byKey.values()];
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

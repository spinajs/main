import { quote } from '@spinajs/util';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { ResourceRef } from '../../contracts/principal.js';
import { GLOBAL, resourceKey } from '../../contracts/resource.js';
import { mergeAttributes } from '../attributes.js';
import { l1Key, memo } from '../context.js';
import type { MaybePromise } from '../context.js';
import { isThenable, swallow } from '../run.js';
import { copyRef, describeError } from '../vote.js';
import { loads } from '../cache/store.js';
import { bounded, TIMED_OUT } from '../support/ref-binder.js';
import { logAt } from '../support/plumbing.js';
import { GLOBAL_ANCESTORS, GLOBAL_TYPE } from '../types.js';
import type { Attributes, Engine, LoadedAttributes, NodeLoad } from '../types.js';
import { refuseLateType } from './late-type.js';

/** Step 5 and ctx.ancestors: memoised in L1; sync for refs that need no IO. */
export function ancestorsOf(engine: Engine, ref: ResourceRef, scope: Map<string, unknown>): MaybePromise<readonly ResourceRef[] | null> {
  return memo(scope, l1Key('ancestors', engine.domain, resourceKey(ref)), () => loadAncestors(engine, ref));
}

export function loadAncestors(engine: Engine, ref: ResourceRef): MaybePromise<readonly ResourceRef[] | null> {
  if (ref.type === GLOBAL_TYPE && ref.id === undefined) return GLOBAL_ANCESTORS;
  if (ref.id === undefined) return Object.freeze([ref, GLOBAL]);
  const adapter = engine.adapterByType.get(ref.type);
  // An ancestor or scope node a model reads, not only the checked ref, may be of a late type.
  if (!adapter) refuseLateType(engine, ref.type);
  const source = adapter ?? engine.resolverByType.get(ref.type);
  if (!source) return Object.freeze([ref, GLOBAL]);
  const raw = source.ancestors(ref);
  return isThenable(raw) ? Promise.resolve(raw).then((list) => ancestorList(engine, list, ref)) : ancestorList(engine, raw, ref);
}

export function ancestorList(engine: Engine, list: unknown, ref: ResourceRef): readonly ResourceRef[] | null {
  if (list === null) return null;
  const out = Array.isArray(list) ? Array.from(list, (r: unknown) => copyRef(r)) : undefined;
  if (!out || out.some((r) => r === undefined)) throw new AuthzConfigError(`${engine.where}: ancestors of ${resourceKey(ref)} must be a list of refs or null`);
  return Object.freeze(out as ResourceRef[]);
}

export function attributesOf(engine: Engine, ref: ResourceRef, scope: Map<string, unknown>): Promise<Attributes> {
  return nodeLoad(engine, ref, scope).result.then((l) => l.attributes);
}

export function nodeLoad(engine: Engine, ref: ResourceRef, scope: Map<string, unknown>): NodeLoad {
  return memo(scope, l1Key('attributes', engine.domain, resourceKey(ref)), () => {
    const load = { ref, timeoutLogged: false, degraded: false } as { -readonly [K in keyof NodeLoad]: NodeLoad[K] };
    // The flag is set before any awaiting model resumes, so a vote built on a degraded load is never stored.
    load.result = loadAttributes(engine, ref, load).then(
      (l) => {
        if (l.degraded) load.degraded = true;
        return l;
      },
      (e: unknown) => {
        load.degraded = true;
        throw e;
      },
    );
    swallow(load.result);
    loads(engine, scope).push(load);
    return load;
  });
}

/**
 * Schema defaults ⊕ the adapter's (else the resolver's) attributes ⊕ the
 * store row, deeply frozen. Errors propagate, so the asking model is
 * indeterminate; a null answer or a load past modelTimeoutMs gives null
 * (unknown node).
 */
export async function loadAttributes(engine: Engine, ref: ResourceRef, load: NodeLoad): Promise<LoadedAttributes> {
  const adapter = engine.adapterByType.get(ref.type);
  const resolver = engine.resolverByType.get(ref.type);
  if (!adapter) refuseLateType(engine, ref.type);
  let own: unknown = {};
  if (adapter && typeof adapter.scopeAttributes === 'function') own = await attributeLoad(engine, ref, load, `adapter ${quote(adapter.kind)}`, () => adapter.scopeAttributes!(ref));
  else if (resolver && typeof resolver.attributes === 'function') own = await attributeLoad(engine, ref, load, 'the scope resolver', () => resolver.attributes!(ref));
  if (own === TIMED_OUT) return { attributes: null, degraded: true };
  if (own === null) return { attributes: null, degraded: false };
  const layers: unknown[] = [engine.attributeDefaults.get(ref.type) ?? {}, own];
  const store = engine.attributeStore;
  if (store) {
    const row = await attributeLoad(engine, ref, load, 'the scope attribute store', () => store.get(ref));
    if (row === TIMED_OUT) return { attributes: null, degraded: true };
    layers.push(row);
  }
  try {
    return { attributes: mergeAttributes(layers), degraded: false };
  } catch (e) {
    throw new AuthzConfigError(`${engine.where}: scope attributes of ${resourceKey(ref)}: ${describeError(e)}`, { cause: e });
  }
}

export async function attributeLoad(engine: Engine, ref: ResourceRef, node: NodeLoad, source: string, load: () => unknown): Promise<unknown> {
  const r = await bounded(load, engine.config.modelTimeoutMs);
  if (r.kind === 'error') throw r.error;
  if (r.kind === 'value') return r.value;
  logTimeout(engine, node, { resource: resourceKey(ref), source, timeoutMs: engine.config.modelTimeoutMs }, 'Authz domain ${domain}: scope attributes of ${resource} from ${source} timed out after ${timeoutMs} ms; the node is unknown');
  return TIMED_OUT;
}

export function logTimeout(engine: Engine, load: NodeLoad, fields: Record<string, unknown>, template: string): void {
  if (load.timeoutLogged) return;
  load.timeoutLogged = true;
  logAt(engine, 'error', fields, template);
}

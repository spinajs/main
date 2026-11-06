import type { Decision, DecisionRequest } from '../../contracts/decision.js';
import type { ResourceRef, ResourceType } from '../../contracts/principal.js';
import type { ContextHost, MaybePromise } from '../context.js';
import { isThenable, runAsync } from '../run.js';
import { markFault, marking } from '../cache/store.js';
import { pipeline } from '../pipeline/index.js';
import { topRun } from '../support/plumbing.js';
import type { Attributes, Engine, Run } from '../types.js';
import { requireRef } from './late-type.js';
import { relation } from './request.js';
import { ancestorsOf, attributesOf, nodeLoad } from './scope.js';

/** The host of contexts outside a check (preload); a check's own contexts use hostFor(run). */
export function baseHost(engine: Engine): ContextHost {
  return Object.freeze({
    domain: engine.domain,
    permissions: engine.registry,
    conditions: engine.conditions,
    ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => marking(engine, scope, () => ancestorsOf(engine, requireRef(engine, ref), scope)),
    attributes: (ref: ResourceRef, scope: Map<string, unknown>) => attributesOf(engine, requireRef(engine, ref), scope),
    relation: (type: ResourceType, name: string) => relation(engine, type, name),
    nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number): Promise<Decision> =>
      Promise.resolve(
        marking(engine, scope, () =>
          runAsync(pipeline(engine, req, topRun(engine, false, scope, instant, depth))).then((r) => {
            if (r.faulted) markFault(engine, scope);
            return r.decision;
          }),
        ),
      ),
  });
}

/**
 * The context host of one call tree: a model's ctx.check shares its versions,
 * generation, nested record and cache bypass. A failed (or, for attributes,
 * timed-out) call marks the tree faulted even when the model catches it; a
 * rejection also marks the request, as nothing else records it.
 */
export function hostFor(engine: Engine, run: Run): ContextHost {
  const fault = (e: unknown): never => {
    run.nested.faulted = true;
    markFault(engine, run.scope);
    throw e;
  };
  const watched = <T>(call: () => MaybePromise<T>): MaybePromise<T> => {
    let r: MaybePromise<T>;
    try {
      r = call();
    } catch (e) {
      return fault(e);
    }
    return isThenable(r) ? Promise.resolve(r).then(undefined, fault) : r;
  };
  return Object.freeze({
    domain: engine.domain,
    permissions: engine.registry,
    conditions: engine.conditions,
    ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => watched(() => ancestorsOf(engine, requireRef(engine, ref), scope)),
    attributes: (ref: ResourceRef, scope: Map<string, unknown>) =>
      watched(() =>
        nodeLoad(engine, requireRef(engine, ref), scope).result.then((l) => {
          if (l.degraded) run.nested.faulted = true;
          return l.attributes;
        }),
      ) as Promise<Attributes>,
    relation: (type: ResourceType, name: string) => relation(engine, type, name),
    nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(pipeline(engine, req, { ...run, sync: false, scope, instant, depth, delegationBudget: engine.config.maxDelegation })).then((r) => r.decision, fault),
  });
}

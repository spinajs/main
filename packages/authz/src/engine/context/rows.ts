import type { ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { l1Key } from '../context.js';
import { settleWithin } from '../run.js';
import { describeError, thrownError } from '../vote.js';
import { byType } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { FAILED_ROW, MISSING_ROW } from '../types.js';
import type { Engine, RowLoad } from '../types.js';
import { ancestorList } from './scope.js';

/** One ancestorsMany call per type for the refs with an id the L1 lacks; a failure leaves them to ancestors() per ref. */
export async function prefillAncestors(engine: Engine, refs: readonly ResourceRef[], scope: Map<string, unknown>): Promise<void> {
  const pending = refs.filter((r) => r.id !== undefined && !scope.has(l1Key('ancestors', engine.domain, resourceKey(r))));
  await Promise.all(
    [...byType(pending)].map(async ([type, list]) => {
      const adapter = engine.adapterByType.get(type);
      if (!adapter || typeof adapter.ancestorsMany !== 'function') return;
      const settled = await settleWithin(
        Promise.resolve().then(() => adapter.ancestorsMany!(list)),
        engine.config.modelTimeoutMs,
        describeError,
        'ancestorsMany',
      );
      if (!settled.ok || !(settled.value instanceof Map)) {
        logAt(engine, 'error', { adapter: adapter.kind, count: list.length, resourceType: type, cause: settled.ok ? 'it did not return a Map' : settled.error }, 'Authz domain ${domain}: ancestorsMany of adapter ${adapter} for ${count} ${resourceType} ref(s) failed, asking ancestors() per ref: ${cause}');
        return;
      }
      const found = settled.value as ReadonlyMap<string, unknown>;
      for (const ref of list) {
        const key = resourceKey(ref);
        try {
          scope.set(l1Key('ancestors', engine.domain, key), ancestorList(engine, found.get(key) ?? null, ref));
        } catch (e) {
          logAt(engine, 'error', { error: thrownError(e), adapter: adapter.kind, resource: key }, 'Authz domain ${domain}: ancestorsMany of adapter ${adapter} answered a malformed list for ${resource}, asking ancestors()');
        }
      }
    }),
  );
}

/** Rows by resourceKey; a type whose adapter has neither loadMany nor load is left out. */
export async function loadRows(engine: Engine, refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, RowLoad>> {
  const out = new Map<string, RowLoad>();
  const rowOf = (v: unknown): RowLoad => (v === undefined || v === null ? MISSING_ROW : { kind: 'row', row: v });
  await Promise.all(
    [...byType(refs)].map(async ([type, list]) => {
      const adapter = engine.adapterByType.get(type);
      if (adapter && typeof adapter.loadMany === 'function') {
        const settled = await settleWithin(
          Promise.resolve().then(() => adapter.loadMany!(list)),
          engine.config.modelTimeoutMs,
          describeError,
          'loadMany',
        );
        const found = settled.ok && settled.value instanceof Map ? (settled.value as ReadonlyMap<string, unknown>) : undefined;
        if (!found) logAt(engine, 'error', { adapter: adapter.kind, count: list.length, resourceType: type, cause: settled.ok ? 'it did not return a Map' : settled.error }, 'Authz domain ${domain}: loadMany of adapter ${adapter} for ${count} ${resourceType} row(s) failed: ${cause}');
        for (const ref of list) out.set(resourceKey(ref), found ? rowOf(found.get(resourceKey(ref))) : FAILED_ROW);
      } else if (adapter && typeof adapter.load === 'function') {
        await Promise.all(
          list.map(async (ref) => {
            const settled = await settleWithin(
              Promise.resolve().then(() => adapter.load!(ref)),
              engine.config.modelTimeoutMs,
              describeError,
              'load',
            );
            if (!settled.ok) logAt(engine, 'error', { resource: resourceKey(ref), adapter: adapter.kind, cause: settled.error }, 'Authz domain ${domain}: load of ${resource} from adapter ${adapter} failed: ${cause}');
            out.set(resourceKey(ref), settled.ok ? rowOf(settled.value) : FAILED_ROW);
          }),
        );
      }
    }),
  );
  return out;
}

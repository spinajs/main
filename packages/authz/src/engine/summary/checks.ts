import { compareStrings } from '@spinajs/util';
import type { ModelSummary, AuthorizationModel } from '../../contracts/model.js';
import type { PermissionDef } from '../../contracts/permission.js';
import { principalKey } from '../../contracts/principal.js';
import type { Principal, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { ModelContext } from '../context.js';
import { runAsync, settleWithin } from '../run.js';
import { describeError, thrownError } from '../vote.js';
import { hostFor } from '../context/host.js';
import { delegationOf } from '../pipeline/delegate.js';
import { pipeline } from '../pipeline/index.js';
import { principalGate } from '../pipeline/principal-gate.js';
import type { Deadline } from '../support/deadline.js';
import { THREW } from '../support/deadline.js';
import { admits, contextCacheKey, newNested, principalCacheId } from '../support/misc.js';
import { logAt, newRun } from '../support/plumbing.js';
import { GLOBAL_TYPE, MAX_SUMMARY_PERMISSIONS, SUMMARY_BATCH } from '../types.js';
import type { Checked, Engine, RequestScope, Run } from '../types.js';
import { copySummary } from './entries.js';

/** The principal gate lets `p` run models and its onBehalfOf chain resolves without a denial or a throw. */
export function admitted(engine: Engine, p: unknown): boolean {
  const gate = principalGate(p);
  if (gate.kind !== 'run') return false;
  try {
    return delegationOf(engine, gate.principal, undefined, engine.config.maxDelegation).denial === undefined;
  } catch (e) {
    logAt(engine, 'debug', { error: thrownError(e), principal: principalKey(gate.ref) }, 'Authz domain ${domain}: covers is false: the onBehalfOf chain of ${principal} does not resolve');
    return false;
  }
}

/** The base run of one summary or covers call: one instant, version vector and generation for every check; never audited. */
export function quietRun(engine: Engine, scope: RequestScope | undefined): Run {
  return { ...newRun(engine, false, scope), quiet: true };
}

/** Registered permissions checkable at `ref` (its type in `types`, or `$global`), sorted by name, at most MAX_SUMMARY_PERMISSIONS. */
export function checkable(engine: Engine, ref: ResourceRef, what: string): { readonly defs: readonly PermissionDef[]; readonly truncated: boolean } {
  const defs = engine.registry
    .all()
    .filter((d) => ref.type === GLOBAL_TYPE || d.types.includes(ref.type))
    .sort((a, b) => compareStrings(a.name, b.name));
  if (defs.length <= MAX_SUMMARY_PERMISSIONS) return { defs, truncated: false };
  logAt(engine, 'warn', { operation: what, resource: resourceKey(ref), count: defs.length, limit: MAX_SUMMARY_PERMISSIONS }, 'Authz domain ${domain}: ${operation} at ${resource} has ${count} permissions to check, more than the limit of ${limit}');
  return { defs: defs.slice(0, MAX_SUMMARY_PERMISSIONS), truncated: true };
}

/**
 * The summaries of the models routed for `defs` at `ref` (at `$global`, also
 * at each of a permission's types) that serve the principal the models run
 * with. `names` is undefined when one of them gave no usable summary.
 */
export async function modelSummaries(engine: Engine, principal: Principal, ref: ResourceRef, defs: readonly PermissionDef[], run: Run): Promise<{ readonly list: readonly ModelSummary[]; readonly names: ReadonlySet<string> | undefined }> {
  let runAs: Principal;
  try {
    const d = delegationOf(engine, principal, undefined, engine.config.maxDelegation);
    // Every check denies `delegate` then.
    if (d.denial) return { list: [], names: undefined };
    runAs = d.principal;
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: summary could not resolve the onBehalfOf chain');
    return { list: [], names: undefined };
  }
  const routed = new Set<AuthorizationModel>();
  for (const def of defs) {
    // A check at $global is concrete: the models routed for the permission's types hold what lies below it.
    for (const type of ref.type === GLOBAL_TYPE ? [ref.type, ...def.types] : [ref.type]) for (const m of engine.table.get(def.name, type)?.models ?? []) routed.add(m);
  }
  const host = hostFor(engine, run);
  const cacheId = principalCacheId(runAs);
  let complete = true;
  const results = await Promise.all(
    engine.modelList
      .filter((m) => routed.has(m) && admits(m, runAs))
      .map(async (model): Promise<ModelSummary | undefined> => {
        try {
          if (typeof model.summarize !== 'function') {
            complete = false;
            return undefined;
          }
          // Its own memo: a summarize that fails half-way must not leave state the votes read.
          const ctx = new ModelContext(host, model.name, run.scope, run.instant, 0, undefined, contextCacheKey(model.name, cacheId, 'summarize'));
          const settled = await settleWithin(
            Promise.resolve().then(() => model.summarize!(runAs, ref, ctx)),
            engine.config.modelTimeoutMs,
            describeError,
            'summarize',
          );
          if (!settled.ok) throw new Error(settled.error);
          return copySummary(settled.value, model.name);
        } catch (e) {
          complete = false;
          logAt(engine, 'error', { error: thrownError(e), model: model.name }, 'Authz domain ${domain}: model ${model} failed to summarize, left out');
          return undefined;
        }
      }),
  );
  const list = results.filter((s): s is ModelSummary => s !== undefined);
  return { list, names: complete ? new Set(list.flatMap((s) => s.permissions.map((p) => p.name))) : undefined };
}

/**
 * One quiet check per permission, SUMMARY_BATCH at a time, until `limit`
 * passes: THREW where the check threw, undefined where it had not settled
 * by then (checks still running are left to finish unread).
 */
export async function checkEach(engine: Engine, principal: Principal, defs: readonly PermissionDef[], ref: ResourceRef, run: Run, limit: Deadline): Promise<(Checked | typeof THREW | undefined)[]> {
  const out: (Checked | typeof THREW | undefined)[] = defs.map(() => undefined);
  let failed = 0;
  let first: unknown;
  for (let i = 0; i < defs.length && !limit.expired; i += SUMMARY_BATCH) {
    const batch = defs.slice(i, i + SUMMARY_BATCH).map(async (def, j) => {
      try {
        const c = await quietCheck(engine, principal, def, ref, run);
        if (!limit.expired) out[i + j] = c;
      } catch (e: unknown) {
        if (limit.expired) return;
        out[i + j] = THREW;
        if (failed++ === 0) first = e;
      }
    });
    await limit.race(Promise.all(batch));
  }
  if (failed > 0) logAt(engine, 'error', { error: thrownError(first), count: failed }, 'Authz domain ${domain}: summary left out ${count} permission(s) whose check threw; the error is the first');
  const unchecked = out.filter((c) => c === undefined).length;
  if (unchecked > 0) logAt(engine, 'error', { count: unchecked, deadlineMs: limit.ms }, 'Authz domain ${domain}: summary left out ${count} permission(s) not checked within its deadline of ${deadlineMs} ms');
  return out;
}

/** `run`: the call's quietRun; each check is its own call tree, so it gets its own nested record. */
export function quietCheck(engine: Engine, principal: Principal, def: PermissionDef, ref: ResourceRef, run: Run, firm = false): Promise<Checked> {
  return runAsync(pipeline(engine, { principal, permission: def.name }, { ...run, nested: newNested(), ...(firm ? { firm } : {}) }, { ref, subject: undefined }));
}

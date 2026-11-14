import type { Permission, PermissionDef } from '../../contracts/permission.js';
import type { Principal, ResourceRef } from '../../contracts/principal.js';
import { thrownError } from '../vote.js';
import { entryCovers, firmFieldsOf } from '../support/compare.js';
import { Deadline, EXPIRED } from '../support/deadline.js';
import { newNested } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { DEADLINE_FACTOR, SUMMARY_BATCH } from '../types.js';
import type { Checked, Engine, Run } from '../types.js';
import { modelSummaries, quietCheck } from './checks.js';
import { comparedRefs, summaryCovered, summaryEntries } from './entries.js';
import type { SummaryItem } from './entries.js';

/** covers() once both principals are admitted and every combinator is built in: one deadline for the target's summaries and all comparisons. */
export async function coversAt(engine: Engine, holder: Principal, target: Principal, ref: ResourceRef, defs: readonly PermissionDef[], run: Run): Promise<boolean> {
  const limit = new Deadline(DEADLINE_FACTOR * engine.config.modelTimeoutMs);
  let strict = false;
  try {
    const summarized = await limit.race(modelSummaries(engine, target, ref, defs, { ...run, nested: newNested() }));
    if (summarized === EXPIRED) {
      logAt(engine, 'error', { deadlineMs: limit.ms }, 'Authz domain ${domain}: covers is false: it ran past its deadline of ${deadlineMs} ms');
      return false;
    }
    if (summarized.names === undefined) {
      logAt(engine, 'error', {}, 'Authz domain ${domain}: covers is false: a model routed for the target gave no summary');
      return false;
    }
    const listed = summaryEntries(engine, target, summarized.list, defs, run.instant);
    if (listed === undefined) {
      logAt(engine, 'error', {}, 'Authz domain ${domain}: covers is false: the onBehalfOf chain of the target does not resolve');
      return false;
    }
    for (let i = 0; i < defs.length; i += SUMMARY_BATCH) {
      const batch = defs.slice(i, i + SUMMARY_BATCH);
      const compared = await limit.race(Promise.all(batch.map((def) => Promise.all(comparedRefs(def, ref).map((r) => Promise.all([quietCheck(engine, holder, def, r, run, true), quietCheck(engine, target, def, r, run)]))))));
      if (compared === EXPIRED) {
        logAt(engine, 'error', { deadlineMs: limit.ms }, 'Authz domain ${domain}: covers is false: it ran past its deadline of ${deadlineMs} ms');
        return false;
      }
      const verdict = judge(engine, batch, compared, listed);
      if (verdict === 'refused') return false;
      if (verdict === 'strict') strict = true;
    }
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: covers is false: a check or a field comparison failed');
    return false;
  } finally {
    limit.clear();
  }
  return strict;
}

/** One batch of (holder, target) checks: refused when a pair is faulted or not covered, strict when the holder is strictly above on some pair. */
function judge(engine: Engine, batch: readonly PermissionDef[], compared: readonly (readonly (readonly [Checked, Checked])[])[], listed: ReadonlyMap<Permission, readonly SummaryItem[]>): 'refused' | 'strict' | 'covered' {
  let strict = false;
  for (const [k, pairs] of compared.entries()) {
    const def = batch[k];
    // A denial on missing data is no proof that the target lacks the permission; a holder fault is refused too, to stay simple.
    const fault = pairs.find(([h, t]) => h.faulted || t.faulted);
    if (fault) {
      logAt(engine, 'error', { side: fault[0].faulted ? 'holder' : 'target', permission: def.name }, 'Authz domain ${domain}: covers is false: the ${side} check of ${permission} rests on an engine fault');
      return 'refused';
    }
    // Only the gate denies `unattended`: the target read as another type than when it was admitted.
    if (pairs.some(([h, t]) => t.decision.reason?.code === 'unattended' || !entryCovers(h.decision, t.decision, firmFieldsOf(h)))) return 'refused';
    const entries = listed.get(def.name) ?? [];
    if (entries.some((e) => pairs.some(([h]) => !summaryCovered(engine, h, e, def)))) return 'refused';
    // An entry against a conditional holder is unknown, so it does not make the holder strictly above.
    const blocked = (h: Checked) => entries.some((e) => !e.conditional || h.decision.residual.op !== 'true');
    if (pairs.some(([h, t]) => h.decision.allowed && !entryCovers(t.decision, h.decision) && !blocked(h))) strict = true;
  }
  return strict ? 'strict' : 'covered';
}

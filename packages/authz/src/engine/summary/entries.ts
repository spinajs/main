import type { AccessSummary } from '../../contracts/service.js';
import type { FieldSet } from '../../contracts/decision.js';
import type { ModelSummary } from '../../contracts/model.js';
import type { Permission, PermissionDef } from '../../contracts/permission.js';
import type { Ceiling, Principal, ResourceRef, ResourceType } from '../../contracts/principal.js';
import { GLOBAL } from '../../contracts/resource.js';
import { subtractFieldGlobs, unionFieldGlobs } from '../../contracts/fields.js';
import { ceilingOutcome, readCeiling, scopeCovers } from '../ceiling.js';
import { isObject } from '../internal/util.js';
import { copyData, copyRef, deepFreeze } from '../vote.js';
import { delegationOf } from '../pipeline/delegate.js';
import { firmFieldsOf } from '../support/compare.js';
import { BUILTIN_ALGORITHMS, GLOBAL_TYPE } from '../types.js';
import type { Checked, Engine, Fields } from '../types.js';

/**
 * The summary entries for `defs` by name, under the ceilings of the
 * principal's onBehalfOf resolution (the ones its checks apply); undefined
 * when the resolution throws or denies.
 */
export function summaryEntries(engine: Engine, principal: Principal, list: readonly ModelSummary[], defs: readonly PermissionDef[], instant: Date): Map<Permission, SummaryItem[]> | undefined {
  let ceilings: readonly unknown[];
  try {
    const d = delegationOf(engine, principal, undefined, engine.config.maxDelegation);
    if (d.denial) return undefined;
    ceilings = d.ceilings;
  } catch {
    return undefined;
  }
  const names = new Set(defs.map((d) => d.name));
  const out = new Map<Permission, SummaryItem[]>();
  for (const summary of list) {
    for (const entry of summary.permissions) {
      if (!names.has(entry.name)) continue;
      const kept = underCeilings(ceilings, entry, instant);
      if (kept === undefined) continue;
      const entries = out.get(entry.name);
      if (entries) entries.push(kept);
      else out.set(entry.name, [kept]);
    }
  }
  return out;
}

/** The union of the entries' fields (none listed: every field), less neverRead. Throws AuthzConfigError past the field budget. */
export function listedFields(engine: Engine, entries: readonly SummaryItem[]): Fields {
  const union = (k: 'read' | 'write') => subtractFieldGlobs(unionFieldGlobs(...entries.map((e) => e.fields?.[k] ?? ['*'])), engine.config.neverRead);
  return { read: union('read'), write: union('write') };
}

/**
 * An entry has no residual to compare, so only an unconditional holder
 * covers it, with every field it lists (none listed: every field but
 * neverRead). `hide` only narrows the target, so it is not read.
 */
export function summaryCovered(engine: Engine, holder: Checked, entry: SummaryItem, def: PermissionDef): boolean {
  if (!holder.decision.allowed || holder.decision.residual.op !== 'true') return false;
  if (def.fields !== true) return true;
  const held = firmFieldsOf(holder);
  const inside = (k: 'read' | 'write') => subtractFieldGlobs(subtractFieldGlobs(entry.fields?.[k] ?? ['*'], engine.config.neverRead), held[k]).length === 0;
  return inside('read') && inside('write');
}

/** The first route plan of `defs` at `ref` (at `$global`, also on each type) whose algorithm is not built in. */
export function customPlan(engine: Engine, defs: readonly PermissionDef[], ref: ResourceRef): { readonly def: PermissionDef; readonly type: ResourceType; readonly algorithm: string } | undefined {
  for (const def of defs) {
    for (const r of comparedRefs(def, ref)) {
      const algorithm = engine.table.get(def.name, r.type)?.algorithm;
      if (algorithm !== undefined && !BUILTIN_ALGORITHMS.has(algorithm)) return { def, type: r.type, algorithm };
    }
  }
  return undefined;
}

export function summaryEntry(def: PermissionDef, conditional: boolean, fields: Fields): AccessSummary['permissions'][number] {
  return def.fields === true ? { name: def.name, conditional, fields: { read: [...fields.read], write: [...fields.write] } } : { name: def.name, conditional };
}

export type SummaryItem = ModelSummary['permissions'][number];

/**
 * A summary entry under its principal's ceilings, judged at GLOBAL and
 * `instant`: dropped (undefined) when a ceiling's permissions, expiry or
 * empty resources rule it out, or the ceiling is malformed; conditional
 * when a ceiling's resources lie below GLOBAL.
 */
export function underCeilings(ceilings: readonly unknown[], entry: SummaryItem, instant: Date): SummaryItem | undefined {
  let conditional = entry.conditional;
  for (const raw of ceilings) {
    const read = readCeiling(raw);
    if (!read.ok) return undefined;
    if (read.ceiling === undefined) continue;
    const { resources, ...rest } = read.ceiling;
    if (ceilingOutcome(rest, entry.name, GLOBAL, undefined, instant).denials.length > 0) return undefined;
    if (resources === undefined) continue;
    if (resources.length === 0) return undefined;
    if (!resources.some((r) => scopeCovers(r, GLOBAL))) conditional = true;
  }
  return conditional === entry.conditional ? entry : { ...entry, conditional };
}

/** The refs covers compares a permission on: at `$global`, also each of its types, whose type-level check stands for every row (B06). */
export function comparedRefs(def: PermissionDef, ref: ResourceRef): readonly ResourceRef[] {
  return ref.type === GLOBAL_TYPE ? [ref, ...def.types.map((type) => Object.freeze({ type }))] : [ref];
}

/** A validated copy; a malformed ceiling (every check denies then) is left out. */
export function summaryCeiling(p: Principal): Ceiling | undefined {
  let raw: unknown;
  try {
    raw = p.ceiling;
  } catch {
    return undefined;
  }
  const read = readCeiling(raw);
  return read.ok ? read.ceiling : undefined;
}

/** A frozen engine copy of a model's summary, stamped with the model's name; throws when malformed or over the data budget. */
export function copySummary(raw: unknown, model: string): ModelSummary {
  const data = copyData(raw, true);
  if (!isObject(data) || !Array.isArray(data.permissions)) throw new Error('the summary has no permissions list');
  const permissions = data.permissions.map((p: unknown, i): ModelSummary['permissions'][number] => {
    if (!isObject(p) || typeof p.name !== 'string' || typeof p.conditional !== 'boolean') throw new Error(`permissions[${i}] is not { name, conditional }`);
    if (p.fields === undefined) return { name: p.name, conditional: p.conditional };
    const given = p.fields;
    if (!isObject(given)) throw new Error(`permissions[${i}].fields is not a field set`);
    // Rebuilt: anything else a model puts there would reach the access summary (B25).
    const fields: { -readonly [K in keyof FieldSet]: FieldSet[K] } = {};
    for (const k of ['read', 'write', 'hide'] as const) {
      const globs = given[k];
      if (globs === undefined) continue;
      if (!isStrings(globs)) throw new Error(`permissions[${i}].fields is not a field set`);
      fields[k] = globs as string[];
    }
    return { name: p.name, conditional: p.conditional, fields };
  });
  const out: { -readonly [K in keyof ModelSummary]: ModelSummary[K] } = { model, permissions };
  if (data.roles !== undefined) {
    if (!Array.isArray(data.roles)) throw new Error('roles is not a list');
    out.roles = data.roles.map((r: unknown, i) => {
      const scope = isObject(r) ? copyRef(r.scope) : undefined;
      if (!isObject(r) || typeof r.role !== 'string' || !scope || (r.expiresAt !== undefined && typeof r.expiresAt !== 'string')) throw new Error(`roles[${i}] is not { role, scope, expiresAt? }`);
      return r.expiresAt === undefined ? { role: r.role, scope } : { role: r.role, scope, expiresAt: r.expiresAt };
    });
  }
  return deepFreeze(out);
}

const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

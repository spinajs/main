import { compareDenyReasons } from '../contracts/decision.js';
import type { DenyReason } from '../contracts/decision.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { AccessPlan, ModelListPlan, PlanTerm } from '../contracts/plan.js';
import type { ResourceRef } from '../contracts/principal.js';
import { VoteFault, budget, copyData, deepFreeze, validDate } from './vote.js';
import type { Budget } from './vote.js';

/** Values copied from one model's plan: an RBAC term carries up to authz.rbac.maxPlanSubjects keys. */
const MAX_PLAN_VALUES = 100_000;

export interface PlanAnswer {
  readonly model: string;
  readonly plan: ModelListPlan;
}

type FilterPlan = Extract<AccessPlan, { readonly kind: 'filter' }>;

export const ALL_PLAN: AccessPlan = Object.freeze({ kind: 'filter', permit: 'all', deny: Object.freeze([]) });
export const NO_ACCESS: DenyReason = Object.freeze({ code: 'no_access' });
export const CEILING_DENIAL: DenyReason = Object.freeze({ code: 'ceiling', priority: 200 });
const ABSTAIN: ModelListPlan = Object.freeze({ kind: 'abstain' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export function nonePlan(reason: DenyReason): AccessPlan {
  return deepFreeze({ kind: 'none', reason: { ...reason } });
}

/** Deny-overrides over the models' plans (resource-access plan decision 8); H16: no permit at all is `none`. */
export function combinePlans(answers: readonly PlanAnswer[], bounds: { readonly within?: readonly ResourceRef[]; readonly validUntil?: Date } = {}): AccessPlan {
  const denials: DenyReason[] = [];
  const permit: PlanTerm[] = [];
  const deny: PlanTerm[] = [];
  const until: (Date | undefined)[] = [bounds.validUntil];
  let all = false;
  for (const { model, plan } of answers) {
    switch (plan.kind) {
      case 'deny-all':
        denials.push(plan.reason.model === undefined ? { ...plan.reason, model } : plan.reason);
        break;
      case 'all':
        all = true;
        deny.push(...(plan.deny ?? []));
        until.push(plan.validUntil);
        break;
      case 'terms':
        permit.push(...plan.permit);
        deny.push(...plan.deny);
        until.push(plan.validUntil);
        break;
      case 'abstain':
        break;
    }
  }
  if (denials.length > 0) return nonePlan(denials.sort(compareDenyReasons)[0]);
  if (!all && permit.length === 0) return nonePlan(NO_ACCESS);
  const out: { -readonly [K in keyof FilterPlan]: FilterPlan[K] } = { kind: 'filter', permit: all ? 'all' : permit, deny };
  if (bounds.within !== undefined) out.within = bounds.within.map((r) => ({ ...r }));
  const validUntil = earliest(until);
  if (validUntil !== undefined) out.validUntil = validUntil;
  // Terms are shared with the answers, not copied: readModelPlan already froze them, so this only walks them.
  return deepFreeze(out);
}

/** A frozen copy of what a model's listPlan returned; throws VoteFault when it is not a ModelListPlan of plain data. */
export function readModelPlan(raw: unknown): ModelListPlan {
  if (!isObject(raw)) throw new VoteFault(`a list plan must be an object, got ${raw === null ? 'null' : typeof raw}`);
  const kind = raw.kind;
  const values = budget(MAX_PLAN_VALUES);
  switch (kind) {
    case 'abstain':
      return ABSTAIN;
    case 'all': {
      const plan: ModelListPlan = { kind: 'all', ...(raw.deny === undefined ? {} : { deny: readTerms(raw.deny, 'deny', values) }), ...until(raw.validUntil) };
      return Object.freeze(plan);
    }
    case 'deny-all': {
      const reason = raw.reason;
      if (!isObject(reason) || typeof reason.code !== 'string' || reason.code === '') throw new VoteFault('a deny-all plan needs a reason with a non-empty code');
      const plan: ModelListPlan = { kind: 'deny-all', reason: copyData(reason, true, values) as DenyReason };
      return Object.freeze(plan);
    }
    case 'terms': {
      const plan: ModelListPlan = { kind: 'terms', permit: readTerms(raw.permit, 'permit', values), deny: readTerms(raw.deny, 'deny', values), ...until(raw.validUntil) };
      return Object.freeze(plan);
    }
    default:
      throw new VoteFault(`unknown list plan kind ${typeof kind === 'string' ? JSON.stringify(kind) : typeof kind}`);
  }
}

/** A ceiling's restriction as one `within` list: undefined when it restricts nothing, null when it is not one `under` (two resource ceilings intersect). */
export function withinOf(restrict: ResourceFilter): readonly ResourceRef[] | undefined | null {
  if (restrict.op === 'true') return undefined;
  if (restrict.op === 'under') return restrict.scopes;
  return null;
}

function until(v: unknown): { readonly validUntil?: Date } {
  if (v === undefined) return {};
  const date = validDate(v);
  if (date === undefined) throw new VoteFault('validUntil must be a valid Date');
  return { validUntil: date };
}

function readTerms(v: unknown, what: string, values: Budget): readonly PlanTerm[] {
  if (!Array.isArray(v)) throw new VoteFault(`${what} must be an array of terms`);
  return Object.freeze(
    v.map((term: unknown) => {
      if (!isObject(term) || typeof term.op !== 'string' || term.op === '') throw new VoteFault(`${what} holds a term without an op`);
      return Object.freeze({ op: term.op, args: copyData(term.args, true, values) });
    }),
  );
}

function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) if (d !== undefined && (best === undefined || d.getTime() < best.getTime())) best = d;
  return best === undefined ? undefined : validDate(best);
}

import { quote } from '@spinajs/util';
import { FALSE, TRUE, and } from '../../contracts/filter.js';
import type { ResourceFilter } from '../../contracts/filter.js';
import type { DenyReason, TraceStep, Vote } from '../../contracts/decision.js';
import type { AuthorizationModel } from '../../contracts/model.js';
import type { PermissionDef } from '../../contracts/permission.js';
import { principalKey } from '../../contracts/principal.js';
import type { Principal, PrincipalRef, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import type { CheckInput } from '../../contracts/service.js';
import type { CeilingOutcome } from '../ceiling.js';
import { ModelContext } from '../context.js';
import { stripPrincipalOps } from '../delegation.js';
import type { Delegation } from '../delegation.js';
import { evaluateResidual } from '../evaluate.js';
import type { Truth } from '../evaluate.js';
import { staticTruths } from '../reasons.js';
import type { RouteTable } from '../routes.js';
import { settleWithin } from '../run.js';
import type { Pipeline, Settled } from '../run.js';
import { describeError } from '../vote.js';
import { markFault, remember, scopeFaulted } from '../cache/store.js';
import { hostFor } from '../context/host.js';
import { envOf, requestOf, subjectEnv } from '../context/request.js';
import { admits, contextCacheKey, earliest, mergeRoles } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import type { RefBinder } from '../support/ref-binder.js';
import { watchEnv, watchRequest } from '../support/reads.js';
import { DELEGATE_PRIORITY, ENGINE_FAULT, NO_FIELDS } from '../types.js';
import type { Checked, Combined, Engine, Fields, Finish, Outcome, Parties, Run } from '../types.js';
import { bind, fieldsOf, refBinder } from './bind.js';
import { ceilingOf, delegateCheck } from './delegate.js';
import { finish } from './finish.js';
import { denyReason, subjectTruths } from './reasons.js';
import { combine, evaluate, resolveScopeRefs } from './vote.js';

type RoutePlan = NonNullable<ReturnType<RouteTable['get']>>;

export type Core = (step: string, note: string, data?: unknown) => void;

/** A check past its resource step. */
export interface Head {
  readonly run: Run;
  readonly explain: boolean;
  readonly steps: TraceStep[] | undefined;
  readonly core: Core;
  readonly def: PermissionDef;
  readonly ref: ResourceRef;
  readonly subject: unknown;
  readonly plan: RoutePlan;
  readonly base: Omit<Finish, 'requester' | 'system'>;
}

/** A check the gate, the delegation and the caches let through to the models. */
export interface Admitted extends Head {
  readonly principal: Principal;
  readonly requester: PrincipalRef;
  readonly delegation: Delegation;
  readonly parties: Parties;
  readonly key: string | undefined;
  readonly ancestors: readonly ResourceRef[] | undefined;
  readonly tags: () => readonly string[] | undefined;
}

export interface Voted extends Admitted {
  readonly ceiling: CeilingOutcome;
  /** The intersect delegate's own check. */
  readonly delegated: Checked | undefined;
  readonly models: readonly AuthorizationModel[];
  readonly contexts: readonly ModelContext[];
  readonly label: string;
  readonly binder: RefBinder;
  readonly voteLoads: { degraded: boolean };
  readonly votes: readonly Vote[];
  /** Core contexts handed to native filters during the subject steps. */
  readonly cores: ModelContext[];
}

export interface Combination {
  readonly combined: Combined;
  readonly bound: { readonly failed: boolean; readonly degraded: boolean; readonly uncacheable: boolean };
  readonly residual: ResourceFilter;
  readonly coreDenials: readonly DenyReason[];
  readonly subjectFault: boolean;
  /** The subject itself denied. */
  readonly subjectDenied: boolean;
  readonly typeLevel: Checked | undefined;
}

export interface FieldsStep {
  readonly allowed: boolean;
  readonly residual: ResourceFilter;
  readonly fields: Fields;
  readonly firmFields: Fields | undefined;
  readonly failed: boolean;
  readonly uncacheable: boolean;
  readonly faulted: boolean;
}

/** Ceiling, the intersect delegate's check, then the models (steps 7-9). */
export function* vote(engine: Engine, a: Admitted, input: CheckInput): Pipeline<Voted> {
  const { run, def, ref, subject, core, parties, delegation, plan } = a;
  if (parties.principal !== a.principal) core('delegation', `inherit: the models run as ${principalKey(parties.ref)}`);
  // Before the models: a model receives the principal and must not be able to move what the ceiling reads.
  const ceiling = ceilingOf(delegation, def, ref, a.ancestors, run.instant);
  const env = watchEnv(run.reads, envOf(engine, input.env, run.instant));
  const delegated = delegation.intersect === undefined ? undefined : yield* delegateCheck(engine, delegation.intersect, delegation.hopsUsed, def, ref, subject, input.env, run);
  const delegate = delegated?.decision;
  if (delegate) core('delegation', `intersect: the delegate ${delegation.intersectKey} is ${delegate.allowed ? 'allowed' : 'denied'}`, { residual: delegate.residual });

  const models = plan.models.filter((m) => {
    const admitted = admits(m, parties.principal);
    if (!admitted) core('skip', `model ${quote(m.name)} does not serve principal type ${quote(parties.principal.type)}`);
    return admitted;
  });
  core('route', `${plan.algorithm} over ${models.length} model(s)`, { models: models.map((m) => m.name) });
  const host = hostFor(engine, run);
  const contexts = models.map((m) => new ModelContext(host, m.name, run.scope, run.instant, run.depth, a.steps, contextCacheKey(m.name, parties.cacheId), run.reads));
  const request = () => watchRequest(run.reads, requestOf(engine, parties, def, ref, subject, input.env, run.instant, a.explain, run.fresh === true));
  const label = `${def.name} on ${resourceKey(ref)}`;
  const binder = refBinder(engine, parties, env, a.ancestors, run);
  const voteLoads = { degraded: false };
  const resolve = (vs: readonly Vote[]) => resolveScopeRefs(engine, vs, binder, label, voteLoads);
  const votes = yield* evaluate(engine, models, contexts, request, plan.algorithm, a.explain, run, label, resolve, parties.cacheId);
  return { ...a, ceiling, delegated, models, contexts, label, binder, voteLoads, votes, cores: [] };
}

/** Steps 10-12: combine, bind, AND the intersect delegate's residual, then the subject. */
export function* combineVotes(engine: Engine, v: Voted, input: CheckInput): Pipeline<Combination> {
  const combined = combine(engine, v.plan.algorithm, v.votes);
  const allow = v.ceiling.denials.length > 0 ? FALSE : and(combined.allow, v.ceiling.restrict);
  const bound = yield* bind(engine, allow, v.binder);
  const coreDenials: DenyReason[] = [...v.ceiling.denials];
  const intersected = v.delegated ? yield* intersect(engine, v, v.delegated, input, bound.residual, coreDenials) : { residual: bound.residual, fault: false, typeLevel: undefined };
  const residual = intersected.residual;
  v.core('combine', `allow ${residual.op === 'true' ? 'TRUE' : residual.op === 'false' ? 'FALSE' : 'residual'}`, { residual });
  const subjected = yield* subjectStep(engine, v, residual);
  return { combined, bound, coreDenials, residual: subjected.residual, subjectFault: intersected.fault || subjected.fault, subjectDenied: subjected.denied, typeLevel: intersected.typeLevel };
}

function* intersect(engine: Engine, v: Voted, delegated: Checked, input: CheckInput, residual: ResourceFilter, coreDenials: DenyReason[]): Pipeline<{ readonly residual: ResourceFilter; readonly fault: boolean; readonly typeLevel: Checked | undefined }> {
  const delegate = delegated.decision;
  const strips = v.delegation.intersectKey !== principalKey(v.parties.ref);
  // The delegate's residual is already bound for the delegate; SQL and the subject evaluator would read its principal ops as ours.
  // A kept principalInArgs native is evaluated below and in SQL with our principal, context and ctx.cache: right only because its args name the delegate and the filter keys its memos by them.
  let theirs = !delegate.allowed ? FALSE : strips ? stripPrincipalOps(delegate.residual, engine.argBoundNatives) : delegate.residual;
  let fault = false;
  let typeLevel: Checked | undefined;
  if (strips && v.subject !== undefined && delegate.allowed && residual.op !== 'false') {
    // The filter strips the delegate's relation ops and its natives without principalInArgs, which the subject check above evaluated exactly: the row must also pass the stripped type-level residual, or filter and check part (B06).
    const level = yield* typeLevelHolds(engine, v, input);
    typeLevel = level.typeLevel;
    fault = level.fault;
    if (!level.holds) theirs = FALSE;
  }
  if (theirs.op === 'false') coreDenials.push(Object.freeze({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: v.delegation.intersectKey }));
  return { residual: and(residual, theirs), fault, typeLevel };
}

function* typeLevelHolds(engine: Engine, v: Voted, input: CheckInput): Pipeline<{ readonly holds: boolean; readonly fault: boolean; readonly typeLevel: Checked }> {
  const typeLevel = yield* delegateCheck(engine, v.delegation.intersect!, v.delegation.hopsUsed, v.def, { type: v.ref.type }, undefined, input.env, v.run);
  const strip = typeLevel.decision.allowed ? stripPrincipalOps(typeLevel.decision.residual, engine.argBoundNatives) : FALSE;
  let truth: string = !typeLevel.decision.allowed ? 'the delegate is denied' : strip.op === 'true' ? 'TRUE' : 'FALSE';
  let holds = strip.op === 'true';
  let fault = false;
  if (strip.op !== 'true' && strip.op !== 'false') {
    const settled = (yield settleWithin(evaluateResidual(strip, v.subject, subjectEnv(engine, v.parties, v.ref, v.run, v.steps, v.cores)), engine.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
    if (!settled.ok) {
      fault = true;
      logAt(engine, 'error', { delegate: v.delegation.intersectKey, check: v.label, cause: settled.error }, 'Authz domain ${domain}: evaluating the stripped type-level residual of the delegate ${delegate} of ${check} against the subject failed: ${cause}');
    }
    const value = settled.ok ? (settled.value as Truth) : undefined;
    holds = value === true;
    truth = settled.ok ? (value === undefined ? 'UNKNOWN' : String(value)) : settled.error;
  }
  v.core('delegation', `intersect: the delegate's type-level residual, stripped, against the subject: ${truth}`, { residual: strip });
  return { holds, fault, typeLevel };
}

function* subjectStep(engine: Engine, v: Voted, residual: ResourceFilter): Pipeline<{ readonly residual: ResourceFilter; readonly fault: boolean; readonly denied: boolean }> {
  if (v.subject === undefined || residual.op === 'true' || residual.op === 'false') return { residual, fault: false, denied: false };
  const settled = (yield settleWithin(evaluateResidual(residual, v.subject, subjectEnv(engine, v.parties, v.ref, v.run, v.steps, v.cores)), engine.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
  const truth = settled.ok ? (settled.value as Truth) : undefined;
  if (!settled.ok) logAt(engine, 'error', { check: v.label, cause: settled.error }, 'Authz domain ${domain}: evaluating the residual of ${check} against the subject failed: ${cause}');
  v.core('subject', `residual against the subject: ${settled.ok ? (truth === undefined ? 'UNKNOWN' : String(truth)) : settled.error}`);
  return { residual: truth === true ? TRUE : FALSE, fault: !settled.ok, denied: truth !== true };
}

/** Step 13: an allow's field sets; a failed combination denies. */
export function* fieldsStep(engine: Engine, v: Voted, c: Combination): Pipeline<FieldsStep> {
  const firm = v.run.firm === true;
  const none: FieldsStep = { allowed: c.residual.op !== 'false', residual: c.residual, fields: NO_FIELDS, firmFields: firm ? NO_FIELDS : undefined, failed: false, uncacheable: false, faulted: false };
  if (!none.allowed) return none;
  const delegate = v.delegated?.decision;
  const firmDelegate = v.delegated?.firmFields ?? delegate?.fields;
  const f = yield* fieldsOf(engine, v.plan.algorithm, v.votes, v.binder, delegate?.fields, v.label, firm ? (firmDelegate ? { delegate: firmDelegate } : {}) : undefined);
  if (f.failed) {
    v.core('fields', 'combining the field sets failed: denied');
    return { ...none, allowed: false, residual: FALSE, failed: true, uncacheable: f.uncacheable, faulted: f.faulted };
  }
  return { ...none, fields: f.fields, firmFields: firm ? (f.firm ?? NO_FIELDS) : undefined, uncacheable: f.uncacheable, faulted: f.faulted };
}

/** Step 14: the deny reason. */
export function* reasonStep(engine: Engine, v: Voted, c: Combination, f: FieldsStep): Pipeline<Reason> {
  // The allow held up to the fields step, so no vote or core step caused this denial.
  if (f.failed) return { reason: ENGINE_FAULT, uncacheable: false };
  if (f.allowed) return { reason: undefined, uncacheable: false };
  // Also when the allow was FALSE before the subject step: a row-level deny entry may still beat a ceiling.
  const pass = v.subject !== undefined && !c.subjectFault ? yield* subjectTruths(engine, v.votes, c.combined.deciding, v.plan.algorithm, v.subject, v.binder, v.parties, v.ref, v.run, v.label, v.core, v.cores) : { truths: v.votes.map(staticTruths), uncacheable: false };
  return { reason: denyReason(c.coreDenials, v.votes, pass.truths, c.combined.deciding, v.plan.algorithm, c.subjectDenied && !c.subjectFault, c.combined.failed || c.bound.failed || c.subjectFault), uncacheable: pass.uncacheable };
}

type Reason = { readonly reason: DenyReason | undefined; readonly uncacheable: boolean };

/** Step 15: the outcome, its fault and cache marks, finish and the store. */
export function conclude(engine: Engine, v: Voted, c: Combination, f: FieldsStep, r: Reason): Checked {
  const outcome = outcomeOf(v, c, f, r);
  const faulted = faultedOf(engine, v, c, f);
  if (faulted) markFaulted(engine, v);
  const uncacheable = faulted || uncacheableOf(v, c, f, r);
  return remember(engine, { decision: finish(engine, { ...v.base, requester: v.requester }, outcome), uncacheable, faulted, ...(f.firmFields ? { firmFields: f.firmFields } : {}) }, v.key, v.run, v.tags);
}

function outcomeOf(v: Voted, c: Combination, f: FieldsStep, r: Reason): Outcome {
  const outcome: { -readonly [K in keyof Outcome]: Outcome[K] } = { principal: v.parties.ref, residual: f.allowed ? f.residual : FALSE, roles: mergeRoles(v.votes), fields: f.fields, models: v.models.map((m) => m.name), votes: v.votes };
  if (v.parties.actorRef) outcome.actor = v.parties.actorRef;
  if (r.reason) outcome.reason = r.reason;
  const validUntil = earliest([...v.votes.map((x) => x.validUntil), v.ceiling.expiresAt, v.delegated?.decision.validUntil, c.typeLevel?.decision.validUntil]);
  if (validUntil) outcome.validUntil = validUntil;
  return outcome;
}

function faultedOf(engine: Engine, v: Voted, c: Combination, f: FieldsStep): boolean {
  return v.votes.some((x) => x.error !== undefined) || v.voteLoads.degraded || c.combined.failed || c.bound.failed || c.bound.degraded || c.subjectFault || f.faulted || v.delegated?.faulted === true || c.typeLevel?.faulted === true || v.run.nested.faulted || scopeFaulted(engine, v.run.scope);
}

function markFaulted(engine: Engine, v: Voted): void {
  v.run.nested.faulted = true;
  // A model may memoise a nested answer in ctx.cache; the marker stops later checks of the request trusting it.
  if (v.run.depth > 0) markFault(engine, v.run.scope);
  // A marker here would fail every later summary/covers of the request; dropping the memos this decision wrote is enough.
  else for (const ctx of [...v.contexts.slice(0, v.votes.length), ...v.cores]) ctx.detachMemo();
}

function uncacheableOf(v: Voted, c: Combination, f: FieldsStep, r: Reason): boolean {
  return c.bound.uncacheable || f.uncacheable || r.uncacheable || v.delegated?.uncacheable === true || c.typeLevel?.uncacheable === true || v.votes.some((x) => x.cacheable !== true) || v.run.nested.uncacheable;
}

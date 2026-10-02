import { strict as assert } from 'node:assert';
import * as fc from 'fast-check';

import { PermissionRegistry, compareDenyReasons, isPermission, resourceKey, simplify } from '@spinajs/authz';
import type { AuthorizationModel, DecisionRequest, DenyReason, EvaluationContext, NativeFilter, Permission, PermissionDef, Principal, RelationResolver, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { fakeEvaluationContext, fakeModelInitContext } from '../context.js';
import type { FakeEvaluationContextOptions, FakeModelInitContext } from '../context.js';
import { evaluateFilter } from '../filter-eval.js';
import type { Kleene } from '../filter-eval.js';
import type { FakeAdapter } from '../fakes/adapter.js';
import { FakePermissionRegistry } from '../registry.js';
import type { FakePermissionInput } from '../registry.js';
import { CONFORMANCE_NOW, check, describeRequest, fail, identityOrder, isFilterOp, isThenable, opsOf, pick, property, show, shuffler } from './common.js';
import type { ConformanceCheck } from './common.js';

/** A concrete resource of the world and the loaded row the residuals are evaluated against. */
export interface WorldRow {
  readonly ref: ResourceRef;
  readonly subject: unknown;
}

export interface ModelWorld {
  /** Who asks. Add principals outside `capabilities.principalTypes` to test that claim. */
  readonly principals: readonly Principal[];
  /**
   * Requests made by `actor` for `principal` (under 'inherit' delegation the principal is the delegate),
   * sampled next to `principals`. For models that read `req.actor` or emit 'actor.*' refs.
   */
  readonly actors?: readonly (readonly [principal: Principal, actor: Principal])[];
  /** Permissions asked about; each must be registered, in `context.permissions` or by the model's init. */
  readonly permissions: readonly Permission[];
  /** Concrete resources (`worldRows(adapter)` for a FakeAdapter); type-level requests are asked on their types. */
  readonly rows: readonly WorldRow[];
  /**
   * Options of every request's context. `permissions` should be a list of inputs (a registry object is
   * shared, so a model that registers permissions would register them twice); `now` defaults to
   * CONFORMANCE_NOW. Native filters and relations the model registers in init are added.
   */
  readonly context?: FakeEvaluationContextOptions;
  /** Builds a request's context from those options; default fakeEvaluationContext. */
  readonly buildContext?: (opts: FakeEvaluationContextOptions) => EvaluationContext;
  readonly env?: Readonly<Record<string, unknown>>;
  /** The model's config section (`authz.<model>.*`), handed to init. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * A change to the model's data (assignment, tuple, policy) and a probe whose answer it flips.
 * Freshness is what the model promises:
 * - 'live': the probe answers anew as soon as `apply` resolves;
 * - 'version': `version()` changes and the probe answers anew (the host recompiles routes);
 * - 'invalidate': the probe may stay stale until the host calls `invalidate(tags)`.
 * The suite calls `invalidate(tags)` after each change as a host would, and the answer must stay fresh.
 * After the change and its freshness step, every principal × route × row must answer as a second setup of
 * the same seed where the suite applied the change before init; so `apply` must also work on a model that
 * is not initialised yet, and that setup's probe must give `after`. A change to what `applies` routes needs
 * 'version': the suite recompiles the routes only then, as the host does.
 */
export interface ModelMutation {
  readonly title: string;
  /**
   * A concrete request with its subject; `allowed` is the vote's residual evaluated against
   * `request.subject` (for a model without 'permit': not denied). It is also asked in a context preloaded
   * for its principal when the model has `preload`. The type-level residual of the same principal and
   * permission must give the same answer on that row, in both contexts.
   */
  readonly request: Omit<DecisionRequest, 'explain'>;
  /** `allowed` after the change; before it the probe must answer the opposite. */
  readonly after: boolean;
  apply(): void | Promise<void>;
  readonly tags?: readonly string[];
  readonly freshness: 'live' | 'version' | 'invalidate';
}

export interface ModelSetup {
  /** A fresh model: the suite calls init, and dispose when done. */
  readonly model: AuthorizationModel;
  readonly world: ModelWorld;
  readonly mutations?: readonly ModelMutation[];
  /** Releases what the setup owns besides the model (stores, connections); called after `model.dispose`. */
  dispose?(): void | Promise<void>;
}

export interface ModelFactoryInput<S> {
  readonly seed: S;
  /** Load order of the model's data (tuples, rules, policies, assignments); the suite compares two orders. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * Must be deterministic for a given seed and order: some checks build the same setup more than once.
 * The determinism check holds two setups of one seed at once, so setups must not share mutable stores.
 */
export type ModelFactory<S = undefined> = (input: ModelFactoryInput<S>) => ModelSetup | Promise<ModelSetup>;

export type ModelCheckId = 'capabilities' | 'init' | 'votes' | 'sync' | 'agreement' | 'invalidate' | 'determinism';

export interface ModelConformanceOptions<S = undefined> {
  /** Random worlds; default one world (seed undefined). Required when the factory takes a seed. */
  readonly seeds?: fc.Arbitrary<S>;
  /** Runs per property, default 25 (10 at most for the checks that do not sample requests). */
  readonly numRuns?: number;
  /** Requests sampled per run, default 12. */
  readonly samples?: number;
  /** fast-check seed, for replaying a failure. */
  readonly seed?: number;
  /**
   * Indeterminate votes (`error`, a throw): 'forbid' (default) fails the votes check on any; 'allow'
   * accepts them as failing closed (design §7), for models that really give up, such as FakeTupleModel
   * past maxDepth. A `needs_subject` vote is not indeterminate: its residuals are a partial answer.
   */
  readonly indeterminate?: 'allow' | 'forbid';
  /** Checks registered as pending. */
  readonly skip?: readonly ModelCheckId[];
  /** Mocha timeout per check, default 20000 ms. */
  readonly timeoutMs?: number;
}

/** The rows of a FakeAdapter as world rows. */
export function worldRows(adapter: FakeAdapter): WorldRow[] {
  return adapter.types.flatMap((type) => adapter.all(type).map((subject) => ({ ref: { type, id: subject.id }, subject })));
}

interface Route {
  readonly permission: Permission;
  readonly def: PermissionDef;
  readonly type: ResourceType;
  readonly rows: readonly WorldRow[];
}

/** Who asks: a principal, and the actor when someone else made the request. */
interface Asker {
  readonly principal: Principal;
  readonly actor?: Principal;
}

interface Prepared {
  readonly model: AuthorizationModel;
  readonly world: ModelWorld;
  readonly askers: readonly Asker[];
  readonly mutations: readonly ModelMutation[];
  readonly registry: PermissionRegistry;
  readonly init: FakeModelInitContext;
  readonly natives: readonly NativeFilter[];
  readonly relations: readonly RelationResolver[];
  readonly routes: readonly Route[];
  readonly types: readonly ResourceType[];
  /** allows(), or for a model without 'permit', which never allows on its own: definite and not denied. */
  allowed(a: Answer): boolean;
  context(): EvaluationContext;
  attribute(type: ResourceType): ((subject: unknown, field: string) => unknown) | undefined;
}

type Outcome = { readonly vote: Vote } | { readonly thrown: unknown };

/**
 * A vote read on one row. 'partial': a `needs_subject` vote without the subject; the engine combines its
 * residuals as they are (B19), so they count, but may be narrower than the answer with the subject.
 */
type Answer = { readonly kind: 'indeterminate'; readonly why: string; readonly reasons: readonly DenyReason[] } | { readonly kind: 'definite' | 'partial'; readonly permit: Kleene; readonly deny: Kleene; readonly denies: readonly Kleene[]; readonly reasons: readonly DenyReason[] };

const permitted = (a: Answer): boolean => a.kind !== 'indeterminate' && a.permit === true;
const denied = (a: Answer): boolean => a.kind !== 'indeterminate' && a.deny !== false;
const allows = (a: Answer): boolean => permitted(a) && !denied(a);

const showAnswer = (a: Answer): string => (a.kind === 'indeterminate' ? `indeterminate (${a.why})` : `${a.kind === 'partial' ? 'needs_subject, ' : ''}permit ${a.permit}, deny ${a.deny}`);

function routesOf(model: AuthorizationModel, registry: PermissionRegistry, world: ModelWorld, types: readonly ResourceType[]): Route[] {
  const routes: Route[] = [];
  for (const permission of world.permissions) {
    const def = registry.get(permission);
    check(def, `world permission ${permission} is not registered (context.permissions or the model's init)`);
    for (const type of types) {
      if (def.types.includes(type) && model.applies(def, type)) routes.push({ permission, def, type, rows: world.rows.filter((r) => r.ref.type === type) });
    }
  }
  return routes;
}

const routeName = (r: Route): string => `${r.permission} on ${r.type}`;

function sameRoutes(a: readonly Route[], b: readonly Route[], aName: string, bName: string, where: string): void {
  const as = new Set(a.map(routeName));
  const bs = new Set(b.map(routeName));
  for (const r of as) check(bs.has(r), () => `${where}${r} is routed in ${aName} and not in ${bName}`);
  for (const r of bs) check(as.has(r), () => `${where}${r} is routed in ${bName} and not in ${aName}`);
}

async function prepare(setup: ModelSetup): Promise<Prepared> {
  const { model, world } = setup;
  const given = world.context?.permissions;
  const registry = given instanceof PermissionRegistry ? given : new FakePermissionRegistry((given ?? []) as readonly FakePermissionInput[]);
  const init = fakeModelInitContext({ permissions: registry, config: world.config, model: model.name, domain: world.context?.domain });
  await model.init(init);

  const natives = [...(world.context?.nativeFilters ?? []), ...init.registered.nativeFilters];
  const relations = [...(world.context?.relations ?? []), ...init.registered.relations];
  const options: FakeEvaluationContextOptions = { ...world.context, permissions: registry, nativeFilters: natives, relations, now: world.context?.now ?? CONFORMANCE_NOW };
  const build = world.buildContext ?? fakeEvaluationContext;

  const types = [...new Set(world.rows.map((r) => r.ref.type))];
  const routes = routesOf(model, registry, world, types);

  const adapters = world.context?.adapters ?? [];
  return {
    model,
    world,
    askers: [...world.principals.map((principal) => ({ principal })), ...(world.actors ?? []).map(([principal, actor]) => ({ principal, actor }))],
    mutations: setup.mutations ?? [],
    registry,
    init,
    natives,
    relations,
    routes,
    types,
    allowed: model.capabilities.effects.includes('permit') ? allows : (a) => a.kind !== 'indeterminate' && !denied(a),
    context: () => build(options),
    attribute: (type) => {
      const adapter = adapters.find((a) => a.types.includes(type));
      return adapter?.attribute ? (s, f) => adapter.attribute!(s, f) : undefined;
    },
  };
}

async function withSetup<S>(factory: ModelFactory<S>, input: ModelFactoryInput<S>, fn: (p: Prepared) => Promise<void>): Promise<void> {
  const setup = await factory(input);
  try {
    await fn(await prepare(setup));
  } finally {
    await release(setup);
  }
}

async function release(setup: ModelSetup): Promise<void> {
  try {
    await setup.model.dispose?.();
  } finally {
    await setup.dispose?.();
  }
}

async function ask(p: Prepared, req: DecisionRequest, ctx: EvaluationContext = p.context()): Promise<Outcome> {
  try {
    return { vote: await p.model.evaluate(req, ctx) };
  } catch (e) {
    return { thrown: e };
  }
}

const reasonCodes = (v: Vote): string[] => [...(v.reason ? [v.reason.code] : []), ...(v.denies ?? []).map((d) => d.reason?.code)];

// Kleene, as the engine must read it (D-F5-5): UNKNOWN does not allow.
async function oracle(p: Prepared, f: ResourceFilter, who: Asker, row: WorldRow, ctx: EvaluationContext): Promise<Kleene> {
  return evaluateFilter(f, row.subject, { principal: who.principal, ...(who.actor ? { actor: who.actor } : {}), ref: row.ref, env: p.world.env, context: ctx, nativeFilters: p.natives, attribute: p.attribute(row.ref.type) });
}

/** The vote's answer for one row: residuals evaluated by the kit oracle against the row's subject. */
async function answer(p: Prepared, outcome: Outcome, who: Asker, row: WorldRow, withSubject: boolean): Promise<Answer> {
  if ('thrown' in outcome) {
    const e = outcome.thrown;
    return { kind: 'indeterminate', why: `threw ${e instanceof Error ? e.message : String(e)}`, reasons: [] };
  }
  const v = outcome.vote;
  if (v.error !== undefined) return { kind: 'indeterminate', why: `error ${v.error}`, reasons: v.reason ? [v.reason] : [] };

  const ctx = p.context();
  const permit = await oracle(p, v.permitWhen, who, row, ctx);
  const deny = await oracle(p, v.denyWhen, who, row, ctx);
  const denies: Kleene[] = [];
  for (const d of v.denies ?? []) denies.push(await oracle(p, d.when, who, row, ctx));
  const reasons = (v.denies ?? []).filter((_, i) => denies[i] === true).map((d) => d.reason);
  if (permit !== true && v.reason) reasons.push(v.reason);
  const kind = !withSubject && reasonCodes(v).includes('needs_subject') ? 'partial' : 'definite';
  return { kind, permit, deny, denies, reasons };
}

const lowest = (reasons: readonly DenyReason[]): DenyReason | undefined => [...reasons].sort(compareDenyReasons)[0];

interface Sample {
  readonly who: Asker;
  readonly route: Route;
  readonly row: WorldRow;
}

const sampleArb = (samples: number) => fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { minLength: 1, maxLength: samples });

function samplesOf(p: Prepared, picks: readonly (readonly [number, number, number])[]): Sample[] {
  check(p.askers.length > 0, 'the world has no principals');
  check(p.routes.length > 0, 'no (permission, type) of the world is routed to the model: the suite has nothing to ask');
  return picks.map(([i, j, k]) => {
    const route = pick(p.routes, j);
    return { who: pick(p.askers, i), route, row: pick(route.rows, k) };
  });
}

function typeLevelRequest(p: Prepared, who: Asker, permission: Permission, type: ResourceType): DecisionRequest {
  return { principal: who.principal, ...(who.actor ? { actor: who.actor } : {}), permission, resource: { type }, ...(p.world.env ? { env: p.world.env } : {}) };
}

function requests(p: Prepared, s: Sample): { typeLevel: DecisionRequest; concrete: DecisionRequest; withSubject: DecisionRequest } {
  const base = { principal: s.who.principal, ...(s.who.actor ? { actor: s.who.actor } : {}), permission: s.route.permission, ...(p.world.env ? { env: p.world.env } : {}) };
  return {
    typeLevel: { ...base, resource: { type: s.route.type } },
    concrete: { ...base, resource: s.row.ref },
    withSubject: { ...base, resource: s.row.ref, subject: s.row.subject },
  };
}

function voteHonesty(p: Prepared, v: Vote, req: DecisionRequest): void {
  const cap = p.model.capabilities;
  const where = describeRequest(req);
  check(v !== null && typeof v === 'object', `${where}: evaluate gave ${show(v)}, not a vote`);
  check(v.model === p.model.name, `${where}: vote.model is ${JSON.stringify(v.model)}, the model is ${JSON.stringify(p.model.name)}`);
  check(typeof v.cacheable === 'boolean', `${where}: vote.cacheable is not a boolean`);

  const parts: [string, ResourceFilter][] = [['permitWhen', v.permitWhen], ['denyWhen', v.denyWhen], ...(v.denies ?? []).map((d, i): [string, ResourceFilter] => [`denies[${i}].when`, d.when])];
  for (const [name, f] of parts) {
    for (const op of opsOf(f, `${where}: ${name}`)) {
      check(cap.residuals.includes(op as never), () => `${where}: ${name} uses op '${op}', which capabilities.residuals does not declare: ${show(f)}`);
      if (op.startsWith('native:'))
        check(
          p.natives.some((n) => n.op === op),
          `${where}: ${name} uses '${op}', and no NativeFilter is registered for it`,
        );
    }
  }

  if (!cap.effects.includes('deny')) {
    check(simplify(v.denyWhen).op === 'false' && !v.denies?.length, () => `${where}: effects has no 'deny', but the vote denies: ${show({ denyWhen: v.denyWhen, denies: v.denies })}`);
  }
  if (!cap.effects.includes('permit')) {
    check(simplify(v.permitWhen).op === 'false', () => `${where}: effects has no 'permit', but permitWhen is ${show(v.permitWhen)}`);
  }
  for (const d of v.denies ?? []) check(d.reason && typeof d.reason.code === 'string', () => `${where}: a denies entry has no reason code: ${show(d)}`);
  if (!cap.fields) check(v.fields === undefined, () => `${where}: capabilities.fields is false, but the vote carries fields ${show(v.fields)}`);
  else if (v.fields !== undefined) {
    for (const k of ['read', 'write', 'hide'] as const) {
      const list = v.fields[k];
      check(list === undefined || (Array.isArray(list) && list.every((x) => typeof x === 'string')), `${where}: fields.${k} is not a list of field names`);
    }
  }
  if (!cap.needsSubject) check(!reasonCodes(v).includes('needs_subject'), `${where}: needsSubject is false, but the vote says needs_subject`);
  if (v.validUntil !== undefined) check(v.validUntil instanceof Date && !Number.isNaN(v.validUntil.getTime()), `${where}: validUntil is not a valid Date`);

  if (cap.principalTypes) {
    const types = [req.principal.type, ...(req.principal.companions ?? []).map((c) => c.type)];
    if (!types.some((t) => cap.principalTypes!.includes(t))) {
      check(simplify(v.permitWhen).op === 'false' && simplify(v.denyWhen).op === 'false' && !v.denies?.length, () => `${where}: principal types ${types.join(', ')} are outside capabilities.principalTypes, but the vote has an opinion: ${show(v)}`);
    }
  }
}

/**
 * B is at least as informed as A (type-level < concrete < concrete with subject).
 * - B indeterminate: A must not allow the row, or a list would hold a row the check refuses.
 * - A indeterminate: no constraint (it fails closed).
 * - A partial: permit and deny are checked apart, since under deny-overrides another model's permit
 *   lists a row that A fails to deny: A permits only where B permits, and denies wherever B denies.
 * - B partial, A definite: no constraint here; the pair against the answer with the subject bounds A.
 * - A abstains (permit and deny FALSE): B's permit must not be UNKNOWN. permitted() reads UNKNOWN as
 *   FALSE, but under first-applicable an UNKNOWN permit stops the models after this one, which A lets in.
 * - Both definite: the same permit and deny on the row.
 */
function disagreement(a: Answer, b: Answer): string | undefined {
  if (b.kind === 'indeterminate') return allows(a) ? `the more informed vote is ${showAnswer(b)}, the less informed one allows the row (${showAnswer(a)})` : undefined;
  if (a.kind === 'indeterminate') return undefined;
  if (a.kind === 'definite' && b.kind === 'partial') return undefined;
  if (a.permit === false && a.deny === false && b.permit === null && b.deny === false) return `the less informed vote abstains on the row (${showAnswer(a)}), the more informed one leaves its permit UNKNOWN (${showAnswer(b)}), which under first-applicable stops the models after it`;
  if (a.kind === 'partial') {
    if (permitted(a) && !permitted(b)) return `the less informed vote needs the subject and permits the row (${showAnswer(a)}), the more informed one does not (${showAnswer(b)})`;
    if (denied(b) && !denied(a)) return `the more informed vote denies the row (${showAnswer(b)}), the less informed one needs the subject and does not (${showAnswer(a)})`;
    return undefined;
  }
  return permitted(a) === permitted(b) && denied(a) === denied(b) ? undefined : `${showAnswer(a)} vs ${showAnswer(b)}`;
}

function agree(a: Answer, b: Answer, what: string): void {
  const why = disagreement(a, b);
  check(why === undefined, () => `${what}: ${why}`);
}

const sameAnswer = (x: Answer, y: Answer): boolean => x.kind === y.kind && permitted(x) === permitted(y) && denied(x) === denied(y);

const runs = <S>(opts: ModelConformanceOptions<S>) => ({ numRuns: opts.numRuns ?? 25, seed: opts.seed });
const fewRuns = <S>(opts: ModelConformanceOptions<S>) => ({ numRuns: Math.min(opts.numRuns ?? 25, 10), seed: opts.seed });

function capabilitiesCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'capabilities',
    title: 'capabilities are well-formed and applies keeps to resourceTypes',
    run: () =>
      property(
        'capabilities',
        seeds,
        (seed) =>
          withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            const cap = p.model.capabilities;
            check(typeof p.model.name === 'string' && p.model.name.length > 0, 'the model has no name');
            check(cap && Array.isArray(cap.effects) && cap.effects.every((e) => e === 'permit' || e === 'deny') && new Set(cap.effects).size === cap.effects.length, () => `effects ${show(cap?.effects)} must be distinct 'permit' / 'deny'`);
            check(Array.isArray(cap.residuals) && cap.residuals.every(isFilterOp), () => `residuals ${show(cap.residuals)} must be filter ops (core or native:<name>)`);
            check(['always', 'after-preload', 'never'].includes(cap.sync), `sync ${show(cap.sync)} is not 'always' | 'after-preload' | 'never'`);
            check(typeof cap.fields === 'boolean' && typeof cap.needsSubject === 'boolean', 'fields and needsSubject must be booleans');
            check(cap.principalTypes === undefined || (Array.isArray(cap.principalTypes) && cap.principalTypes.every((t) => typeof t === 'string')), 'principalTypes must be a list of types');
            const rt = cap.resourceTypes;
            check(rt === undefined || rt === '*' || (Array.isArray(rt) && rt.every((t) => typeof t === 'string')), `resourceTypes ${show(rt)} must be '*' or a list of types`);

            const defs = new Map<Permission, PermissionDef>();
            for (const d of [...p.registry.all(), ...p.init.registered.permissions]) defs.set(d.name, d);
            for (const def of defs.values()) {
              for (const type of new Set([...p.types, ...def.types])) {
                const routed = p.model.applies(def, type);
                check(typeof routed === 'boolean', `applies(${def.name}, ${type}) returned ${show(routed)}, not a boolean`);
                if (routed && Array.isArray(rt)) check(rt.includes(type), `applies(${def.name}, ${type}) is true, but ${type} is outside resourceTypes ${show(rt)}`);
              }
            }
            if (p.model.version) {
              const v = p.model.version();
              check(typeof v === 'string' && p.model.version() === v, 'version() must return the same string while nothing changes');
            }
          }),
        fewRuns(opts),
      ),
  };
}

function initCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'init',
    title: 'init registers well-formed permissions, native filters and relations; every declared native op has a filter',
    run: () =>
      property(
        'init',
        seeds,
        (seed) =>
          withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            const { permissions, nativeFilters, relations } = p.init.registered;
            for (const d of permissions) {
              check(isPermission(d.name), `init registered an invalid permission name ${show(d.name)}`);
              check(Array.isArray(d.types) && d.types.length > 0 && d.types.every((t) => typeof t === 'string' && t.length > 0), `permission ${d.name}: types must be a non-empty list`);
              check((d.implies ?? []).every(isPermission), `permission ${d.name}: implies names an invalid permission`);
            }
            for (const n of nativeFilters) {
              check(typeof n.op === 'string' && /^native:\S+$/.test(n.op), `init registered a native filter with op ${show(n.op)}`);
              check(typeof n.matches === 'function', `native filter ${n.op} has no matches()`);
            }
            const ops = p.natives.map((n) => n.op);
            check(new Set(ops).size === ops.length, `two native filters share an op: ${ops.join(', ')}`);
            for (const r of relations) {
              check(typeof r.type === 'string' && r.type.length > 0 && typeof r.relation === 'string' && r.relation.length > 0, `init registered a relation without type or name: ${show(r)}`);
              check(typeof r.holds === 'function', `relation ${r.type}#${r.relation} has no holds()`);
            }
            const adapterRelations = (p.world.context?.adapters ?? []).flatMap((a) => a.relations?.() ?? []);
            const keys = [...p.relations, ...adapterRelations].map((r) => `${r.type}#${r.relation}`);
            check(new Set(keys).size === keys.length, `a relation is registered twice: ${keys.join(', ')}`);
            for (const op of p.model.capabilities.residuals) {
              if (op.startsWith('native:')) check((ops as readonly string[]).includes(op), `capabilities.residuals declares ${op}, but no NativeFilter is registered for it (by init or the world)`);
            }
          }),
        fewRuns(opts),
      ),
  };
}

function votesCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'votes',
    title: 'votes use only declared ops and effects, and honour fields, needsSubject and principalTypes',
    run: () =>
      property(
        'votes',
        fc.tuple(seeds, sampleArb(opts.samples ?? 12)),
        ([seed, picks]) =>
          withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            for (const s of samplesOf(p, picks)) {
              for (const req of Object.values(requests(p, s))) {
                const o = await ask(p, req);
                if ('thrown' in o) {
                  if (opts.indeterminate !== 'allow') fail(`${describeRequest(req)}: evaluate threw ${String(o.thrown)}`);
                  continue;
                }
                voteHonesty(p, o.vote, req);
                if (opts.indeterminate !== 'allow') check(o.vote.error === undefined, `${describeRequest(req)}: indeterminate vote (${o.vote.error}) where the options forbid them`);
              }
            }
          }),
        runs(opts),
      ),
  };
}

function syncOutcome(p: Prepared, req: DecisionRequest, ctx: EvaluationContext): Outcome | PromiseLike<Vote> {
  try {
    const out = p.model.evaluate(req, ctx);
    return isThenable(out) ? out : { vote: out };
  } catch (e) {
    return { thrown: e };
  }
}

type ReadName = 'type-level' | 'concrete' | 'with subject';

// Keyed by permission and type, not route index: routes recompiled after a new version may differ in order.
const readKey = (i: number, route: Route, row: WorldRow, name: ReadName): string => `${i}|${route.permission}|${resourceKey(row.ref)}|${name}`;

interface Read {
  readonly name: ReadName;
  readonly what: string;
  readonly answer: Answer;
}

/**
 * Every asker × route × row: the type-level residual read on the row, the concrete and the with-subject
 * vote. 'fresh': a new context per request. 'preloaded': one context per asker, preloaded for its
 * principal. 'rows first': fresh, but each asker's concrete requests come before its type-level ones, so
 * a memo kept across requests and filled by whichever request comes first cannot pass for both orders.
 */
async function readAll(p: Prepared, mode: 'fresh' | 'preloaded' | 'rows first'): Promise<Map<string, Read>> {
  const out = new Map<string, Read>();
  for (const [i, who] of p.askers.entries()) {
    let ctx: EvaluationContext | undefined;
    if (mode === 'preloaded') {
      ctx = p.context();
      await p.model.preload!(who.principal, ctx);
    }
    const typeLevels = async (): Promise<void> => {
      for (const route of p.routes) {
        const typeLevel = typeLevelRequest(p, who, route.permission, route.type);
        const t = await ask(p, typeLevel, ctx);
        for (const row of route.rows) out.set(readKey(i, route, row, 'type-level'), { name: 'type-level', what: `${describeRequest(typeLevel)} (type-level) on ${resourceKey(row.ref)}`, answer: await answer(p, t, who, row, false) });
      }
    };
    const rows = async (): Promise<void> => {
      for (const route of p.routes) {
        for (const row of route.rows) {
          const r = requests(p, { who, route, row });
          out.set(readKey(i, route, row, 'concrete'), { name: 'concrete', what: `${describeRequest(r.concrete)} (concrete)`, answer: await answer(p, await ask(p, r.concrete, ctx), who, row, false) });
          out.set(readKey(i, route, row, 'with subject'), { name: 'with subject', what: describeRequest(r.withSubject), answer: await answer(p, await ask(p, r.withSubject, ctx), who, row, true) });
        }
      }
    };
    if (mode === 'rows first') {
      await rows();
      await typeLevels();
    } else {
      await typeLevels();
      await rows();
    }
  }
  return out;
}

// The definition of `sync` is in the JSDoc of runModelConformance. The engine keys ctx.cache by request
// scope, principal and model, so every check and filter of one request shares a context, preloaded or not;
// the shared pass asks in both orders, since a memo filled by one kind of request may leak into the other.
function syncCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'sync',
    title: 'the sync claim holds for type-level requests, and votes in a shared (preloaded) context are the fresh votes',
    run: () =>
      property(
        'sync',
        seeds,
        (seed) =>
          withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            const claim = p.model.capabilities.sync;
            const preload = p.model.preload?.bind(p.model);
            check(p.routes.length > 0, 'no (permission, type) of the world is routed to the model: the suite has nothing to ask');
            // Asked before any preload, so nothing a preload leaves in the model can reach these.
            const fresh = await readAll(p, 'fresh');
            const typeLevelRows = async (i: number, who: Asker, route: Route, req: DecisionRequest, now: Outcome, what: string): Promise<void> => {
              for (const row of route.rows) {
                const x = await answer(p, now, who, row, false);
                const y = fresh.get(readKey(i, route, row, 'type-level'))!.answer;
                check(sameAnswer(x, y), () => `${describeRequest(req)}: ${what} on ${resourceKey(row.ref)}: ${showAnswer(x)} vs ${showAnswer(y)}`);
              }
            };

            if (claim !== 'never') {
              for (const [i, who] of p.askers.entries()) {
                const ctx = p.context();
                if (claim === 'after-preload' && preload) await preload(who.principal, ctx);
                for (const route of p.routes) {
                  const req = typeLevelRequest(p, who, route.permission, route.type);
                  const out = syncOutcome(p, req, claim === 'always' ? p.context() : ctx);
                  if (isThenable(out)) {
                    await Promise.resolve(out).catch(() => undefined);
                    fail(`${describeRequest(req)}: sync is '${claim}', but evaluate returned a promise${claim === 'after-preload' ? ' after preload' : ''}`);
                  }
                  if ('vote' in out) voteHonesty(p, out.vote, req);
                  await typeLevelRows(i, who, route, req, out, claim === 'always' ? 'the synchronous vote differs from the awaited one' : 'after preload the type-level vote differs from the one without preload');
                }
              }
            }

            const shared = preload ? 'in a shared context after preload' : 'in a shared context';
            for (const [i, who] of p.askers.entries()) {
              const ctx = p.context();
              if (preload) await preload(who.principal, ctx);
              const rows = async (phase: string): Promise<void> => {
                for (const route of p.routes) {
                  for (const row of route.rows) {
                    const r = requests(p, { who, route, row });
                    for (const [name, q, withSubject] of [
                      ['concrete', r.concrete, false],
                      ['with subject', r.withSubject, true],
                    ] as const) {
                      const x = await answer(p, await ask(p, q, ctx), who, row, withSubject);
                      const y = fresh.get(readKey(i, route, row, name))!.answer;
                      check(sameAnswer(x, y), () => `${describeRequest(q)}: ${shared}, ${phase}, the ${name} vote differs from the one in a fresh context: ${showAnswer(x)} vs ${showAnswer(y)}`);
                    }
                  }
                }
              };
              await rows('before the type-level votes');
              for (const route of p.routes) {
                const req = typeLevelRequest(p, who, route.permission, route.type);
                await typeLevelRows(i, who, route, req, await ask(p, req, ctx), `${shared}, after the concrete votes, the type-level vote differs from the one in a fresh context`);
              }
              await rows('after the type-level votes');
            }

            // A memo kept in the model across requests answers right whenever the type-level request fills
            // it first, as everywhere above; a fresh model asked the other way round shows it.
            await withSetup(factory, { seed, shuffle: identityOrder }, async (q) => {
              sameRoutes(p.routes, q.routes, 'the first setup', 'a second setup of the same seed', '');
              for (const [k, x] of await readAll(q, 'rows first')) {
                const y = fresh.get(k)!.answer;
                check(sameAnswer(x.answer, y), () => `${x.what}: in a second setup asked rows first, the ${x.name} vote differs from the first setup's fresh one: ${showAnswer(x.answer)} vs ${showAnswer(y)}`);
              }
            });
          }),
        fewRuns(opts),
      ),
  };
}

function agreementCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'agreement',
    title: 'the type-level residual agrees with the concrete vote on every row, with and without a subject',
    run: async () => {
      const seen = { definite: 0, allowed: 0, refused: 0, listed: 0, unlisted: 0 };
      await property(
        'agreement',
        fc.tuple(seeds, sampleArb(opts.samples ?? 12)),
        ([seed, picks]) =>
          withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            for (const s of samplesOf(p, picks)) {
              const r = requests(p, s);
              const t = await answer(p, await ask(p, r.typeLevel), s.who, s.row, false);
              const c = await answer(p, await ask(p, r.concrete), s.who, s.row, false);
              const w = await answer(p, await ask(p, r.withSubject), s.who, s.row, true);
              const where = `${describeRequest(r.withSubject)}`;
              for (const [name, a, o] of [
                ['type-level', t, r.typeLevel],
                ['concrete', c, r.concrete],
                ['with subject', w, r.withSubject],
              ] as const) {
                if (a.kind !== 'indeterminate' && a.denies.length > 0) {
                  const any: Kleene = a.denies.includes(true) ? true : a.denies.includes(null) ? null : false;
                  check(any === a.deny, `${describeRequest(o)} (${name}): denyWhen gives ${a.deny} on the row, the OR of denies[].when gives ${any}`);
                }
              }
              agree(t, c, `${where}: type-level vs concrete without subject`);
              agree(t, w, `${where}: type-level vs concrete with subject`);
              agree(c, w, `${where}: concrete without vs with subject`);
              if (p.allowed(t)) seen.listed++;
              else seen.unlisted++;
              if (w.kind === 'definite') {
                seen.definite++;
                if (p.allowed(w)) seen.allowed++;
                else seen.refused++;
              }
            }
          }),
        runs(opts),
      );
      check(seen.allowed > 0 && seen.refused > 0, `the world must give definite answers both ways for the agreement to mean anything; got ${seen.allowed} allowed and ${seen.refused} refused of ${seen.definite} definite`);
      check(seen.listed > 0 && seen.unlisted > 0, `the type-level answers must allow some row and refuse another, or the list side proves nothing; got ${seen.listed} allowed and ${seen.unlisted} refused`);
    },
  };
}

const askerOf = (req: Omit<DecisionRequest, 'explain'>): Asker => ({ principal: req.principal, ...(req.actor ? { actor: req.actor } : {}) });

interface ProbeRead {
  /** '' in a fresh context, ' after preload' in one preloaded for the probe's principal. */
  readonly tag: string;
  readonly probe: Answer;
  /** The type-level residual of the probe's principal and permission, read on the probe row. */
  readonly listed: Answer;
}

async function readProbe(p: Prepared, req: Omit<DecisionRequest, 'explain'>): Promise<ProbeRead[]> {
  const { subject: _subject, resource, ...rest } = req;
  const typeLevel: DecisionRequest = { ...rest, resource: { type: resource.type } };
  const who = askerOf(req);
  const row = { ref: resource, subject: req.subject };
  const read = async (tag: string, ctx?: EvaluationContext): Promise<ProbeRead> => ({
    tag,
    probe: await answer(p, await ask(p, req, ctx), who, row, true),
    listed: await answer(p, await ask(p, typeLevel, ctx), who, row, false),
  });
  const out = [await read('')];
  if (p.model.preload) {
    const ctx = p.context();
    await p.model.preload(req.principal, ctx);
    out.push(await read(' after preload', ctx));
  }
  return out;
}

interface ChangedWorld {
  readonly routes: readonly Route[];
  readonly reads: Map<string, Read>;
}

/**
 * The routes and fresh answers of a setup of the same seed where mutation `i` is applied before init, so
 * the model starts from the changed data and never needs the freshness step (an invalidate could hide its
 * own bug). Its probe must give `after`, or the setup, not the model under test, is wrong.
 */
async function changedWorld<S>(factory: ModelFactory<S>, seed: S, i: number): Promise<ChangedWorld> {
  const setup = await factory({ seed, shuffle: identityOrder });
  try {
    const m = setup.mutations?.[i];
    check(m, `the factory gave mutation ${i} once and not the next time; factories must be deterministic`);
    await m.apply();
    const p = await prepare(setup);
    for (const r of await readProbe(p, m.request)) {
      const now = p.allowed(r.probe);
      check(now === m.after, `mutation '${m.title}': applied before init, the probe${r.tag} still answers ${now}; apply must work on a model that is not initialised`);
    }
    return { routes: p.routes, reads: await readAll(p, 'fresh') };
  } finally {
    await release(setup);
  }
}

function invalidateCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'invalidate',
    title: 'after a mutation the answers change as the model promises (live, version or invalidate), on the list side too',
    run: async () => {
      let mutations = 0;
      await property(
        'invalidate',
        seeds,
        async (seed) => {
          let count = 0;
          await withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
            count = p.mutations.length;
          });
          // Each mutation gets a fresh setup, so one mutation never sees another's change.
          for (let i = 0; i < count; i++) {
            const expected = await changedWorld(factory, seed, i);
            await withSetup(factory, { seed, shuffle: identityOrder }, async (p) => {
              const m = p.mutations[i];
              let now = p;
              const where = `mutation '${m.title}' (${describeRequest(m.request)}, freshness ${m.freshness})`;
              check(m.request.resource.id != null && m.request.subject !== undefined, `${where}: the probe must be a concrete request with its subject`);
              const preloaded = p.model.preload !== undefined;
              const compareWorld = async (): Promise<void> => {
                sameRoutes(expected.routes, now.routes, 'a fresh setup with the change applied', 'the setup under test', `${where}: after the change${m.freshness === 'version' ? '' : " (a routing change needs freshness 'version', as the host recompiles routes only on a new version)"}, `);
                for (const [tag, got] of [['', await readAll(now, 'fresh')], ...(preloaded ? [[' after preload', await readAll(now, 'preloaded')] as const] : [])] as const) {
                  for (const [k, x] of got) {
                    const y = expected.reads.get(k)!;
                    check(sameAnswer(x.answer, y.answer), () => `${where}: after the change${tag}: ${x.what} gives ${showAnswer(x.answer)}; a fresh setup with the change applied gives ${showAnswer(y.answer)}`);
                  }
                }
              };
              // Fills whatever the model caches, for every principal and not only the probe's.
              await readAll(p, 'fresh');
              if (preloaded) await readAll(p, 'preloaded');
              const expectProbe = async (stage: string, expected: boolean, stale: string): Promise<void> => {
                for (const r of await readProbe(p, m.request)) {
                  check(p.allowed(r.probe) === expected, `${where}: ${stale}${stage}${r.tag}`);
                  const why = disagreement(r.listed, r.probe);
                  check(why === undefined, () => `${where}: ${stage}${r.tag}: the type-level residual disagrees with the probe: ${why}`);
                }
              };
              const before = p.allowed(await answer(p, await ask(p, m.request), askerOf(m.request), { ref: m.request.resource, subject: m.request.subject }, true));
              check(before !== m.after, `${where}: the probe already answers ${before} before the change, so the check would prove nothing`);
              // Asked before the change too, so a model that caches answers (in itself or a preload) has them cached.
              await expectProbe('before the change', before, `the probe answers ${!before} `);
              const version = p.model.version?.();
              await m.apply();
              mutations++;
              if (m.freshness === 'version') {
                check(p.model.version, `${where}: freshness 'version' needs version()`);
                check(p.model.version() !== version, `${where}: version() did not change (${version})`);
                now = { ...p, routes: routesOf(p.model, p.registry, p.world, p.types) };
              }
              if (m.freshness === 'invalidate') {
                check(m.tags?.length && p.model.invalidate, `${where}: freshness 'invalidate' needs tags and invalidate()`);
                p.model.invalidate!(m.tags!);
              }
              await expectProbe('after the change', m.after, `still answers ${before} `);
              await compareWorld();
              if (m.tags?.length && p.model.invalidate) {
                p.model.invalidate(m.tags);
                await expectProbe(`after invalidate(${show(m.tags)}) again`, m.after, `the answer went stale again: ${before} `);
              }
            });
          }
        },
        fewRuns(opts),
      );
      check(mutations > 0, "the factory gave no mutations; pass skip: ['invalidate'] for a model without data");
    },
  };
}

const withoutTrace = (o: Outcome): unknown => {
  if ('thrown' in o) return { thrown: o.thrown instanceof Error ? o.thrown.message : String(o.thrown) };
  const { trace: _trace, ...rest } = o.vote;
  return rest;
};

function determinismCheck<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>, seeds: fc.Arbitrary<S>): ConformanceCheck<ModelCheckId> {
  return {
    id: 'determinism',
    title: 'votes are deterministic, and the deny reason does not depend on load order',
    run: () =>
      property(
        'determinism',
        fc.tuple(seeds, fc.integer(), sampleArb(opts.samples ?? 12)),
        async ([seed, order, picks]) => {
          const a = await factory({ seed, shuffle: identityOrder });
          try {
            const b = await factory({ seed, shuffle: shuffler(order) });
            try {
              const pa = await prepare(a);
              const pb = await prepare(b);
              for (const s of samplesOf(pa, picks)) {
                const routeB = pb.routes.find((r) => r.permission === s.route.permission && r.type === s.route.type);
                check(routeB, `${s.route.permission} on ${s.route.type} is routed in one load order and not in the other`);
                const reqs = Object.entries(requests(pa, s));
                const inA = new Map<string, Outcome>();
                for (const [name, req] of reqs) {
                  const first = await ask(pa, req);
                  const again = await ask(pa, req);
                  assert.deepStrictEqual(withoutTrace(again), withoutTrace(first), `${describeRequest(req)} (${name}): the same request gave two different votes`);
                  inA.set(name, first);
                }
                // B gets the requests in reverse order, so a memo that keeps whichever came first differs from A.
                for (const [name, req] of [...reqs].reverse()) {
                  const where = `${describeRequest(req)} (${name})`;
                  const withSubject = name === 'withSubject';
                  const x = await answer(pa, inA.get(name)!, s.who, s.row, withSubject);
                  const y = await answer(pb, await ask(pb, req), s.who, s.row, withSubject);
                  check(sameAnswer(x, y), `${where}: ${showAnswer(x)} in load order A, ${showAnswer(y)} in load order B, asked in reverse order`);
                  assert.deepStrictEqual(lowest(y.reasons), lowest(x.reasons), `${where}: the lowest (priority, sortKey) reason depends on load order or request order: it differs in load order B, asked in reverse order`);
                }
              }
            } finally {
              await release(b);
            }
          } finally {
            await release(a);
          }
        },
        runs(opts),
      ),
  };
}

function checksOf<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S>): readonly ConformanceCheck<ModelCheckId>[] {
  const seeds = opts.seeds ?? (fc.constant(undefined) as unknown as fc.Arbitrary<S>);
  return [capabilitiesCheck, initCheck, votesCheck, syncCheck, agreementCheck, invalidateCheck, determinismCheck].map((make) => make(factory, opts, seeds));
}

/** Options of a factory that takes a seed: the worlds come from `seeds`. */
export type SeededModelConformanceOptions<S> = ModelConformanceOptions<S> & { readonly seeds: fc.Arbitrary<S> };

/** The model suite's checks, for running outside mocha or one at a time. */
export function modelConformanceChecks(factory: ModelFactory, opts?: ModelConformanceOptions): readonly ConformanceCheck<ModelCheckId>[];
export function modelConformanceChecks<S>(factory: ModelFactory<S>, opts: SeededModelConformanceOptions<S>): readonly ConformanceCheck<ModelCheckId>[];
export function modelConformanceChecks<S>(factory: ModelFactory<S>, opts: ModelConformanceOptions<S> = {}): readonly ConformanceCheck<ModelCheckId>[] {
  return checksOf(factory, opts);
}

/**
 * Registers a mocha suite that checks any AuthorizationModel against the contract: capability
 * honesty, the `sync` claim, residual vs concrete agreement on random rows, invalidation, determinism
 * and init registrations. Mocha globals must be present (call it at the top level of a test file).
 *
 * `capabilities.sync` is a claim about type-level requests (no resource id), the ones `filter`,
 * `filterNow` and the synchronous ORM hook ask (D9, B22):
 * - 'always': evaluate returns a Vote, not a thenable, for every type-level request of a freshly
 *   initialised model;
 * - 'after-preload': the same once `preload(principal, ctx)` has resolved, in that context;
 * - 'never': no claim.
 * The synchronous vote must give the same answer on every row as the vote awaited without preload.
 * Concrete requests are never covered: EvaluationContext.ancestors and attributes return promises,
 * and no host API needs a synchronous concrete answer since checkSync is gone.
 *
 * Every check and filter of one request shares its context (ctx.cache), which the engine preloads when
 * the model has `preload`, whatever its `sync` claim. So in one context per principal (preloaded when
 * the model can), the concrete and with-subject requests of every route × row, asked both before and
 * after the type-level votes, and those type-level votes must give the answers of a fresh context. A
 * second setup of the same seed is asked rows before type-level requests, so a memo kept in the model
 * across requests must key on everything the answer depends on, as a ctx.cache memo must.
 * The suite never changes a row's subject, so it cannot see a with-subject vote cached by ref across
 * requests that goes stale when the row changes.
 *
 * After a mutation, the probe is read in a fresh and (with `preload`) a preloaded context, and every
 * principal × route × row must answer as a second setup with the change applied before init.
 *
 * Residuals are read in Kleene logic: UNKNOWN does not allow. Agreement compares permitted and denied,
 * which fold UNKNOWN into FALSE; that is exact under deny-overrides and permit-overrides. For
 * first-applicable it adds one rule: where the less informed vote abstains on a row (permit and deny
 * FALSE), the more informed one must not leave its permit UNKNOWN, since that would stop the models
 * after it on the check while the list lets them in. An `error` vote or a throw is
 * indeterminate and fails closed (design §7): it agrees with a less informed answer only if that one
 * does not allow the row, and a less informed indeterminate answer agrees with anything. A
 * `needs_subject` vote without the subject is not indeterminate: the engine combines its residuals as
 * they are, so B19 needs them to fail closed (deny: denyWhen TRUE; permit: permitWhen FALSE). It may
 * permit fewer rows than the answer with the subject, and must deny at least the rows that answer
 * denies. A model without 'permit' never allows on its own; the suite reads its answer as "not denied".
 * A residual cannot say "indeterminate" for one row, so when an error vote is combined with other
 * models under deny-overrides, the check may refuse a row the list keeps.
 */
export function runModelConformance(name: string, factory: ModelFactory, opts?: ModelConformanceOptions): void;
export function runModelConformance<S>(name: string, factory: ModelFactory<S>, opts: SeededModelConformanceOptions<S>): void;
export function runModelConformance<S>(name: string, factory: ModelFactory<S>, opts: ModelConformanceOptions<S> = {}): void {
  const checks = checksOf(factory, opts);
  describe(name, function () {
    this.timeout(opts.timeoutMs ?? 20000);
    for (const c of checks) {
      if (opts.skip?.includes(c.id)) it(c.title);
      else it(c.title, () => c.run());
    }
  });
}

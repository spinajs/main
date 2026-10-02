import { AuthorizationModel, CORE_FILTER_OPS, FALSE, compilePermissionGlob, or, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, ModelCapabilities, ModelInitContext, ModelSummary, PermissionDef, Principal, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

/** A vote with any part left out; `model` defaults to the model's name. */
export type ScriptedVote = Partial<Vote>;

/**
 * Keys: '<permission>@<resourceKey>', '<permission>@<type>', '<permission>', '*', tried in that order
 * ('@' cannot occur in a permission name). No key: no opinion (FALSE / FALSE).
 */
export type VoteTable = Readonly<Record<string, ScriptedVote>>;
export type VoteFn = (req: DecisionRequest, ctx: EvaluationContext) => ScriptedVote | Promise<ScriptedVote>;

export interface StaticModelOptions {
  readonly name?: string;
  /** Merged over: permit and deny effects, the core ops, sync 'always', no fields, no subject needed. */
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Permission globs and types (both optional, AND), or a function. Default: every route. */
  readonly applies?: { readonly permissions?: readonly string[]; readonly types?: readonly ResourceType[] } | ((permission: PermissionDef, type: ResourceType) => boolean);
  readonly votes?: VoteTable | VoteFn;
  /** Set on every vote (indeterminate, B04). */
  readonly error?: string;
  /** Thrown by evaluate instead of voting. */
  readonly throws?: unknown;
  /** Delay before the vote; Infinity never settles (exercises modelTimeoutMs). */
  readonly delayMs?: number;
  readonly summary?: Omit<ModelSummary, 'model'> | ((principal: Principal, at: ResourceRef, ctx: EvaluationContext) => Omit<ModelSummary, 'model'> | Promise<Omit<ModelSummary, 'model'>>);
}

export interface ModelCall {
  readonly method: 'init' | 'evaluate' | 'preload' | 'summarize' | 'invalidate' | 'dispose';
  readonly args: readonly unknown[];
}

/**
 * Scripted votes for core fixtures. The vote is the scripted one, unchanged: only `model`,
 * `permitWhen`/`denyWhen` (FALSE, or for denyWhen the OR of `denies[].when` when only denies are
 * given) and `cacheable` (true) are filled when left out. No simplification, no copies.
 */
export class StaticModel extends AuthorizationModel {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  readonly calls: ModelCall[] = [];

  private votes?: VoteTable | VoteFn;
  private readonly route: (permission: PermissionDef, type: ResourceType) => boolean;
  private revision = 0;

  constructor(private readonly opts: StaticModelOptions = {}) {
    super();
    this.name = opts.name ?? 'static';
    this.votes = opts.votes;
    const applies = opts.applies;
    const types = typeof applies === 'object' ? applies.types : undefined;
    this.capabilities = {
      effects: ['permit', 'deny'],
      residuals: CORE_FILTER_OPS,
      sync: 'always',
      fields: false,
      needsSubject: false,
      ...(types ? { resourceTypes: types } : {}),
      ...opts.capabilities,
    };
    if (typeof applies === 'function') {
      this.route = applies;
    } else {
      const globs = applies?.permissions?.map(compilePermissionGlob);
      this.route = (def, type) => (!globs || globs.some((g) => g(def.name))) && (!types || types.includes(type));
    }
  }

  get requests(): DecisionRequest[] {
    return this.calls.filter((c) => c.method === 'evaluate').map((c) => c.args[0] as DecisionRequest);
  }

  get invalidations(): (readonly string[])[] {
    return this.calls.filter((c) => c.method === 'invalidate').map((c) => c.args[0] as readonly string[]);
  }

  /** Replaces the script; the version stays (call bump() to model a config change). */
  respond(votes: VoteTable | VoteFn): this {
    this.votes = votes;
    return this;
  }

  bump(): this {
    this.revision++;
    return this;
  }

  init(ctx: ModelInitContext): void {
    this.calls.push({ method: 'init', args: [ctx] });
  }

  applies(permission: PermissionDef, type: ResourceType): boolean {
    return this.route(permission, type);
  }

  /** Synchronous unless a delay is set or the vote function returns a promise (so sync: 'always' holds by default). */
  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    this.calls.push({ method: 'evaluate', args: [req, ctx] });
    const { delayMs } = this.opts;
    if (delayMs === Infinity) return new Promise<never>(() => undefined);
    if (delayMs !== undefined && delayMs > 0) return new Promise((r) => setTimeout(r, delayMs)).then(() => this.vote(req, ctx));
    return this.vote(req, ctx);
  }

  async preload(principal: Principal, ctx: EvaluationContext): Promise<void> {
    this.calls.push({ method: 'preload', args: [principal, ctx] });
  }

  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    this.calls.push({ method: 'summarize', args: [principal, at, ctx] });
    const s = typeof this.opts.summary === 'function' ? await this.opts.summary(principal, at, ctx) : this.opts.summary;
    return { model: this.name, permissions: [], ...s };
  }

  invalidate(tags: readonly string[]): void {
    this.calls.push({ method: 'invalidate', args: [tags] });
  }

  version(): string {
    return String(this.revision);
  }

  async dispose(): Promise<void> {
    this.calls.push({ method: 'dispose', args: [] });
  }

  private vote(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    if ('throws' in this.opts) throw this.opts.throws;
    const script = typeof this.votes === 'function' ? this.votes(req, ctx) : lookup(this.votes ?? {}, req);
    return script instanceof Promise ? script.then((s) => this.fill(s)) : this.fill(script);
  }

  private fill(script: ScriptedVote): Vote {
    const vote: Record<string, unknown> = { model: this.name, permitWhen: FALSE, denyWhen: FALSE, cacheable: true };
    if (script.denies && script.denyWhen === undefined) vote.denyWhen = or(...script.denies.map((d) => d.when));
    if (this.opts.error !== undefined) vote.error = this.opts.error;
    for (const [k, v] of Object.entries(script)) if (v !== undefined) vote[k] = v;
    return vote as unknown as Vote;
  }
}

function lookup(table: VoteTable, req: DecisionRequest): ScriptedVote {
  const keys = [`${req.permission}@${resourceKey(req.resource)}`, `${req.permission}@${resourceKey({ type: req.resource.type })}`, req.permission, '*'];
  for (const k of keys) if (Object.hasOwn(table, k)) return table[k];
  return {};
}

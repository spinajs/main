import { AuthzConfigError } from '../contracts/errors.js';
import type { Decision, DecisionRequest, TraceStep } from '../contracts/decision.js';
import type { EvaluationContext } from '../contracts/model.js';
import type { PermissionRegistry } from '../contracts/permission.js';
import type { ResourceRef, ResourceType } from '../contracts/principal.js';
import type { RelationResolver } from '../contracts/adapter.js';
import { ConditionCompiler } from '../conditions/contracts.js';
import { swallow } from './run.js';
import { MAX_DATA_VALUES, MAX_TRACE_STEPS, budget, traceStep } from './vote.js';
import type { Budget } from './vote.js';

/** Nested `ctx.check` levels below a top-level call. */
export const MAX_CHECK_DEPTH = 8;

export type MaybePromise<T> = T | Promise<T>;

/** What a context needs from the engine. */
export interface ContextHost {
  readonly domain: string;
  readonly permissions: PermissionRegistry;
  readonly conditions: ConditionCompiler;
  ancestors(ref: ResourceRef, scope: Map<string, unknown>): MaybePromise<readonly ResourceRef[] | null>;
  attributes(ref: ResourceRef, scope: Map<string, unknown>): Promise<Readonly<Record<string, unknown>> | null>;
  relation(type: ResourceType, name: string): RelationResolver | undefined;
  nestedCheck(req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, now: Date, depth: number): Promise<Decision>;
}

// Reserved L1 keys: NUL never appears in a permission, type or model name a caller would use as a key.
export const l1Key = (kind: 'ancestors' | 'attributes' | 'nodes' | 'model' | 'decision', domain: string, key: string): string => `\u0000authz\u0000${kind}\u0000${domain}\u0000${key}`;

/** Memoises `compute` in the request map; a stored promise never goes unhandled. */
export function memo<T>(scope: Map<string, unknown>, key: string, compute: () => T): T {
  if (scope.has(key)) return scope.get(key) as T;
  const value = compute();
  swallow(value);
  scope.set(key, value);
  return value;
}

export class NoConditionCompiler extends ConditionCompiler {
  async compile(): Promise<never> {
    throw new AuthzConfigError('No condition compiler is configured for this authz domain');
  }
}

export class ModelContext implements EvaluationContext {
  readonly domain: string;
  readonly permissions: PermissionRegistry;
  readonly conditions: ConditionCompiler;
  readonly now: Date;
  readonly cache: Map<string, unknown>;
  // Private, so the model cannot clear it: set when the model broke a rule its vote cannot show (nested depth).
  #fault: string | undefined;
  // One trace budget per model per check: repeated steps sharing one object must not multiply the copy.
  readonly #traceValues: Budget = budget(MAX_DATA_VALUES);
  #traced = 0;

  constructor(private readonly host: ContextHost, private readonly owner: string, private readonly scope: Map<string, unknown>, private readonly instant: Date, private readonly depth: number, private readonly steps: TraceStep[] | undefined, cacheKey: string = owner) {
    this.domain = host.domain;
    this.permissions = host.permissions;
    this.conditions = host.conditions;
    // Own copy: a Date stays mutable when frozen, and models must not move each other's clock.
    this.now = new Date(instant.getTime());
    this.cache = memo(scope, l1Key('model', host.domain, cacheKey), () => new Map<string, unknown>());
    Object.freeze(this);
  }

  /** When set, the model's vote is indeterminate whatever it returns. */
  get fault(): string | undefined {
    return this.#fault;
  }

  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    try {
      return Promise.resolve(this.host.ancestors(ref, this.scope));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    try {
      return this.host.attributes(ref, this.scope);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  relation(type: ResourceType, name: string): RelationResolver | undefined {
    return this.host.relation(type, name);
  }

  check(req: Omit<DecisionRequest, 'explain'>): Promise<Decision> {
    if (this.depth + 1 > MAX_CHECK_DEPTH) {
      this.#fault = `nested check deeper than ${MAX_CHECK_DEPTH} levels`;
      const refused = Promise.reject(new AuthzConfigError(`authz domain ${JSON.stringify(this.domain)}: model ${JSON.stringify(this.owner)} nested checks deeper than ${MAX_CHECK_DEPTH} levels`));
      // A model that does not await it must not crash the process; one that awaits still sees the rejection.
      swallow(refused);
      return refused;
    }
    return this.host.nestedCheck(req, this.scope, this.instant, this.depth + 1);
  }

  trace(step: Omit<TraceStep, 'by'>): void {
    if (this.steps === undefined || this.#traced >= MAX_TRACE_STEPS) return;
    this.#traced++;
    try {
      this.steps.push(traceStep(this.owner, step, this.#traceValues));
    } catch {
      // a step the engine cannot read is dropped, never fatal
    }
  }
}

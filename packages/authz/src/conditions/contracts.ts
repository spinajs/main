import type { DecisionRequest, EvaluationContext, Principal, ResourceFilter } from '../contracts/index.js';

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly attr: string; readonly [op: string]: unknown }
  // attr: 'principal.*' | 'actor.*' | 'resource.*' | 'env.*' | 'scope.<type>.*'
  // op: eq ne in nin lt lte gt gte like glob wildcard null; a value may be { ref }
  | { readonly fn: string; readonly args?: Readonly<Record<string, unknown>> };

export abstract class ConditionFunction {
  abstract readonly name: string; // 'time.between'
  abstract evaluate(args: unknown, ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> }): boolean;
}

export abstract class ConditionCompiler {
  /** principal.*, actor.*, env.*, scope.* are bound now; resource.* becomes a residual 'cmp'. */
  abstract compile(c: Condition, req: DecisionRequest, ctx: EvaluationContext): Promise<{ filter: ResourceFilter; cacheable: boolean; needsSubject: boolean }>;
}

import type { Decision, DecisionRequest } from './decision.js';
import type { ResourceRef } from './principal.js';

/** What one decision read: its nested checks and intersect delegates included. */
export interface DecisionReadSet {
  /** The env keys read, by the models or by the engine binding `env.*` refs, with their values. */
  env: Record<string, unknown>;
  /** `path` is empty for a whole node a model loaded through ctx.attributes. */
  attributes: Array<{ ref: ResourceRef | 'principal' | 'actor'; path: string; value: unknown }>;
  /** Relation resolvers looked up by a model (ctx.relation) or by the subject evaluation (`model: 'core'`). */
  relations: Array<{ model: string; object: ResourceRef; relation: string; version?: string }>;
  /** Each model's version(); a model without one, or whose version() fails, is left out. */
  modelVersions: Record<string, string>;
}

/**
 * Sees every top-level decision of check, explain, checkMany, checkAll, filter and filterNow once it is final
 * (audited and cached). summary, covers and inspect are not access attempts and are not tapped. Reads are
 * recorded only while at least one tap is registered. A tap that throws or rejects is logged and ignored.
 */
export abstract class DecisionTap {
  public abstract onDecision(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, meta: { cached: boolean; durationMs: number }): void;
}

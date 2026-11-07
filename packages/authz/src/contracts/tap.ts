import type { Decision, DecisionRequest } from './decision.js';
import type { ResourceRef } from './principal.js';

/** What one decision read: its nested checks and intersect delegates included. A tap gets it built on first access. */
export interface DecisionReadSet {
  /** The env the decision was made with: the caller's keys, which the models may read, without `now` (the decision's instant). */
  env: Record<string, unknown>;
  /**
   * The scope nodes a model (ctx.attributes) or the engine (`scope.*` refs) loaded, whole (`path` empty). The principal's
   * and actor's attributes are not listed: a decision log hashes their full state.
   */
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
  /** When given and false for every tap, the engine builds nothing for the decision and calls no `onDecision`. */
  public wants?(decision: Decision): boolean;

  public abstract onDecision(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, meta: { cached: boolean; durationMs: number }): void;
}

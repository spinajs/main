import type { ChangeKind } from './changelog.js';
import type { DecisionRecord } from './decision-log.js';

/** `faithful`: replayed as logged; `divergent`: provably not; `unreplayable`: the history or the record cannot tell. */
export type ReplayVerdict = 'faithful' | 'divergent' | 'unreplayable';

/** An input the replay could not establish. */
export interface ReplayMissing {
  input: string;
  reason: string;
  key?: string;
}

export interface ReplayDivergence {
  part: 'outcome' | 'inputs-hash' | 'policy-hash' | 'captured-state';
  recorded: string;
  replayed: string;
  key?: string;
}

/** One key a replay read, and where its state at T came from. `kind` is absent when no history contributor serves the relation. */
export interface ReplayRead {
  kind?: ChangeKind;
  key: string;
  origin: 'current' | 'history' | 'gap';
  seq?: number;
  reason?: string;
}

export interface ReplayTreeNode {
  label: string;
  truth: 'allow' | 'deny' | 'unknown';
  source: string;
  children: ReplayTreeNode[];
}

export interface ReplayReport {
  decision: Omit<DecisionRecord, 'inputs' | 'facts'>;
  /** The record's policy hash is the one its domain runs now (`PolicyHashSource.policyHash(domain)`); false without a source. */
  currentPolicy: boolean;
  replay: ReplayVerdict;
  evidence?: 'inputs-hash' | 'outcome';
  outcome: { recorded: 'allow' | 'deny'; replayed: 'allow' | 'deny' | 'unknown' | null };
  inputsHash: { recorded: string; replayed: string | null };
  missing: ReplayMissing[];
  divergence: ReplayDivergence[];
  tree: ReplayTreeNode | null;
  reads: ReplayRead[];
  limits: { changes: number; maxChanges: number; keys: number; durationMs: number };
}

export interface ReplayOptions {
  maxChanges?: number;
  /** Cancels the replay: it rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Re-evaluates a logged decision against the state and policy at its instant (G14, G20). */
export abstract class DecisionReplay {
  /** undefined when no record has that id. */
  public abstract replay(decisionId: string, options?: ReplayOptions): Promise<ReplayReport | undefined>;
}

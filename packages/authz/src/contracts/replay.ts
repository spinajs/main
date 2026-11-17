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
  /** On a conditional tuple's caveat: the parameter paths its context supplied, which the replay holds. */
  tupleContext?: string[];
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

/** A replay was refused: `authz.replay.concurrency` replays run in this process already. */
export class ReplayBusy extends Error {
  constructor(readonly concurrency: number) {
    super(`authz replay: ${concurrency} replays are running in this process already (authz.replay.concurrency)`);
    this.name = 'ReplayBusy';
  }
}

/**
 * Re-evaluates a logged decision against the state and policy at its instant (G14, G20). Call it outside any
 * transaction: a replay pairs the changelog with the stores' current rows, which a transaction's snapshot would keep
 * apart, so `DbDecisionReplay` refuses to run inside one open on the authz connection with an `AuthzConfigError`.
 */
export abstract class DecisionReplay {
  /** undefined when no record has that id. @throws ReplayBusy when the process runs as many replays as it allows */
  public abstract replay(decisionId: string, options?: ReplayOptions): Promise<ReplayReport | undefined>;
}

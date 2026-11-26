import type { RowImage } from './change.js';
import type { KeyState, ReplayWindow } from './history.js';

/** An input the replay could not establish. */
export interface ReplayMissing {
  input: string;
  reason: string;
  key?: string;
}

/** A part of the recording the replay proved different: `outcome`, `inputs-hash`, `artifact-hash`, or a part a replayer names. */
export interface ReplayDivergence {
  part: string;
  recorded: string;
  replayed: string;
  key?: string;
}

/** The history one replay may read before it stops as unreplayable. */
export interface ReplayBudget {
  maxChanges: number;
  maxKeys: number;
}

export type ReplayVerdict = 'faithful' | 'divergent' | 'unreplayable';

export type ReplayEvidence = 'inputs-hash' | 'outcome';

/** A logged computation: what ran, when, what it read, what it answered. */
export interface Recording {
  readonly id: string;
  /** `authz`, `pricing`, and so on. */
  readonly domain: string;
  /** The instant the state is rebuilt at. */
  readonly at: Date;
  /** The instant the computation saw as "now". */
  readonly now: Date;
  /** Widens the window backwards. */
  readonly durationMs: number;
  /** Compared by the replayer. */
  readonly outcome: unknown;
  /** Artifact kind to the hash of the version the computation ran on. */
  readonly versions: Readonly<Record<string, string>>;
  readonly inputsHash?: string;
  /** Domain data, opaque to the core. */
  readonly payload: unknown;
}

export abstract class RecordingSource {
  abstract readonly domain: string;
  abstract load(id: string): Promise<Recording | undefined>;
}

/** Content-addressed artifacts: compiled policies, rule sets, config snapshots. */
export abstract class ArtifactSource {
  abstract readonly kind: string;
  /** undefined when nothing is stored under the hash. */
  abstract load(hash: string): Promise<unknown>;
}

/** State of keyed records at the recording's instant; every answer may contain gaps. */
export interface StateView {
  readonly at: Date;
  keys(entity: string, ids: readonly string[]): Promise<ReadonlyMap<string, KeyState>>;
  /** Rows whose columns matched `where` at T: current matches plus rows that matched before a later change. */
  select(entity: string, where: RowImage): Promise<{ rows: readonly RowImage[]; gaps: readonly ReplayMissing[] }>;
}

export abstract class StateSource {
  abstract view(at: Date, window: ReplayWindow, budget: ReplayBudget, signal: AbortSignal): StateView;
}

/**
 * An `outcome` other than `'unknown'` asserts that no input listed in `missing` could change it; a replayer that cannot
 * assert that returns `'unknown'`.
 */
export interface ReplayOutcome {
  /** What the replay answered; the string `unknown` when it could not determine an answer. */
  readonly outcome: unknown;
  readonly missing: readonly ReplayMissing[];
  readonly divergences: readonly ReplayDivergence[];
  readonly evidence?: ReplayEvidence;
  readonly tree?: unknown;
}

export abstract class Replayer {
  abstract readonly domain: string;
  /** `budget` is the one `view` was made with; a replayer that reads history through its own scan bounds it so. */
  abstract replay(recording: Recording, view: StateView, signal: AbortSignal, budget: ReplayBudget): Promise<ReplayOutcome>;
}

export interface ReplayReport {
  readonly id: string;
  readonly domain: string;
  readonly replay: ReplayVerdict;
  readonly evidence?: ReplayEvidence;
  readonly missing: readonly ReplayMissing[];
  readonly divergences: readonly ReplayDivergence[];
  readonly tree?: unknown;
}

export abstract class ReplayService {
  /** undefined when the domain's source has no recording with that id. */
  abstract replay(domain: string, id: string, options?: { signal?: AbortSignal }): Promise<ReplayReport | undefined>;
}

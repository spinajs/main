import type { AbortReason } from '../contract.js';

export type ExecutionOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted'; reason: AbortReason; settled: boolean };

import type { ErrorGroupStatus, RunStatus } from '../contract.js';

// Records, not arrays: a status added to the contract union fails to compile here until it is listed.
const RUN: Record<RunStatus, true> = {
  queued: true,
  running: true,
  succeeded: true,
  failed: true,
  retrying: true,
  dead: true,
  aborted: true,
  emitted: true,
  skipped: true,
  misfired: true,
};
const ERROR_GROUP: Record<ErrorGroupStatus, true> = { open: true, resolved: true, ignored: true };

export const RUN_STATUSES = Object.keys(RUN) as readonly RunStatus[];
export const ERROR_GROUP_STATUSES = Object.keys(ERROR_GROUP) as readonly ErrorGroupStatus[];

import type { KnownMismatch } from './conformance.js';
import type { CanvasStoreKind } from './harness.js';
import type { CanvasSqlKind } from './sql-harness.js';

/**
 * Canvas cases where SpinaJS and canvas disagree on purpose until an RFC settles it, per store kind. The
 * tests hold each to the decision the facade gives today, so an engine change shows up as a failure.
 */
export const KNOWN_MISMATCHES: Readonly<Record<CanvasStoreKind, Readonly<Record<string, KnownMismatch>>>> = Object.freeze({
  memory: Object.freeze({}),
  sqlite: Object.freeze({}),
});

export interface KnownListMismatch {
  readonly rfc: string;
  /** Exactly the `listProblems` lines the list shows today. */
  readonly problems: readonly string[];
  /** The cause the RFC names: the residual is FALSE and the type-level request has this TRUE deny (`<model> <code> (<policy>)`). */
  readonly falseBecause: string;
}

// RFC K1b-1: ABAC's agents-disabled policy denies every type-level filter of an agent (needs_subject), so the list
// of an agent is FALSE while the row checks allow.
const AGENTS_DISABLED = 'abac needs_subject (agents-disabled)';

const AGENT_LISTS: Readonly<Record<string, KnownListMismatch>> = Object.freeze({
  'agent AGENT_SESSION task TASK for ED (projects WEB; files *; file.edit) file:edit on file': { rfc: 'K1b-1', problems: ['SQL leaves out rows check allows: HOME, SECRET', 'case "agent acts as its delegator": HOME is not listed, the case expects allow'], falseBecause: AGENTS_DISABLED },
  'agent AGENT_SESSION task TASK for ED (projects WEB; files *; project.read) project:read on file': { rfc: 'K1b-1', problems: ['SQL leaves out rows check allows: HOME, SECRET'], falseBecause: AGENTS_DISABLED },
  'agent AGENT_SESSION task TASK for ED (projects WEB; files HOME; project.read) project:read on file': { rfc: 'K1b-1', problems: ['SQL leaves out rows check allows: HOME'], falseBecause: AGENTS_DISABLED },
});

/** Canvas lists whose SQL and check disagree until an RFC settles it, per dialect, by list key. */
export const LIST_MISMATCHES: Readonly<Record<CanvasSqlKind, Readonly<Record<string, KnownListMismatch>>>> = Object.freeze({
  sqlite: AGENT_LISTS,
  postgres: AGENT_LISTS,
});

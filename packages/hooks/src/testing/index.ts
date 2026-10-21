import { ActionHook } from '../contracts.js';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext } from '../contracts.js';

/** Records every phase it sees, in order; matches `actions`, every action by default. */
export class RecordingActionHook extends ActionHook {
  readonly calls: { phase: 'before' | 'after' | 'failed'; action: string; input: unknown; output?: unknown; error?: unknown }[] = [];
  readonly order: number;

  constructor(readonly actions: readonly ActionPattern[] = ['*'], opts?: { order?: number }) {
    super();
    this.order = opts?.order ?? 0;
  }

  before(_ctx: BeforeContext<ActionName>): void {
    throw new Error('not implemented: RecordingActionHook.before');
  }

  after(_ctx: AfterContext<ActionName>): void {
    throw new Error('not implemented: RecordingActionHook.after');
  }

  failed(_ctx: FailedContext<ActionName>): void {
    throw new Error('not implemented: RecordingActionHook.failed');
  }
}

/** A before hook that refuses every action matching `pattern` with `code`. */
export function refusingHook(_pattern: ActionPattern, _code: string, _opts?: { order?: number }): ActionHook {
  throw new Error('not implemented: refusingHook');
}

/** A before hook that assigns `patch` onto `ctx.input`; the runner keeps only the keys the action declares mutable. */
export function mutatingHook(_pattern: ActionPattern, _patch: Readonly<Record<string, unknown>>, _opts?: { order?: number }): ActionHook {
  throw new Error('not implemented: mutatingHook');
}

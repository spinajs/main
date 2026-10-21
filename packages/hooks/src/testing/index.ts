import { ActionHook } from '../contracts.js';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext } from '../contracts.js';

/** Records every phase it sees, in order; matches `actions`, every action by default. */
export class RecordingActionHook extends ActionHook {
  readonly calls: { phase: 'before' | 'after' | 'failed'; action: string; input: unknown; output?: unknown; error?: unknown }[] = [];
  readonly order: number;

  constructor(
    readonly actions: readonly ActionPattern[] = ['*'],
    opts?: { order?: number },
  ) {
    super();
    this.order = opts?.order ?? 0;
  }

  before(ctx: BeforeContext<ActionName>): void {
    // A copy: later hooks may still change ctx.input.
    this.calls.push({ phase: 'before', action: ctx.action, input: { ...(ctx.input as object) } });
  }

  after(ctx: AfterContext<ActionName>): void {
    this.calls.push({ phase: 'after', action: ctx.action, input: ctx.input, output: ctx.output });
  }

  failed(ctx: FailedContext<ActionName>): void {
    this.calls.push({ phase: 'failed', action: ctx.action, input: ctx.input, error: ctx.error });
  }
}

class RefusingHook extends ActionHook {
  constructor(
    readonly actions: readonly ActionPattern[],
    private readonly code: string,
    readonly order: number,
  ) {
    super();
  }

  before(ctx: BeforeContext<ActionName>): void {
    ctx.refuse(this.code);
  }
}

class MutatingHook extends ActionHook {
  constructor(
    readonly actions: readonly ActionPattern[],
    private readonly patch: Readonly<Record<string, unknown>>,
    readonly order: number,
  ) {
    super();
  }

  before(ctx: BeforeContext<ActionName>): void {
    Object.assign(ctx.input as object, this.patch);
  }
}

/** A before hook that refuses every action matching `pattern` with `code`. */
export function refusingHook(pattern: ActionPattern, code: string, opts?: { order?: number }): ActionHook {
  return new RefusingHook([pattern], code, opts?.order ?? 0);
}

/** A before hook that assigns `patch` onto `ctx.input`; the runner keeps only the keys the action declares mutable. */
export function mutatingHook(pattern: ActionPattern, patch: Readonly<Record<string, unknown>>, opts?: { order?: number }): ActionHook {
  return new MutatingHook([pattern], patch, opts?.order ?? 0);
}

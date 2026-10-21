import { ActionHook, DefaultHooks } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext, Hooks } from '@spinajs/hooks';
import type { FlowHookCall, FlowHookPatch, FlowHooksPort } from '../harness/ports.js';

/** Writes into what a hook is handed, in place, as a careless hook might. */
export type FlowHookWrite = (value: Record<string, any>) => void;

type Script = { readonly pattern: string } & ({ readonly kind: 'refuse'; readonly code: string } | { readonly kind: 'fail' } | { readonly kind: 'mutate'; readonly patch: FlowHookPatch } | { readonly kind: 'tamper'; readonly phase: 'before' | 'after'; readonly write: FlowHookWrite });

/** What a scripted `fail` throws; the runner turns it into ActionHookFailed with reason 'error'. */
export class ScriptedHookFailure extends Error {}

const matches = (pattern: string, action: string): boolean => pattern === '*' || (pattern.endsWith('.*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action);

/** One hook on every action that records each phase and refuses, fails or changes the input as the case scripts it. */
export class ScriptedActionHook extends ActionHook implements FlowHooksPort {
  readonly actions: readonly ActionPattern[] = ['*'];

  private readonly recorded: FlowHookCall[] = [];
  private readonly writes: string[] = [];
  private scripts: Script[] = [];

  calls(action?: string): readonly FlowHookCall[] {
    return action === undefined ? [...this.recorded] : this.recorded.filter((c) => c.action === action);
  }

  refuse(pattern: string, code: string): void {
    this.scripts.push({ pattern, kind: 'refuse', code });
  }

  fail(pattern: string): void {
    this.scripts.push({ pattern, kind: 'fail' });
  }

  mutate(pattern: string, patch: FlowHookPatch): void {
    this.scripts.push({ pattern, kind: 'mutate', patch });
  }

  /**
   * Later before calls write into `ctx.input` (after calls: into `ctx.output`) with `write`, in place. A write to a
   * frozen copy throws a TypeError, which is swallowed; `landed` lists the actions where a write went through.
   */
  tamper(pattern: string, write: FlowHookWrite, phase: 'before' | 'after' = 'before'): void {
    this.scripts.push({ pattern, kind: 'tamper', phase, write });
  }

  landed(): readonly string[] {
    return [...this.writes];
  }

  reset(): void {
    this.recorded.length = 0;
    this.writes.length = 0;
    this.scripts = [];
  }

  private tamperWith(action: string, phase: 'before' | 'after', value: unknown): void {
    for (const script of this.scripts) {
      if (script.kind !== 'tamper' || script.phase !== phase || !matches(script.pattern, action)) continue;
      try {
        script.write(value as Parameters<FlowHookWrite>[0]);
        this.writes.push(`${action}:${phase}`);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
    }
  }

  before(ctx: BeforeContext<ActionName>): void {
    const input = ctx.input as unknown as Record<string, unknown>;
    this.recorded.push({ phase: 'before', action: ctx.action, input: { ...input } });
    this.tamperWith(ctx.action, 'before', input);
    for (const script of this.scripts.filter((s) => matches(s.pattern, ctx.action))) {
      if (script.kind === 'tamper') continue;
      if (script.kind === 'mutate') Object.assign(input, typeof script.patch === 'function' ? script.patch({ ...input }) : script.patch);
      else if (script.kind === 'refuse') ctx.refuse(script.code);
      else throw new ScriptedHookFailure(`scripted failure on ${String(ctx.action)}`);
    }
  }

  after(ctx: AfterContext<ActionName>): void {
    this.recorded.push({ phase: 'after', action: ctx.action, input: { ...(ctx.input as object) }, output: ctx.output });
    this.tamperWith(ctx.action, 'after', ctx.output);
  }

  failed(ctx: FailedContext<ActionName>): void {
    this.recorded.push({ phase: 'failed', action: ctx.action, input: { ...(ctx.input as object) }, error: ctx.error });
  }
}

export interface KitHooksOptions {
  readonly timeoutMs?: number;
  readonly maxDepth?: number;
  /** Gets the runner's warnings; without it they go nowhere. */
  readonly log?: { warn(...args: unknown[]): void };
}

/**
 * A DefaultHooks over `hooks` alone, built without a container: the kit sets the fields DI injects (the container,
 * hooks.timeoutMs, hooks.maxDepth and the log).
 */
export async function kitHooks(hooks: readonly ActionHook[], opts: KitHooksOptions = {}): Promise<Hooks> {
  const runner = new DefaultHooks();
  // Factories, so the runner takes these instances instead of resolving the hook types.
  const types = hooks.map((hook) => () => hook);
  Object.defineProperties(runner, {
    Container: { value: { getRegisteredTypes: () => types } },
    TimeoutMs: { value: opts.timeoutMs ?? 5000 },
    MaxDepth: { value: opts.maxDepth ?? 8 },
    Log: { value: opts.log ?? { warn: () => undefined } },
  });
  await runner.resolve();
  return runner;
}

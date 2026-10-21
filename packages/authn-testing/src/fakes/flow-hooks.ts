import { ActionHook, DefaultHooks } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext, Hooks } from '@spinajs/hooks';
import type { FlowHookCall, FlowHookPatch, FlowHooksPort } from '../harness/ports.js';

type Script = { readonly pattern: string } & ({ readonly kind: 'refuse'; readonly code: string } | { readonly kind: 'fail' } | { readonly kind: 'mutate'; readonly patch: FlowHookPatch });

/** What a scripted `fail` throws; the runner turns it into ActionHookFailed with reason 'error'. */
export class ScriptedHookFailure extends Error {}

const matches = (pattern: string, action: string): boolean => pattern === '*' || (pattern.endsWith('.*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action);

/** One hook on every action that records each phase and refuses, fails or changes the input as the case scripts it. */
export class ScriptedActionHook extends ActionHook implements FlowHooksPort {
  readonly actions: readonly ActionPattern[] = ['*'];

  private readonly recorded: FlowHookCall[] = [];
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

  reset(): void {
    this.recorded.length = 0;
    this.scripts = [];
  }

  before(ctx: BeforeContext<ActionName>): void {
    const input = ctx.input as Record<string, unknown>;
    this.recorded.push({ phase: 'before', action: ctx.action, input: { ...input } });
    for (const script of this.scripts.filter((s) => matches(s.pattern, ctx.action))) {
      if (script.kind === 'mutate') Object.assign(input, typeof script.patch === 'function' ? script.patch({ ...input }) : script.patch);
      else if (script.kind === 'refuse') ctx.refuse(script.code);
      else throw new ScriptedHookFailure(`scripted failure on ${String(ctx.action)}`);
    }
  }

  after(ctx: AfterContext<ActionName>): void {
    this.recorded.push({ phase: 'after', action: ctx.action, input: { ...(ctx.input as object) }, output: ctx.output });
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

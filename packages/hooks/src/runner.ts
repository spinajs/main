import { AsyncLocalStorage } from 'node:async_hooks';
import { Autoinject, Container, Injectable, isConstructor } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';

import { ActionHook, Hooks } from './contracts.js';
import type { ActionName, ActionPattern, BeforeContext, InputOf, OutputOf, RunOptions } from './contracts.js';
import { ActionHookFailed, ActionRefused } from './errors.js';
import { matches } from './match.js';

const REFUSAL_CODE = /^[a-z0-9][a-z0-9_.-]{0,58}$/;

/** Depth of the hook call being executed; a run started from inside a hook reads it. */
const hookDepth = new AsyncLocalStorage<number>();

class InvalidRefusalCode extends Error {}
class HookTimeout extends Error {}

interface HookEntry {
  readonly type: Class<ActionHook> | Factory<ActionHook>;
  readonly patterns: readonly ActionPattern[];
  readonly order: number;
  readonly index: number;
  readonly name: string;
  instance?: Promise<ActionHook>;
}

interface ResolvedHook {
  readonly entry: HookEntry;
  readonly hook: ActionHook;
}

interface RunState<A extends ActionName> {
  readonly action: A;
  readonly depth: number;
  readonly bag: Map<string, unknown>;
}

/**
 * Collects the registered ActionHook types and their patterns in resolve(), without resolving them through DI: a
 * hook that injects a service that injects Hooks would make a cycle (D19). Patterns and order are read from a probe
 * built outside DI, so they must not depend on injected services. A hook's DI instance is resolved on the first run
 * of an action it matches. A hook registered after resolve() is not used.
 */
@Injectable(Hooks)
export class DefaultHooks extends Hooks {
  @Autoinject(Container)
  protected Container: IContainer;

  @Logger('hooks')
  protected Log: Log;

  @Config('hooks.timeoutMs')
  protected TimeoutMs: number;

  @Config('hooks.maxDepth')
  protected MaxDepth: number;

  private entries: HookEntry[] = [];
  private readonly matchCache = new Map<string, HookEntry[]>();
  private readonly warnedDropped = new Set<string>();

  public async resolve(): Promise<void> {
    const types = (this.Container.getRegisteredTypes(Array.chainOf(ActionHook)) ?? []) as (Class<ActionHook> | Factory<ActionHook>)[];
    this.entries = types.map((type, index) => this.describe(type, index));
    await super.resolve();
  }

  public has(action: ActionName): boolean {
    return this.matching(action).length > 0;
  }

  public async run<A extends ActionName>(action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<OutputOf<A>>, opts: RunOptions<A>): Promise<OutputOf<A>> {
    const entries = this.matching(action);
    if (entries.length === 0) return impl(input);

    const depth = (hookDepth.getStore() ?? 0) + 1;
    if (depth > this.MaxDepth) throw new ActionHookFailed(action, entries[0].name, 'depth');

    const instances = await Promise.all(entries.map((e) => this.instanceOf(e)));
    const ascending = entries.map((entry, i) => ({ entry, hook: instances[i] }));
    const descending = [...ascending].sort((a, b) => b.entry.order - a.entry.order || a.entry.index - b.entry.index);

    const ctx = this.createContext(action, input, depth);
    const state: RunState<A> = { action, depth, bag: ctx.bag };

    await this.runBefore(ascending, ctx, state, opts);
    const merged = this.mergeInput(input, ctx.input, opts);

    let output: OutputOf<A>;
    try {
      output = await impl(merged);
    } catch (error) {
      await this.runFailed(descending, merged, error, state);
      throw error;
    }

    await this.runAfter(descending, merged, output, state);
    return output;
  }

  /** Called once per run that has a matching hook, never on the path without one; the after and failed contexts share its bag. */
  protected createContext<A extends ActionName>(action: A, input: InputOf<A>, depth: number): BeforeContext<A> {
    return {
      action,
      input: { ...(input as object) } as InputOf<A>,
      bag: new Map<string, unknown>(),
      depth,
      refuse(code: string, message?: string): never {
        if (!REFUSAL_CODE.test(code)) throw new InvalidRefusalCode();
        throw new ActionRefused(action, code, message);
      },
    };
  }

  private describe(type: Class<ActionHook> | Factory<ActionHook>, index: number): HookEntry {
    if (isConstructor(type)) {
      const probe = new (type as unknown as new () => ActionHook)();
      return { type, patterns: probe.actions, order: probe.order, index, name: type.name };
    }

    const instance = (type as Factory<ActionHook>)(this.Container);
    return { type, patterns: instance.actions, order: instance.order, index, name: instance.constructor.name, instance: Promise.resolve(instance) };
  }

  private matching(action: string): HookEntry[] {
    let found = this.matchCache.get(action);
    if (!found) {
      found = this.entries.filter((e) => e.patterns.some((p) => matches(p, action))).sort((a, b) => a.order - b.order || a.index - b.index);
      this.matchCache.set(action, found);
    }
    return found;
  }

  private instanceOf(entry: HookEntry): Promise<ActionHook> {
    entry.instance ??= Promise.resolve(this.Container.resolve(entry.type as Class<ActionHook>) as ActionHook | Promise<ActionHook>);
    return entry.instance;
  }

  private async runBefore<A extends ActionName>(hooks: ResolvedHook[], ctx: BeforeContext<A>, state: RunState<A>, opts: RunOptions<A>): Promise<void> {
    const mutable = new Set<PropertyKey>(opts.mutable as readonly PropertyKey[]);

    for (const { entry, hook } of hooks) {
      if (!hook.before) continue;

      const snapshot = { ...(ctx.input as object) } as Record<string, unknown>;
      try {
        await this.bounded(state.depth, () => hook.before!(ctx));
      } catch (error) {
        const failure = error instanceof ActionRefused ? error : new ActionHookFailed(state.action, entry.name, error instanceof HookTimeout ? 'timeout' : 'error');
        if (opts.refusable ?? true) throw failure;
        this.logFailure(entry.name, state.action, error);
      }
      this.warnDropped(entry.name, state.action, snapshot, ctx.input as Record<string, unknown>, mutable);
    }
  }

  private async runFailed<A extends ActionName>(hooks: ResolvedHook[], input: InputOf<A>, error: unknown, state: RunState<A>): Promise<void> {
    for (const { entry, hook } of hooks) {
      if (!hook.failed) continue;
      try {
        await this.bounded(state.depth, () => hook.failed!({ action: state.action, input, error, bag: state.bag, depth: state.depth } as never));
      } catch (e) {
        this.logFailure(entry.name, state.action, e);
      }
    }
  }

  private async runAfter<A extends ActionName>(hooks: ResolvedHook[], input: InputOf<A>, output: OutputOf<A>, state: RunState<A>): Promise<void> {
    for (const { entry, hook } of hooks) {
      if (!hook.after) continue;
      try {
        await this.bounded(state.depth, () => hook.after!({ action: state.action, input, output, bag: state.bag, depth: state.depth } as never));
      } catch (e) {
        this.logFailure(entry.name, state.action, e);
      }
    }
  }

  private mergeInput<A extends ActionName>(original: InputOf<A>, changed: InputOf<A>, opts: RunOptions<A>): InputOf<A> {
    const merged = { ...(original as object) } as Record<PropertyKey, unknown>;
    for (const key of opts.mutable as readonly PropertyKey[]) merged[key] = (changed as Record<PropertyKey, unknown>)[key];
    return merged as InputOf<A>;
  }

  /** Runs one hook call at `depth` (what a nested run reads) and rejects with HookTimeout after hooks.timeoutMs. The call is abandoned, not cancelled. */
  private async bounded(depth: number, call: () => void | Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HookTimeout()), this.TimeoutMs);
    });
    try {
      await Promise.race([hookDepth.run(depth, async () => call()), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private warnDropped(hook: string, action: string, before: Record<string, unknown>, after: Record<string, unknown>, mutable: Set<PropertyKey>): void {
    if (this.warnedDropped.has(hook)) return;
    if (!Object.keys({ ...before, ...after }).some((k) => !mutable.has(k) && after[k] !== before[k])) return;

    this.warnedDropped.add(hook);
    this.Log.warn({ hook, action }, 'Hook ${hook} changed keys that ${action} does not declare mutable; the changes are dropped');
  }

  // Class names only: an error message or stack can carry a password.
  private logFailure(hook: string, action: string, e: unknown): void {
    const error = e instanceof Error ? e.constructor.name : typeof e;
    this.Log.warn({ hook, action, error }, 'Hook ${hook} failed on ${action}: ${error}');
  }
}

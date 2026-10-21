import { AsyncLocalStorage } from 'node:async_hooks';
import { Autoinject, Container, Injectable, isConstructor } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';

import { ActionHook, Hooks } from './contracts.js';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext, InputOf, OutputOf, RunOptions } from './contracts.js';
import { ActionHookFailed, ActionRefused } from './errors.js';
import { matches } from './match.js';

const REFUSAL_CODE = /^[a-z0-9][a-z0-9_.-]{0,58}$/;

/** Depth of the hook call being executed; a run started from inside a hook reads it. */
const hookDepth = new AsyncLocalStorage<number>();

class InvalidRefusalCode extends Error {}
class HookTimeout extends Error {}
class InvalidInput extends Error {}

const phasesOf = (hook: ActionHook) => ({ before: typeof hook.before === 'function', after: typeof hook.after === 'function', failed: typeof hook.failed === 'function' });
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

interface HookEntry {
  readonly type: Class<ActionHook> | Factory<ActionHook>;
  readonly patterns: readonly ActionPattern[];
  readonly order: number;
  readonly index: number;
  readonly name: string;
  /** Read from the boot probe, so a hook without `before` is not resolved before the action runs. */
  readonly phases: { readonly before: boolean; readonly after: boolean; readonly failed: boolean };
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
  /** null: resolution failed and the hook is skipped. */
  readonly hooks: Map<HookEntry, ActionHook | null>;
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
    this.matchCache.clear();
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

    const refusals = new WeakSet<object>();
    const ctx = this.createContext(action, input, depth, refusals);
    const state: RunState<A> = { action, depth, bag: ctx.bag, hooks: new Map() };

    await this.runBefore(entries, ctx, state, opts, refusals);
    const descending = [...entries].sort((a, b) => b.order - a.order || a.index - b.index);
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
  protected createContext<A extends ActionName>(action: A, input: InputOf<A>, depth: number, refusals: WeakSet<object>): BeforeContext<A> {
    return {
      action,
      input: { ...(input as object) } as InputOf<A>,
      bag: new Map<string, unknown>(),
      depth,
      refuse(code: string, message?: string): never {
        if (!REFUSAL_CODE.test(code)) throw new InvalidRefusalCode();
        const refusal = new ActionRefused(action, code, message);
        refusals.add(refusal);
        throw refusal;
      },
    };
  }

  private describe(type: Class<ActionHook> | Factory<ActionHook>, index: number): HookEntry {
    if (isConstructor(type)) {
      let probe: ActionHook;
      try {
        probe = new (type as unknown as new () => ActionHook)();
      } catch (error) {
        throw new Error(`Hook ${type.name} could not be constructed to read its actions`, { cause: error });
      }
      return { type, patterns: probe.actions, order: probe.order, index, name: type.name, phases: phasesOf(probe) };
    }

    const instance = (type as Factory<ActionHook>)(this.Container);
    return { type, patterns: instance.actions, order: instance.order, index, name: instance.constructor.name, phases: phasesOf(instance), instance: Promise.resolve(instance) };
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
    if (!entry.instance) {
      const pending = Promise.resolve().then(() => this.Container.resolve(entry.type as Class<ActionHook>) as ActionHook | Promise<ActionHook>);
      entry.instance = pending;
      // A rejected resolution is not cached: the next run tries again.
      pending.catch(() => {
        if (entry.instance === pending) entry.instance = undefined;
      });
    }
    return entry.instance;
  }

  private async runBefore<A extends ActionName>(entries: HookEntry[], ctx: BeforeContext<A>, state: RunState<A>, opts: RunOptions<A>, refusals: WeakSet<object>): Promise<void> {
    const mutable = new Set<PropertyKey>(opts.mutable as readonly PropertyKey[]);
    const refusable = opts.refusable ?? true;
    for (const entry of entries) {
      if (!entry.phases.before) continue;

      let hook: ActionHook;
      try {
        hook = await this.instanceOf(entry);
      } catch (error) {
        this.logFailure(entry.name, state.action, error);
        if (refusable) throw new ActionHookFailed(state.action, entry.name, 'error');
        state.hooks.set(entry, null);
        continue;
      }
      state.hooks.set(entry, hook);
      if (!hook.before) continue;

      const previous = ctx.input;
      const snapshot = { ...(previous as object) };
      try {
        await this.bounded(state.depth, () => hook.before!(ctx));
        if (!isObject(ctx.input)) throw new InvalidInput();
      } catch (error) {
        if (!isObject(ctx.input)) ctx.input = previous;
        const refusal = error instanceof ActionRefused && refusals.has(error);
        if (refusable && refusal) throw error;
        this.logFailure(entry.name, state.action, error);
        if (refusable) throw new ActionHookFailed(state.action, entry.name, error instanceof HookTimeout ? 'timeout' : 'error');
      }
      this.warnDropped(entry.name, state.action, snapshot, ctx.input as object, mutable);
    }
  }

  /** The hooks of `entries` that define `phase`, resolving those not resolved by the before phase; a failed resolution is logged and the hook skipped. */
  private async phaseHooks<A extends ActionName>(entries: HookEntry[], phase: 'after' | 'failed', state: RunState<A>): Promise<ResolvedHook[]> {
    const found: ResolvedHook[] = [];
    for (const entry of entries) {
      if (!(phase === 'after' ? entry.phases.after : entry.phases.failed)) continue;
      if (!state.hooks.has(entry)) {
        try {
          state.hooks.set(entry, await this.instanceOf(entry));
        } catch (error) {
          this.logFailure(entry.name, state.action, error);
          state.hooks.set(entry, null);
        }
      }
      const hook = state.hooks.get(entry);
      if (hook) found.push({ entry, hook });
    }
    return found;
  }

  private async runFailed<A extends ActionName>(entries: HookEntry[], input: InputOf<A>, error: unknown, state: RunState<A>): Promise<void> {
    for (const { entry, hook } of await this.phaseHooks(entries, 'failed', state)) {
      if (!hook.failed) continue;
      const ctx: FailedContext<A> = { action: state.action, input, error, bag: state.bag, depth: state.depth };
      try {
        await this.bounded(state.depth, () => hook.failed!(ctx));
      } catch (e) {
        this.logFailure(entry.name, state.action, e);
      }
    }
  }

  private async runAfter<A extends ActionName>(entries: HookEntry[], input: InputOf<A>, output: OutputOf<A>, state: RunState<A>): Promise<void> {
    for (const { entry, hook } of await this.phaseHooks(entries, 'after', state)) {
      if (!hook.after) continue;
      const ctx: AfterContext<A> = { action: state.action, input, output, bag: state.bag, depth: state.depth };
      try {
        await this.bounded(state.depth, () => hook.after!(ctx));
      } catch (e) {
        this.logFailure(entry.name, state.action, e);
      }
    }
  }

  private mergeInput<A extends ActionName>(original: InputOf<A>, changed: InputOf<A>, opts: RunOptions<A>): InputOf<A> {
    const picked = Object.fromEntries(
      (opts.mutable as readonly PropertyKey[]).filter((key) => Object.hasOwn(changed as object, key)).map((key) => [key, Reflect.get(changed as object, key)]),
    );
    return { ...(original as object), ...picked } as InputOf<A>;
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

  private warnDropped(hook: string, action: string, before: object, after: object, mutable: Set<PropertyKey>): void {
    if (this.warnedDropped.has(hook)) return;
    if (!Object.keys({ ...before, ...after }).some((k) => !mutable.has(k) && !Object.is(Reflect.get(after, k), Reflect.get(before, k)))) return;

    this.warnedDropped.add(hook);
    this.Log.warn({ hook, action }, 'Hook ${hook} changed keys that ${action} does not declare mutable; the changes are dropped');
  }

  // Class names only: an error message or stack can carry a password.
  private logFailure(hook: string, action: string, e: unknown): void {
    const error = e instanceof Error ? e.constructor.name : typeof e;
    this.Log.warn({ hook, action, error }, 'Hook ${hook} failed on ${action}: ${error}');
  }
}

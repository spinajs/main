import { AsyncLocalStorage } from 'node:async_hooks';
import { Autoinject, Container, Injectable, isConstructor } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';

import { ActionHook, Hooks } from './contracts.js';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext, InputOf, OutputOf, RunOptions } from './contracts.js';
import { ActionHookFailed, ActionRefused } from './errors.js';
import { matches } from './match.js';
import defaults from './config/hooks.js';

const REFUSAL_CODE = /^[a-z0-9][a-z0-9_.-]{0,58}$/;

/** Depth of the hook call being executed; a run started from inside a hook reads it. */
const hookDepth = new AsyncLocalStorage<number>();

class InvalidRefusalCode extends Error {}
class HookTimeout extends Error {}
/** A run that failed fast on an overdue resolution whose period was already logged. */
class RepeatedOverdue extends HookTimeout {}
class InvalidInput extends Error {}

const phasesOf = (hook: ActionHook) => ({ before: typeof hook.before === 'function', after: typeof hook.after === 'function', failed: typeof hook.failed === 'function' });
const reasonOf = (error: unknown) => (error instanceof HookTimeout ? 'timeout' : 'error');
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
  /** A resolution timed out and is still pending: runs fail at once instead of waiting again. */
  overdue?: boolean;
  /** The fast-path failure of the current overdue period was logged. */
  overdueLogged?: boolean;
}

interface ResolvedHook {
  readonly entry: HookEntry;
  readonly hook: ActionHook;
}

interface RunState<A extends ActionName> {
  readonly action: A;
  readonly depth: number;
  readonly input: InputOf<A>;
  /** The last ctx.input that was an object; a hook abandoned by a timeout may still replace ctx.input later. */
  lastGood: InputOf<A>;
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

  @Config('hooks.timeoutMs', { defaultValue: defaults.hooks.timeoutMs })
  protected TimeoutMs: number;

  @Config('hooks.maxDepth', { defaultValue: defaults.hooks.maxDepth })
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
    const state: RunState<A> = { action, depth, input, lastGood: ctx.input, bag: ctx.bag, hooks: new Map() };

    await this.runBefore(entries, ctx, state, opts, refusals);
    const descending = [...entries].sort((a, b) => b.order - a.order || a.index - b.index);
    const merged = this.mergeInput(input, isObject(ctx.input) ? ctx.input : state.lastGood, opts);

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
      return this.entryOf(type, probe, index, type.name);
    }

    const instance = (type as Factory<ActionHook>)(this.Container);
    if (!isObject(instance)) throw new Error(`Hook factory ${(type as Factory<ActionHook>).name || 'anonymous factory'} returned no hook instance`);
    return { ...this.entryOf(type, instance, index, instance.constructor.name), instance: Promise.resolve(instance) };
  }

  private entryOf(type: Class<ActionHook> | Factory<ActionHook>, source: ActionHook, index: number, name: string): HookEntry {
    const { actions, order } = source;
    if (!Array.isArray(actions) || !actions.every((p) => typeof p === 'string') || !Number.isFinite(order)) throw new Error(`Hook ${name} declares no valid actions/order`);
    return { type, patterns: actions as readonly ActionPattern[], order, index, name, phases: phasesOf(source) };
  }

  private matching(action: string): HookEntry[] {
    let found = this.matchCache.get(action);
    if (!found) {
      found = this.entries.filter((e) => e.patterns.some((p) => matches(p, action))).sort((a, b) => a.order - b.order || a.index - b.index);
      this.matchCache.set(action, found);
    }
    return found;
  }

  /** Resolution is bounded by hooks.timeoutMs like a hook call; the abandoned resolution stays cached, and while it is pending later runs fail at once. */
  private async boundedInstance(entry: HookEntry, depth: number): Promise<ActionHook> {
    if (entry.overdue) {
      if (entry.overdueLogged) throw new RepeatedOverdue();
      entry.overdueLogged = true;
      throw new HookTimeout();
    }
    try {
      return await this.bounded(depth, () => this.instanceOf(entry));
    } catch (error) {
      if (error instanceof HookTimeout && entry.instance) {
        entry.overdue = true;
        const settled = () => {
          entry.overdue = false;
          entry.overdueLogged = false;
        };
        entry.instance.then(settled, settled).catch(() => undefined);
      }
      throw error;
    }
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
        hook = await this.boundedInstance(entry, state.depth);
      } catch (error) {
        this.logFailure(entry.name, state.action, error);
        if (refusable) throw new ActionHookFailed(state.action, entry.name, reasonOf(error));
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
        if (refusable) throw new ActionHookFailed(state.action, entry.name, reasonOf(error));
      }
      this.settleInput(entry.name, ctx, state, snapshot, mutable);
    }
  }

  private settleInput<A extends ActionName>(hook: string, ctx: BeforeContext<A>, state: RunState<A>, snapshot: object, mutable: Set<PropertyKey>): void {
    if (!isObject(ctx.input)) return;
    this.warnDropped(hook, state.action, snapshot, ctx.input, mutable);
    this.restoreFixed(ctx.input, state.input as object, mutable);
    state.lastGood = ctx.input;
  }

  /** A later before hook must not decide on a value the action will not see. */
  private restoreFixed(target: object, original: object, mutable: Set<PropertyKey>): void {
    for (const key of Reflect.ownKeys(target)) if (!mutable.has(key) && !Object.hasOwn(original, key)) Reflect.deleteProperty(target, key);
    for (const key of Reflect.ownKeys(original)) if (!mutable.has(key)) Reflect.set(target, key, Reflect.get(original, key));
  }

  /** The hooks of `entries` that define `phase`, resolving those not resolved by the before phase; a failed resolution is logged and the hook skipped. */
  private async phaseHooks<A extends ActionName>(entries: HookEntry[], phase: 'after' | 'failed', state: RunState<A>): Promise<ResolvedHook[]> {
    const found: ResolvedHook[] = [];
    for (const entry of entries) {
      if (!(phase === 'after' ? entry.phases.after : entry.phases.failed)) continue;
      if (!state.hooks.has(entry)) {
        try {
          state.hooks.set(entry, await this.boundedInstance(entry, state.depth));
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
    const picked = Object.fromEntries((opts.mutable as readonly PropertyKey[]).filter((key) => Object.hasOwn(changed as object, key)).map((key) => [key, Reflect.get(changed as object, key)]));
    return { ...(original as object), ...picked } as InputOf<A>;
  }

  /** Runs one hook call at `depth` (what a nested run reads) and rejects with HookTimeout after hooks.timeoutMs. The call is abandoned, not cancelled. */
  private async bounded<T>(depth: number, call: () => T | Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HookTimeout()), this.TimeoutMs);
    });
    try {
      return await Promise.race([hookDepth.run(depth, async () => call()), timeout]);
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
    if (e instanceof RepeatedOverdue) return;
    const error = e instanceof Error ? e.constructor.name : typeof e;
    this.Log.warn({ hook, action, error }, 'Hook ${hook} failed on ${action}: ${error}');
  }
}

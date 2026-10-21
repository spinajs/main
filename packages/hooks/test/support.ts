import { DI, NewInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Log } from '@spinajs/log-common';

import { ActionHook, DefaultHooks, HOOKS_CONFIGURATION_SCHEMA, Hooks } from '../src/index.js';

export interface TestLogEntry {
  readonly level: string;
  readonly logger: string;
  /** Everything the call received, error messages and stacks included, so a leaked value shows up here. */
  readonly text: string;
}

function textOf(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name} ${arg.message} ${arg.stack ?? ''}`;
  if (arg !== null && typeof arg === 'object') {
    try {
      return JSON.stringify(arg, (_k, v: unknown) => (v instanceof Error ? textOf(v) : v));
    } catch {
      return '[unserializable]';
    }
  }
  return String(arg);
}

/** Stands in for the app's Log, so the `hooks` log is captured. One instance per resolve, like FrameworkLogger. */
@NewInstance()
export class TestLog {
  static readonly entries: TestLogEntry[] = [];

  private static readonly warned = new Set<string>();

  static clear(): void {
    TestLog.entries.length = 0;
    TestLog.warned.clear();
  }

  static of(logger: string, level?: string): TestLogEntry[] {
    return TestLog.entries.filter((e) => e.logger === logger && (level === undefined || e.level === level));
  }

  constructor(readonly Name: string = '') {}

  trace(...args: unknown[]): void {
    this.write('trace', args);
  }

  debug(...args: unknown[]): void {
    this.write('debug', args);
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  success(...args: unknown[]): void {
    this.write('success', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  fatal(...args: unknown[]): void {
    this.write('fatal', args);
  }

  security(...args: unknown[]): void {
    this.write('security', args);
  }

  // Log.warnOnce, but its keys are forgotten by clear(), so every test sees the warnings it causes.
  warnOnce(key: string, ...args: unknown[]): boolean {
    const id = `${this.Name}\u0000${key}`;
    if (TestLog.warned.has(id)) return false;
    this.warn(...args);
    TestLog.warned.add(id);
    return true;
  }

  private write(level: string, args: unknown[]): void {
    TestLog.entries.push({ level, logger: this.Name, text: args.map(textOf).join(' ') });
  }
}

export function useTestLog(): void {
  before(() => {
    DI.register(TestLog).as(Log as never);
  });
  beforeEach(() => {
    TestLog.clear();
  });
  after(() => {
    DI.uncache(TestLog);
    DI.unregister(TestLog);
  });
}

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class HooksTestConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json);
    }
  };
}

const children: IContainer[] = [];

export async function disposeChildren(): Promise<void> {
  for (const c of children.splice(0).reverse()) await c.dispose();
}

/**
 * A child of the root container with the hooks schema, a Configuration of `values` and DefaultHooks as its Hooks.
 * `register` runs before Hooks resolves, so what it registers exists at boot. Dispose with {@link disposeChildren}.
 */
export async function boot(values: Record<string, unknown> = {}, register?: (child: IContainer) => void): Promise<{ child: IContainer; hooks: Hooks }> {
  const child = DI.RootContainer.child();
  children.push(child);
  child.register(HOOKS_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child.register(configurationOf(values)).as(Configuration);
  await child.resolve(Configuration);
  child.register(DefaultHooks).as(Hooks);
  register?.(child);
  const hooks = await child.resolve(Hooks);
  return { child, hooks };
}

/** Registers `hook` as an ActionHook of `child`. Registrations keep their order. */
export function addHook(child: IContainer, hook: ActionHook<any>): void {
  child.register(() => hook).as(ActionHook);
}

export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the promise to reject');
}

/** Tracks a promise without awaiting it, so a test can tell it is still pending; the rejection counts as handled. */
export function track<T>(p: Promise<T>): { readonly settled: boolean; readonly value?: T; readonly error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void (async () => {
    try {
      state.value = await p;
    } catch (e) {
      state.error = e;
    } finally {
      state.settled = true;
    }
  })();
  return state;
}

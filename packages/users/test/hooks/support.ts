import { DI } from '@spinajs/di';
import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';
import type { AfterContext, ActionName, ActionPattern } from '@spinajs/hooks';

import { User } from '../../src/index.js';

/** The next `Hooks` resolve reads the registered hook types again. */
export function freshHooks(): void {
  DI.uncache(Hooks);
  DI.uncache(DefaultHooks);
}

/** Registers `hook` for the duration of `work`. */
export async function withHook<T>(hook: ActionHook, work: () => Promise<T>): Promise<T> {
  const factory = () => hook;
  DI.register(factory).as(ActionHook);
  freshHooks();
  try {
    return await work();
  } finally {
    DI.unregister(ActionHook, factory);
    freshHooks();
  }
}

/** An after hook that throws on every action it matches. */
export class ThrowingAfterHook extends ActionHook {
  public seen: unknown[] = [];

  constructor(readonly actions: readonly ActionPattern[]) {
    super();
  }

  after(ctx: AfterContext<ActionName>): void {
    this.seen.push(ctx.output);
    throw new Error('after hook down');
  }
}

/** The users row, its metadata rows and nothing else, read straight from the tables. */
export async function rowState(uuid: string): Promise<{ row: unknown; metadata: unknown[] }> {
  const driver = User.query().Driver;
  const [row] = (await driver.select().from('users').where('Uuid', uuid)) as { Id: number }[];
  const metadata = row ? ((await driver.select().from('users_metadata').columns(['Key', 'Value']).where('user_id', row.Id)) as unknown[]) : [];
  return { row, metadata: [...metadata].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

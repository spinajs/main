import type { IContainer } from '@spinajs/di';
import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';
import type { ActionName, BeforeContext } from '@spinajs/hooks';

import type { WorldHook } from '../behaviour/types.js';

class WorldActionHook extends ActionHook<ActionName> {
  readonly actions: readonly [ActionName];

  constructor(private readonly spec: WorldHook) {
    super();
    this.actions = [spec.action as ActionName];
  }

  before(ctx: BeforeContext<ActionName>): void {
    const input = ctx.input as { readonly command?: Readonly<Record<string, unknown>> };
    const target: Readonly<Record<string, unknown>> = input.command ?? ctx.input;
    const { when = {} } = this.spec;
    if (Object.entries(when).every(([key, value]) => Reflect.get(target, key) === value)) ctx.refuse(this.spec.refuse);
  }
}

/** Registers DefaultHooks and one ActionHook per `world.hooks` entry in `container`, the container Hooks is resolved from. */
export function registerWorldHooks(container: IContainer, hooks: readonly WorldHook[], setConfig: (path: readonly string[], value: unknown) => void): void {
  setConfig(['hooks'], { timeoutMs: 5000, maxDepth: 8 });
  container.register(DefaultHooks).as(Hooks);
  for (const spec of hooks) container.register(() => new WorldActionHook(spec)).as(ActionHook);
}

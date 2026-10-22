import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';

class HooksConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [];
  }

  protected onLoad(): unknown {
    return { hooks: { timeoutMs: 5000, maxDepth: 8 } };
  }
}

/** A DefaultHooks over exactly `hooks`, in its own child container, for wiring without the app's DI. */
export async function hooksOf(...hooks: ActionHook[]): Promise<Hooks> {
  const child: IContainer = DI.RootContainer.child();
  child.register(HooksConfiguration).as(Configuration);
  await child.resolve(Configuration);
  child.register(DefaultHooks).as(Hooks);
  hooks.forEach((hook, i) => {
    const factory = { [`TestActionHook${i}`]: () => hook }[`TestActionHook${i}`];
    child.register(factory).as(ActionHook);
  });
  return child.resolve(Hooks);
}

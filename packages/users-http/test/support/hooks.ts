import { DI } from '@spinajs/di';
import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';

/** Registers `hook` for the duration of `work`; Hooks reads the registered hook types when it resolves. */
export async function withHook<T>(hook: ActionHook, work: () => Promise<T>): Promise<T> {
  const factory = () => hook;
  const fresh = () => {
    DI.uncache(Hooks);
    DI.uncache(DefaultHooks);
  };
  DI.register(factory).as(ActionHook);
  fresh();
  try {
    return await work();
  } finally {
    DI.unregister(ActionHook, factory);
    fresh();
  }
}

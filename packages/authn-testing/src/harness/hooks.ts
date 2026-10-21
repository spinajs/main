import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext } from '@spinajs/hooks';
import type { HooksPort } from './ports.js';

/** As the runner matches: '*' every action, 'a.b.*' every action under 'a.b.', any other pattern only itself. */
const matches = (pattern: ActionPattern, action: string): boolean => pattern === '*' || (pattern.endsWith('.*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action);

/**
 * The `hooks` port adapter. The runner reads its hooks once, at boot, so a lane registers one instance as an
 * ActionHook before its Hooks resolves; the hooks a case adds run through it, with the runner's own context, so
 * their refusals, input changes and errors reach the runner as their own would. To the runner they are one hook: a
 * `before` that refuses or throws skips the added hooks after it, even for an action that is not refusable.
 */
export class KitActionHooks extends ActionHook implements HooksPort {
  readonly actions: readonly ActionPattern[] = ['*'];

  private hooks: ActionHook[] = [];

  add(...hooks: ActionHook[]): void {
    // A stable sort keeps the order of addition between equal orders, as the runner keeps registration order.
    this.hooks = [...this.hooks, ...hooks].sort((a, b) => a.order - b.order);
  }

  /** Drops every hook a case added. */
  clear(): void {
    this.hooks = [];
  }

  async before(ctx: BeforeContext<ActionName>): Promise<void> {
    for (const hook of this.matching(ctx.action)) await hook.before?.(ctx);
  }

  async after(ctx: AfterContext<ActionName>): Promise<void> {
    await this.settleAll(this.matching(ctx.action).reverse(), (hook) => hook.after?.(ctx));
  }

  async failed(ctx: FailedContext<ActionName>): Promise<void> {
    await this.settleAll(this.matching(ctx.action).reverse(), (hook) => hook.failed?.(ctx));
  }

  private matching(action: string): ActionHook[] {
    return this.hooks.filter((hook) => hook.actions.some((p) => matches(p, action)));
  }

  /** The runner calls each after and failed hook on its own; one that throws here must not skip the others. */
  private async settleAll(hooks: ActionHook[], call: (hook: ActionHook) => void | Promise<void>): Promise<void> {
    let first: { error: unknown } | undefined;
    for (const hook of hooks) {
      try {
        await call(hook);
      } catch (error) {
        first ??= { error };
      }
    }
    if (first) throw first.error;
  }
}

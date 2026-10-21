import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext } from '@spinajs/hooks';
import type { HooksPort } from './ports.js';

/** As the runner matches: '*' every action, 'a.b.*' every action under 'a.b.', any other pattern only itself. */
const matches = (pattern: ActionPattern, action: string): boolean => pattern === '*' || (pattern.endsWith('.*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action);

/** The authn actions that run with `refusable: false`. */
export const KIT_NOT_REFUSABLE: readonly string[] = Object.freeze(['authn.impersonation.stop', 'authn.logout.backchannel']);

/**
 * The `hooks` port adapter. The runner reads its hooks once, at boot, so a lane registers one instance as an
 * ActionHook before its Hooks resolves; the hooks a case adds run through it, with the runner's own context, so
 * their refusals, input changes and errors reach the runner as their own would.
 *
 * To the runner they are one hook, which cannot see `refusable`: `notRefusable` names the actions whose later
 * `before` hooks must still run past a refusal or an error, as the runner runs them.
 */
export class KitActionHooks extends ActionHook implements HooksPort {
  readonly actions: readonly ActionPattern[] = ['*'];

  private hooks: ActionHook[] = [];
  private readonly notRefusable: ReadonlySet<string>;

  constructor(opts: { notRefusable?: readonly string[] } = {}) {
    super();
    this.notRefusable = new Set(opts.notRefusable ?? KIT_NOT_REFUSABLE);
  }

  add(...hooks: ActionHook[]): void {
    // A stable sort keeps the order of addition between equal orders, as the runner keeps registration order.
    this.hooks = [...this.hooks, ...hooks].sort((a, b) => a.order - b.order);
  }

  /** Drops every hook a case added. */
  clear(): void {
    this.hooks = [];
  }

  async before(ctx: BeforeContext<ActionName>): Promise<void> {
    const hooks = this.matching(ctx.action);
    if (this.notRefusable.has(ctx.action)) return this.settleAll(hooks, (hook) => hook.before?.(ctx));
    for (const hook of hooks) await hook.before?.(ctx);
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

  /** The runner calls each hook on its own; one that throws here must not skip the others. */
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

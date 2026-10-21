import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern } from '@spinajs/hooks';
import type { HooksPort } from './ports.js';

/**
 * The `hooks` port adapter. The runner reads its hooks once, at boot, so a lane registers one instance as an
 * ActionHook before its Hooks resolves; the hooks a case adds run through it.
 */
export class KitActionHooks extends ActionHook implements HooksPort {
  readonly actions: readonly ActionPattern[] = ['*'];

  add(..._hooks: ActionHook[]): void {
    throw new Error('not implemented: KitActionHooks.add');
  }

  /** Drops every hook a case added. */
  clear(): void {
    throw new Error('not implemented: KitActionHooks.clear');
  }
}

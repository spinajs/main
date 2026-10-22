import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import type { IContainer } from '@spinajs/di';

import { adminDomain, setConfig } from '../admin/support.js';
import type { AdminDomain, AdminDomainOptions } from '../admin/support.js';

/** Refuses with `code` every run of its actions for which `when` holds; every run when `when` is left out. */
export class RefuseWhen extends ActionHook<ActionName> {
  constructor(
    readonly actions: readonly ActionPattern[],
    private readonly code: string,
    private readonly when: (input: any) => boolean = () => true,
  ) {
    super();
  }

  enabled = true;

  before(ctx: BeforeContext<ActionName>): void {
    if (this.enabled && this.when(ctx.input)) ctx.refuse(this.code);
  }
}

/** Replaces `command` of authz.admin.command with the result of `patch`. */
export class PatchCommand extends ActionHook<ActionName> {
  readonly actions = ['authz.admin.command'] as const;

  constructor(private readonly patch: (command: any) => unknown) {
    super();
  }

  before(ctx: BeforeContext<ActionName>): void {
    const input = ctx.input as { command: unknown };
    input.command = this.patch(input.command);
  }
}

/** Registers DefaultHooks and `hooks` in `c`, the container the domain's AuthzAdmin and AuthzService resolve Hooks from. */
export function registerHooks(c: IContainer, hooks: readonly ActionHook<any>[]): void {
  setConfig(['hooks'], { timeoutMs: 5000, maxDepth: 8 });
  c.register(DefaultHooks).as(Hooks);
  for (const h of hooks) c.register(() => h).as(ActionHook);
}

export function hookedAdminDomain(hooks: readonly ActionHook<any>[], opts: AdminDomainOptions = {}): Promise<AdminDomain> {
  return adminDomain('test', {
    ...opts,
    register: (c) => {
      registerHooks(c, hooks);
      opts.register?.(c);
    },
  });
}

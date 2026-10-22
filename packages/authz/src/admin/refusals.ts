import { ActionRefused } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';

import type { AdminContext, AuthzCommand } from '../contracts/admin.js';

const kept = new WeakMap<ActionRefused, Error>();
const listChecked = new WeakSet<AuthzCommand>();
// Not in the hook input: AdminContext holds classes, which a program loading authz twice (src and lib) cannot merge.
const calls = new WeakMap<object, { readonly command: AuthzCommand; readonly ctx: AdminContext }>();

/**
 * Refuses `authz.admin.command` and keeps `failure`, which AuthzAdmin answers in place of `hook:<code>`: authz's own
 * hooks answer the codes their checks always answered.
 */
export function refuseWith(ctx: BeforeContext<'authz.admin.command'>, code: string, failure: Error): never {
  try {
    ctx.refuse(code, failure.message);
  } catch (e) {
    if (e instanceof ActionRefused) kept.set(e, failure);
    throw e;
  }
}

/** The failure an authz hook refused with, or undefined for the refusal of any other hook. */
export function keptFailure(refusal: ActionRefused): Error | undefined {
  return kept.get(refusal);
}

/** Remembers the call that hands `command` to `authz.admin.command`. */
export function bindContext(command: AuthzCommand, ctx: AdminContext): void {
  calls.set(command, { command, ctx });
}

/** The command and context AuthzAdmin handed to `authz.admin.command` as `value`; undefined for a command a hook made. */
export function boundCall(value: unknown): { readonly command: AuthzCommand; readonly ctx: AdminContext } | undefined {
  return typeof value === 'object' && value !== null ? calls.get(value) : undefined;
}

export function markListChecked(command: AuthzCommand): void {
  listChecked.add(command);
}

/** False when a hook replaced the command after ListSupportHook judged it. */
export function wasListChecked(command: unknown): boolean {
  return typeof command === 'object' && command !== null && listChecked.has(command as AuthzCommand);
}

import _ from 'lodash';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Hooks } from '@spinajs/hooks';
import type { ActionName, InputOf, OutputOf, RunOptions } from '@spinajs/hooks';
import { hookCopy, runHookedAction } from '@spinajs/authn/hooks';
import type { Principal } from '@spinajs/authz';

import type { UserBase } from './models/User.js';

/**
 * A user's columns as plain data, the password hash left out: what hooks get instead of the ORM model. Date columns
 * are `Date`s. Hooks get frozen copies.
 */
export interface UserView {
  readonly Id?: number;
  readonly Uuid: string;
  readonly Email: string;
  readonly Login: string;
  readonly IsActive: boolean;
  readonly [column: string]: unknown;
}

/** The unsaved user of `users.create`, its columns as plain data. A before hook may set columns; `Uuid` and `Password` stay the action's. */
export interface UserDraft {
  Id?: number;
  Uuid: string;
  Email: string;
  Login: string;
  IsActive: boolean;
  [column: string]: unknown;
}

/** Who runs an action, as hooks see it: the principal without its `identity` (the User model) and its delegation chain. */
export interface ActorView {
  readonly type: string;
  readonly id: string;
  readonly authenticated: boolean;
  readonly source: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** What `create()` was given, without the password: no hook sees one. */
export interface UsersCreateData {
  Email: string;
  Login: string;
  Id?: number;
  Metadata?: Record<string, unknown>;
}

export interface UsersCreateInput {
  data: UsersCreateData;
  /** The roles asked for, or `authz.rbac.defaultRoles` when none were. */
  roles: string[];
  user: UserDraft;
  readonly actor: ActorView;
}

export interface UsersCreateOutput {
  readonly User: UserView;
  /** No password was given: the account was invited instead. */
  readonly Invited: boolean;
}

export interface UsersUpdateInput {
  readonly user: UserView;
  data: Record<string, unknown>;
}

export interface UsersUserInput {
  readonly user: UserView;
}

/** `users.deactivate`, `users.delete`: `actor` is SYSTEM unless the caller names one. */
export interface UsersDisableInput {
  readonly user: UserView;
  readonly actor: ActorView;
}

export interface UsersBanInput {
  readonly user: UserView;
  reason: string;
  /** Seconds. */
  duration: number;
  /** SYSTEM unless the caller names one. */
  readonly actor: ActorView;
}

export interface UsersMetadataSetInput {
  readonly user: UserView;
  meta: { key: string; value: unknown }[];
}

export interface UsersPasswordExpireInput {
  readonly user: UserView;
  readonly actor: ActorView;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'users.create': { input: UsersCreateInput; output: UsersCreateOutput };
    'users.update': { input: UsersUpdateInput; output: UserView };
    'users.activate': { input: UsersUserInput; output: UserView };
    'users.deactivate': { input: UsersDisableInput; output: UserView };
    'users.ban': { input: UsersBanInput; output: UserView };
    'users.unban': { input: UsersUserInput; output: UserView };
    'users.delete': { input: UsersDisableInput; output: void };
    'users.metadata.set': { input: UsersMetadataSetInput; output: UserView };
    'users.password.expire': { input: UsersPasswordExpireInput; output: void };
  }
}

/** The user's columns but the password hash, Luxon dates as `Date`s, so a frozen copy of it still works. */
export function userView(u: UserBase): UserView {
  const columns = u.ModelDescriptor?.Columns?.map((c) => c.Name) ?? ['Id', 'Uuid', 'Email', 'Login', 'IsActive'];
  const entries = columns
    .filter((name) => name !== 'Password')
    .map((name) => {
      const value: unknown = Reflect.get(u, name);
      return [name, DateTime.isDateTime(value) ? value.toJSDate() : value];
    });
  return Object.fromEntries(entries) as UserView;
}

/** A plain view of `p` for hooks; the action keeps acting as `p` itself. */
export function actorView(p: Principal): ActorView {
  return { type: p.type, id: p.id, authenticated: p.authenticated, source: p.source, attributes: { ...p.attributes } };
}

/**
 * Runs `action` through the DI `Hooks` on copies of `input()`, which is built only when a hook matches. `impl` gets
 * the mutable keys a hook changed (copies, to check again) and nothing for the keys it left alone, so the action keeps
 * using its own values for those; it never reads what the hooks were handed.
 */
export async function runUserAction<A extends ActionName, R>(action: A, input: () => InputOf<A>, impl: (changed: Partial<InputOf<A>>) => Promise<R>, opts: RunOptions<A> & { readonly output: (result: R) => OutputOf<A> }): Promise<R> {
  const hooks = await DI.resolve<Hooks>(Hooks);
  if (!hooks.has(action)) return impl({});

  const given = input();
  const mutable = opts.mutable as readonly (keyof InputOf<A> & string)[];
  // Copied the way the hooks' copies are, so a key no hook touched compares equal.
  const pristine = new Map(mutable.map((k) => [k, hookCopy(Reflect.get(given as object, k))]));
  const changedIn = (merged: InputOf<A>) => Object.fromEntries(mutable.filter((k) => !_.isEqual(Reflect.get(merged as object, k), pristine.get(k))).map((k) => [k, Reflect.get(merged as object, k)])) as Partial<InputOf<A>>;

  return runHookedAction(hooks, action, given, (merged) => impl(changedIn(merged)), opts);
}

/**
 * `changed` with each value that equals the copy of `own`'s value under the same key replaced by `own`'s: a copy
 * loses the prototype of a Luxon date or a model, so values a hook did not change must come from the caller.
 */
export function ownValues(changed: Record<string, unknown>, own: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (!own) return changed;
  return Object.fromEntries(
    Object.entries(changed).map(([k, v]) => {
      const mine: unknown = Reflect.get(own, k);
      return [k, Object.hasOwn(own, k) && _.isEqual(v, hookCopy(mine)) ? mine : v];
    }),
  );
}

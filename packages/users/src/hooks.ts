// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { Principal } from '@spinajs/authz';

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
  readonly actor: Principal;
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

export interface UsersBanInput {
  readonly user: UserView;
  reason: string;
  /** Seconds. */
  duration: number;
}

export interface UsersMetadataSetInput {
  readonly user: UserView;
  meta: { key: string; value: unknown }[];
}

export interface UsersPasswordExpireInput {
  readonly user: UserView;
  readonly actor: Principal;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'users.create': { input: UsersCreateInput; output: UsersCreateOutput };
    'users.update': { input: UsersUpdateInput; output: UserView };
    'users.activate': { input: UsersUserInput; output: UserView };
    'users.deactivate': { input: UsersUserInput; output: UserView };
    'users.ban': { input: UsersBanInput; output: UserView };
    'users.unban': { input: UsersUserInput; output: UserView };
    'users.delete': { input: UsersUserInput; output: void };
    'users.metadata.set': { input: UsersMetadataSetInput; output: UserView };
    'users.password.expire': { input: UsersPasswordExpireInput; output: void };
  }
}

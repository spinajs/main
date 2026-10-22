import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, cfg } from '@spinajs/configuration';
import { Log } from '@spinajs/log';
import { UniqueViolation } from '@spinajs/orm';
import { SYSTEM } from '@spinajs/authz';
import { IdentityRegistrar } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { PasswordHasher } from '@spinajs/authn-local';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';

import { activate, assertLoginNotReserved, create } from '../actions.js';
import { UserAlreadyExists, UserCreatedIncomplete } from '../exceptions.js';
import { runAsSystem } from '../system.js';
import { UserIdentityStore } from './identity-store.js';
import { usersMatchingLogin } from './sql.js';

type Registration = { readonly login: string; readonly email: string; readonly password: string };
type Registered = { readonly status: 'created'; readonly id: IdentityRef } | { readonly status: 'exists'; readonly id: IdentityRef };

/**
 * Self-service registration over `create()` (FEAT-4, A35). The caller has applied the password policy; `create()` applies it
 * again. A taken email or login answers `exists` with the account that holds it and writes nothing. The factory builds it with
 * `new`, so it cannot inject the Orm; the app resolved it before serving.
 */
export class UserIdentityRegistrar extends IdentityRegistrar {
  public async register(data: Registration, _ctx: AuthnContext): Promise<Registered> {
    // Before the lookup: a reserved login would otherwise find the system account and mail it.
    assertLoginNotReserved(data.login);

    const owner = await this.ownerOf(data);
    if (owner) {
      await this.spendHash(data.password);
      return { status: 'exists', id: owner };
    }

    let uuid: string;
    try {
      uuid = (await create({ Email: data.email, Login: data.login, Password: data.password }, undefined, SYSTEM)).User.Uuid;
    } catch (err) {
      if (err instanceof UserCreatedIncomplete) {
        uuid = err.data.user;
      } else if ((err instanceof ActionRefused || err instanceof ActionHookFailed) && err.action === 'users.create') {
        // Refused before the insert and its hash: the route answers it as a taken address, which costs one.
        await this.spendHash(data.password);
        throw err;
      } else if (err instanceof UserAlreadyExists || err instanceof UniqueViolation) {
        // Lost a race to a concurrent registration of the same address: the unique index answers for the check.
        const winner = await this.ownerOf(data);
        if (winner) return { status: 'exists', id: winner };
        throw err;
      } else {
        throw err;
      }
    }

    const id: IdentityRef = { type: 'user', id: uuid };
    if (cfg<boolean>('users.registration.activate', true) !== false) {
      await this.activated(id);
    }
    return { status: 'created', id };
  }

  /** The account that holds the email or, failing that, the login; an exact email match first. */
  protected async ownerOf(data: Registration): Promise<IdentityRef | null> {
    for (const value of [data.email, data.login]) {
      const rows = await runAsSystem('registrar', () => usersMatchingLogin(value));
      const typed = value.trim();
      const best = rows.find((u) => u.Email === typed) ?? rows.find((u) => u.Login === typed) ?? rows[0];
      if (best) return { type: 'user', id: best.Uuid };
    }
    return null;
  }

  // A new account costs one password hash, so a taken address pays one too: the answer must not tell them apart by time.
  protected async spendHash(password: string): Promise<void> {
    await (await DI.resolve(PasswordHasher)).hash(password);
  }

  /** A failing 'activated' mail does not undo the activation: the account counts once it is active. */
  protected async activated(id: IdentityRef): Promise<void> {
    try {
      await activate(id.id);
    } catch (err) {
      if (!(await new UserIdentityStore().status(id)).active) throw err;
      DI.resolve<Log>(Log, ['users']).warn({ userUuid: id.id, errorName: (err as Error)?.name ?? typeof err }, 'The activation of the registered account ${userUuid} left an error behind: ${errorName}');
    }
  }
}

/** The IdentityRegistrar for `users.registration.enabled`: none while it is off, so the registration route answers 404. */
export function identityRegistrar(container: IContainer): UserIdentityRegistrar | null {
  return container.get(Configuration)?.get<boolean>('users.registration.enabled', false) === true ? new UserIdentityRegistrar() : null;
}

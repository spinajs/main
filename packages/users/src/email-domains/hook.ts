import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import { EmailVerification } from '@spinajs/email-verification';

import './schema.js';

export interface EmailDomainApply {
  registration: boolean;
  usersCreate: boolean;
  emailChange: boolean;
}

const DEFAULT_APPLY: EmailDomainApply = { registration: true, usersCreate: true, emailChange: true };

/**
 * Refuses an email address whose domain `EmailVerification` rejects, with the code it returns (`emailVerification.refuseCode`).
 * `users.emailDomains.apply` switches each path: `registration` (`authn.registration`), `usersCreate` (`users.create`) and
 * `emailChange` (`users.update`, only when `data.Email` changes). The check itself is off until `emailVerification.enabled`.
 */
@Injectable(ActionHook)
export class EmailDomainHook extends ActionHook {
  // authn.registration is declared by authn-http, which users does not depend on.
  readonly actions: readonly ActionPattern[] = ['authn.registration', 'users.create', 'users.update'] as unknown as ActionPattern[];

  @Config('users.emailDomains.apply', { defaultValue: DEFAULT_APPLY })
  protected Apply: EmailDomainApply;

  @Autoinject(EmailVerification)
  protected Verification: EmailVerification;

  public async before(ctx: BeforeContext<ActionName>): Promise<void> {
    const email = this.emailOf(ctx);
    if (email === null) return;
    const result = await this.Verification.check(email);
    if (!result.allowed) ctx.refuse(result.code);
  }

  private emailOf(ctx: BeforeContext<ActionName>): string | null {
    const input = ctx.input as unknown as Record<string, any>;
    const apply = { ...DEFAULT_APPLY, ...this.Apply };
    switch (ctx.action as string) {
      case 'authn.registration':
        return apply.registration && typeof input.email === 'string' ? input.email : null;
      case 'users.create':
        return apply.usersCreate && typeof input.data?.Email === 'string' ? input.data.Email : null;
      case 'users.update': {
        const next = input.data?.Email;
        return apply.emailChange && typeof next === 'string' && next !== input.user?.Email ? next : null;
      }
      default:
        return null;
    }
  }
}

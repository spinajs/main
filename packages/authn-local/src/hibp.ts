import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import './register-schema.js';
import { Log, Logger } from '@spinajs/log';
import type { PasswordPolicyContext } from '@spinajs/authn/contracts';

import type { AuditLog } from './audit.js';
import { PasswordBlocklist } from './policy.js';

export interface HibpPasswordBlocklistOptions {
  /** The range endpoint the 5-character prefix is appended to; default `authn.local.hibp.url`. */
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly log?: AuditLog;
}

/**
 * Refuses passwords listed by the Have I Been Pwned range API (k-anonymity: only the first five hex characters of the SHA-1
 * leave the process, and every answer is padded). Fails open: a timeout, a network error or an error answer lets the password
 * through and logs a warning. With `options` the configuration is not read at all.
 */
@Injectable(PasswordBlocklist)
export class HibpPasswordBlocklist extends PasswordBlocklist {
  @Config('authn.local.hibp.url')
  protected Url: string;

  @Config('authn.local.hibp.timeoutMs')
  protected TimeoutMs: number;

  @Logger('authn-local')
  protected Log: Log;

  constructor(protected readonly Options?: HibpPasswordBlocklistOptions) {
    super();
  }

  public async isBlocked(_password: string, _ctx?: PasswordPolicyContext): Promise<boolean> {
    throw new Error('not implemented: HibpPasswordBlocklist.isBlocked');
  }
}

import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import './register-schema.js';
import { Log, Logger } from '@spinajs/log';
import type { PasswordPolicyContext } from '@spinajs/authn/contracts';

import type { AuditLog } from './audit.js';
import { AUTHN_LOCAL_DEFAULTS } from './defaults.js';
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

  public async isBlocked(password: string, _ctx?: PasswordPolicyContext): Promise<boolean> {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const suffix = hash.slice(5);
    let body: string;
    try {
      const response = await fetch(`${this.url()}${hash.slice(0, 5)}`, {
        headers: { 'Add-Padding': 'true' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return this.passUnchecked(`HTTP ${response.status}`);
      }
      body = await response.text();
    } catch (err) {
      return this.passUnchecked((err as Error)?.name ?? typeof err);
    }
    // Padding rows carry a count of 0.
    return body.split(/\r?\n/).some((line) => {
      const [listed, count] = line.trim().split(':');
      return listed?.toUpperCase() === suffix && Number(count) > 0;
    });
  }

  protected passUnchecked(reason: string): false {
    this.log().warn({ reason }, 'The breached-password check failed (${reason}); the password was accepted without it');
    return false;
  }

  protected url(): string {
    return this.Options ? (this.Options.url ?? AUTHN_LOCAL_DEFAULTS.hibp.url) : this.Url;
  }

  protected timeoutMs(): number {
    return this.Options ? (this.Options.timeoutMs ?? AUTHN_LOCAL_DEFAULTS.hibp.timeoutMs) : this.TimeoutMs;
  }

  protected log(): AuditLog {
    return this.Options ? (this.Options.log ?? { warn: () => undefined }) : this.Log;
  }
}

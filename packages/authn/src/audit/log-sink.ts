import { createHmac } from 'node:crypto';
import { Injectable, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { processSecret } from '@spinajs/util/crypto';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import type { AuditConfig } from './config.js';

// SR-19: a value holding `@` may be an email and is never written.
const noEmail = (v: unknown): unknown => (typeof v === 'string' && v.includes('@') ? '?' : v);

const hasId = (v: unknown): v is { type: unknown; id: unknown } => v !== null && typeof v === 'object' && 'id' in v;

const LINE =
  'authn audit ${type} ${outcome} at=${at}' +
  '${?strategy} strategy=${strategy}${/strategy}${?reason} reason=${reason}${/reason}' +
  '${?identity} identity=${identity}${/identity}${?actor} actor=${actor}${/actor}' +
  '${?ip} ip=${ip}${/ip}${?session} session=${session}${/session}';

/**
 * One line per event on the `authn-audit` Log; `data` and the user agent are never written. Per child container, so a
 * child boot reads its own `authn.audit` and Log. With hashing off, an id holding `@` is still hashed (SR-19).
 */
@PerChildInstance()
@Injectable(AuthnEventSink)
export class LogAuthnAuditSink extends AuthnEventSink {
  @Config('authn.audit')
  protected Config: AuditConfig;

  @Logger('authn-audit')
  protected Log: Log;

  private keyBuffer: Buffer | undefined;

  private get config(): AuditConfig {
    if (!this.Config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    return this.Config;
  }

  private get key(): Buffer {
    const secret = this.config.hashKey?.secret;
    return (this.keyBuffer ??= secret ? Buffer.from(secret, 'utf8') : processSecret());
  }

  async publish(e: AuthnEvent): Promise<void> {
    const fields = {
      type: noEmail(e.type),
      outcome: noEmail(e.outcome),
      at: e.at,
      strategy: noEmail(e.strategy),
      reason: noEmail(e.reason),
      identity: hasId(e.identity) ? this.ref(e.identity) : undefined,
      actor: hasId(e.actor) ? this.ref(e.actor) : undefined,
      ip: typeof e.ip === 'string' ? this.id('ip', e.ip) : undefined,
      session: typeof e.session === 'string' ? this.id('session', e.session) : undefined,
    };
    this.Log[e.outcome === 'failure' ? 'warn' : 'info'](fields, LINE);
  }

  // Identity and actor share a domain, so one person reads the same in both fields.
  private ref(r: { type: unknown; id: unknown }): string {
    return `${String(noEmail(r.type))}:${this.id('principal', `${String(r.type)}:${String(r.id)}`, String(r.id))}`;
  }

  private id(domain: string, value: string, shown = value): string {
    // === false: a value set at runtime never went through the schema, and only false may write raw identifiers.
    if (this.config.hashIdentifiers === false && !value.includes('@')) return shown;
    return createHmac('sha256', this.key).update(`${domain}|${value}`).digest('base64url');
  }
}

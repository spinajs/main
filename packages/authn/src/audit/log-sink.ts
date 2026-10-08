import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import type { AuditConfig } from './config.js';
import { auditLog } from './log.js';
import type { AuditLog } from './log.js';

let processKey: Buffer | undefined;

// JSON.stringify leaves U+007F-U+009F, Unicode line breaks and direction marks raw; some log viewers act on them.
const UNSAFE = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Anything but a plain token is quoted so it cannot forge a field or a line; an `@` value (an email, SR-19) is dropped.
const enc = (v: unknown): string => {
  const s = String(v);
  if (s.includes('@')) return '?';
  if (/^[A-Za-z0-9_.:/+-]+$/.test(s)) return s;
  return JSON.stringify(s).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
};

const isRef = (v: unknown): v is { type: unknown; id: unknown } => v !== null && typeof v === 'object' && 'id' in v;

const iso = (d: unknown): string => {
  try {
    return (d as Date).toISOString();
  } catch {
    return '?';
  }
};

/**
 * One line per event; `data` and the user agent are never written. Per child container, so a child boot reads its own
 * `authn.audit`. With hashing off, an id holding `@` is still hashed (SR-19).
 */
@PerChildInstance()
@Injectable(AuthnEventSink)
export class LogAuthnAuditSink extends AuthnEventSink {
  @Config('authn.audit')
  protected Config: AuditConfig;

  /** Test hook: where lines go. */
  protected out: AuditLog = auditLog('authn-audit');

  private keyBuffer: Buffer | undefined;

  private get config(): AuditConfig {
    if (!this.Config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    return this.Config;
  }

  private get key(): Buffer {
    const secret = this.config.hashKey?.secret;
    return (this.keyBuffer ??= secret ? Buffer.from(secret, 'utf8') : (processKey ??= randomBytes(32)));
  }

  async publish(e: AuthnEvent): Promise<void> {
    const parts = [`authn audit ${enc(e.type)} ${enc(e.outcome)}`, `at=${iso(e.at)}`];
    if (e.strategy !== undefined && e.strategy !== null) parts.push(`strategy=${enc(e.strategy)}`);
    if (e.reason !== undefined && e.reason !== null) parts.push(`reason=${enc(e.reason)}`);
    if (isRef(e.identity)) parts.push(`identity=${this.ref(e.identity)}`);
    if (isRef(e.actor)) parts.push(`actor=${this.ref(e.actor)}`);
    if (typeof e.ip === 'string') parts.push(`ip=${this.id('ip', e.ip)}`);
    if (typeof e.session === 'string') parts.push(`session=${this.id('session', e.session)}`);
    const line = parts.join(' ');
    if (e.outcome === 'failure') this.out.warn(line);
    else this.out.info(line);
  }

  // Identity and actor share a domain, so one person reads the same in both fields.
  private ref(r: { type: unknown; id: unknown }): string {
    return `${enc(r.type)}:${this.id('principal', `${String(r.type)}:${String(r.id)}`, String(r.id))}`;
  }

  private id(domain: string, value: string, shown = value): string {
    // === false: a value set at runtime never went through the schema, and only false may write raw identifiers.
    if (this.config.hashIdentifiers === false && !value.includes('@')) return enc(shown);
    return createHmac('sha256', this.key).update(`${domain}|${value}`).digest('base64url');
  }
}

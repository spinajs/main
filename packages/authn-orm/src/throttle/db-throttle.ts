import { createHmac, randomBytes } from 'node:crypto';

import { AuthnThrottle } from '@spinajs/authn/contracts';
import { authnAppEnv, checkThrottleParams, isLenientAuthnEnv } from '@spinajs/authn/env';
import type { AuthnConfigSource } from '@spinajs/authn/env';
import { StoreAuthnThrottle } from '@spinajs/authn/store-throttle';
import type { AuthnContext, ThrottleFlow, ThrottleKey, ThrottleParams } from '@spinajs/authn/contracts';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container, IContainer, Injectable, PerChildInstance } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { deepFreeze, isNonEmptyString } from '@spinajs/util';
import type { ThrottleStore } from '@spinajs/util';

import { checkedMs } from '../support/sql.js';
import { DbThrottleStore } from './db-throttle-store.js';
import type { DbThrottleStoreOptions } from './db-throttle-store.js';

// The hash key without authn.audit.hashKey.secret, which checkConfiguration accepts in development and test only.
let processKey: Buffer | undefined;

export interface DbThrottleOptions {
  /** Overrides `authn.audit.hashKey.secret`; null: a random key of this process. */
  readonly hashKey?: string | null;
}

/**
 * Backoff per key, never a lock (A05, A06, H31), in `authn_throttle`, shared by every app instance. The rows, their
 * compare-and-set claims and the purge are a `DbThrottleStore`.
 *
 * Every time decision compares in SQL against values computed in Node (`ctx.now`, or the clock in `succeed`),
 * never SQL `now()`, and never against a datetime read back (lane note D10).
 *
 * Tested on sqlite and postgres. On MySQL and MSSQL the migration's `datetime` keeps whole seconds (MySQL) or
 * about 3 ms (MSSQL): undo may then miss, which keeps the extra count (more throttling), and a `baseDelayMs`
 * below one second is not supported there.
 *
 * `last_attempt_at` takes the caller's now, not the later of the two: with clocks skewed across instances, an
 * account-ip row can outlive the ip run it counted in by that skew, and a later success subtracts it from the new run.
 *
 * The hash key check (`checkConfiguration`) runs when AuthnService resolves. A process that resolves this throttle
 * without it (a worker, a CLI command) keys rows with a random key of the process when the key is unset.
 */
@PerChildInstance()
@Injectable(AuthnThrottle)
export class DbAuthnThrottle extends StoreAuthnThrottle {
  @Config('authn.throttle')
  protected ConfiguredParams: ThrottleParams;

  @Config('authn.audit.hashKey.secret')
  protected ConfiguredHashSecret: string | null | undefined;

  @Logger('authn-orm')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  /** Complete params given to the constructor. */
  private readonly fixedParams: ThrottleParams | undefined;
  private loadedParams: ThrottleParams | undefined;
  private readonly fromConfiguration: boolean;
  private hmacKey: Buffer | undefined;
  private loading: Promise<void> | undefined;
  private rows: DbThrottleStore | undefined;

  /**
   * DI passes nothing: `authn.throttle` and `authn.audit.hashKey.secret` come from the configuration of the resolving
   * container on first use (`init`). With `params` nothing is read from the configuration: the hash key is
   * `options.hashKey`. The rows live on the connection of the `AuthnThrottle` model.
   */
  constructor(params?: ThrottleParams, private readonly options: DbThrottleOptions = {}) {
    super();
    if (params) checkThrottleParams(params);
    this.fromConfiguration = params === undefined;
    this.fixedParams = params;
    if (!this.fromConfiguration) {
      this.loadedParams = this.fixedParams;
      this.hmacKey = hashKeyOf(this.options.hashKey);
    }
  }

  public get params(): ThrottleParams {
    if (!this.loadedParams) throw new InvalidOption('DbAuthnThrottle: params are read from the configuration; await init() first');
    return this.loadedParams;
  }

  protected override get throttleName(): string {
    return 'DbAuthnThrottle';
  }

  /**
   * The authn service calls it at boot with its Configuration. Without the hash key this throttle uses (`options.hashKey`
   * or the `authn.audit.hashKey.secret` it reads) the rows are keyed with a random key of this process, which only a
   * development or test env of the booting configuration accepts.
   */
  public async checkConfiguration(booting: AuthnConfigSource): Promise<void> {
    // A @Config read needs the container's Configuration resolved.
    if (this.fromConfiguration) await this.configurationContainer().resolve(Configuration);
    if (isNonEmptyString(this.hashSecret())) return;
    const env = authnAppEnv(booting);
    if (!isLenientAuthnEnv(env)) {
      throw new InvalidOption(`DbAuthnThrottle: authn.audit.hashKey.secret is not set; outside development and test (env ${JSON.stringify(env ?? 'unset')}) the throttle rows must be keyed with a secret of the app`);
    }
  }

  /** Resolves the configuration; the first `attempt`, `peek` or `succeed` and every `purge` call it. */
  public async init(): Promise<void> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = undefined;
      throw err;
    });
    await this.loading;
  }

  /** The row key: base64url(HMAC-SHA256(hash key, `flow|kind|value`)); logins and addresses are personal data (SR-19). */
  public rowKey(flow: ThrottleFlow, key: ThrottleKey): string {
    checkKey(key);
    if (!this.hmacKey) throw new InvalidOption('DbAuthnThrottle: the hash key is read from the configuration; await init() first');
    return createHmac('sha256', this.hmacKey)
      .update(`${flow}|${String(key.kind)}|${key.value}`, 'utf8')
      .digest('base64url');
  }

  /** Deletes up to one batch of stale rows (idle for resetAfterSeconds and delaying nobody); returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const nowMs = checkedMs(now, 'DbAuthnThrottle.purge: now');
    return (await this.dbStore()).purge(nowMs);
  }

  protected store(): Promise<ThrottleStore> {
    return this.dbStore();
  }

  protected keyId(flow: ThrottleFlow, key: ThrottleKey): string {
    return this.rowKey(flow, key);
  }

  // The Throttle checks only the keys a flow uses; here a bad key fails attempt and succeed even when the flow ignores its kind, and in a reset.
  protected override checkKeys(keys: readonly ThrottleKey[]): void {
    for (const key of keys) checkKey(key);
  }

  // checkedMs also bounds the date to what the datetime columns hold.
  protected override nowMs(ctx: AuthnContext, method: string): number {
    return checkedMs(ctx?.now, `DbAuthnThrottle.${method}: ctx.now`);
  }

  /** Protected seam: override to wrap or replace the store (tests use it to interleave or fail statements). */
  protected createStore(options: DbThrottleStoreOptions): DbThrottleStore {
    return new DbThrottleStore(options);
  }

  private async dbStore(): Promise<DbThrottleStore> {
    await this.init();
    this.rows ??= this.createStore({ resetAfterMs: this.params.resetAfterSeconds * 1000 });
    return this.rows;
  }

  // Read once and frozen: Configuration hands out live objects, and the rows assume fixed limits.
  private snapshotConfigured(): ThrottleParams {
    if (!this.ConfiguredParams) throw new InvalidOperation('authn.throttle is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    const { service: _service, maxRows: _maxRows, memory: _memory, ...params } = structuredClone(this.ConfiguredParams) as ThrottleParams & { service?: string; maxRows?: number; memory?: unknown };
    checkThrottleParams(params);
    return deepFreeze(params);
  }

  /** The key `init` uses: `options.hashKey` when given, else the configured one when there is a configuration. */
  private hashSecret(): unknown {
    return this.options.hashKey !== undefined || !this.fromConfiguration ? this.options.hashKey : this.ConfiguredHashSecret;
  }

  private configurationContainer(): IContainer {
    if (!this.Container) throw new InvalidOperation('DbAuthnThrottle: built without params and not by DI, so it has no configuration');
    return this.Container;
  }

  private async load(): Promise<void> {
    if (this.fromConfiguration) {
      // A @Config read needs the container's Configuration resolved.
      await this.configurationContainer().resolve(Configuration);
      this.loadedParams = this.fixedParams ?? this.snapshotConfigured();
      const secret = this.hashSecret();
      this.hmacKey = hashKeyOf(secret);
      if (!isNonEmptyString(secret)) {
        this.Log.warnOnce('random-hash-key','DbAuthnThrottle: authn.audit.hashKey.secret is not set, so throttle rows are keyed with a random key of this process: their counts end with the process and are not shared with other instances');
      }
    }
  }
}

function checkKey(key: ThrottleKey): void {
  if (typeof key?.value !== 'string') {
    throw new InvalidArgument(`DbAuthnThrottle: the value of a ${JSON.stringify(String(key?.kind))} key must be a string`);
  }
}

function hashKeyOf(secret: unknown): Buffer {
  return isNonEmptyString(secret) ? Buffer.from(secret, 'utf8') : (processKey ??= randomBytes(32));
}

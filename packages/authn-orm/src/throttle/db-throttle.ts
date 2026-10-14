import { createHmac, randomBytes } from 'node:crypto';

import { AuthnThrottle, DEFAULT_THROTTLE_PARAMS } from '@spinajs/authn/contracts';
import { authnAppEnv, checkThrottleParams, isLenientAuthnEnv } from '@spinajs/authn/env';
import type { AuthnConfigSource } from '@spinajs/authn/env';
import { StoreAuthnThrottle } from '@spinajs/authn/store-throttle';
import type { AuthnContext, ThrottleFlow, ThrottleKey, ThrottleParams } from '@spinajs/authn/contracts';
import { CONFIGURATION_CONTAINER_KEY, Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { DI, IContainer, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Orm, OrmDriver } from '@spinajs/orm';
import type { ThrottleStore } from '@spinajs/util';

import { checkedMs } from '../support/sql.js';
import { DbThrottleStore } from './db-throttle-store.js';
import type { DbThrottleStoreOptions } from './db-throttle-store.js';

// The hash key without authn.audit.hashKey.secret, which checkConfiguration accepts in development and test only.
let processKey: Buffer | undefined;

export interface DbThrottleOptions {
  /** Overrides `authn.audit.hashKey.secret`; null: a random key of this process. */
  readonly hashKey?: string | null;
  /** Where the Orm and the Configuration come from; default the root container. */
  readonly container?: IContainer;
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
@Singleton()
@Injectable(AuthnThrottle)
export class DbAuthnThrottle extends StoreAuthnThrottle {
  @Config('authn.throttle')
  protected ConfiguredParams: ThrottleParams;

  @Config('authn.audit.hashKey.secret')
  protected ConfiguredHashSecret: string | null | undefined;

  /** Complete params given to the constructor, or the §22.5 defaults when there is a driver and no container to read them from. */
  private readonly fixedParams: ThrottleParams | undefined;
  private loadedParams: ThrottleParams | undefined;
  private readonly fromConfiguration: boolean;
  private hmacKey: Buffer | undefined;
  private loading: Promise<void> | undefined;
  private rows: DbThrottleStore | undefined;

  /**
   * DI passes nothing: the `'default'` connection, `authn.throttle` and `authn.audit.hashKey.secret` come from the
   * container on first use (`init`). With a driver and no container nothing is read from the configuration:
   * `params` default to §22.5 and the hash key to `options.hashKey`.
   */
  constructor(private driver?: OrmDriver, params?: ThrottleParams, private readonly options: DbThrottleOptions = {}) {
    super();
    if (params) checkThrottleParams(params);
    if (options.container) {
      // An instance built with `new` has no injected container, so @Config would read the root Configuration.
      Object.defineProperty(this, CONFIGURATION_CONTAINER_KEY, { value: options.container, configurable: true, writable: true });
    }
    // Fixed here: init() sets the driver later.
    this.fromConfiguration = driver === undefined || options.container !== undefined;
    this.fixedParams = params ?? (this.fromConfiguration ? undefined : DEFAULT_THROTTLE_PARAMS);
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
    if (this.fromConfiguration) await (this.options.container ?? DI.RootContainer).resolve(Configuration);
    if (isSecret(this.hashSecret())) return;
    const env = authnAppEnv(booting);
    if (!isLenientAuthnEnv(env)) {
      throw new InvalidOption(`DbAuthnThrottle: authn.audit.hashKey.secret is not set; outside development and test (env ${JSON.stringify(env ?? 'unset')}) the throttle rows must be keyed with a secret of the app`);
    }
  }

  /** Resolves the connection and the configuration; the first `attempt`, `peek` or `succeed` and every `purge` call it. */
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

  // As before the util Throttle: a bad key fails attempt and succeed also when the flow ignores its kind, and in a reset.
  protected override checkKeys(keys: readonly ThrottleKey[]): void {
    for (const key of keys) checkKey(key);
  }

  // checkedMs also bounds the date to what the datetime columns hold.
  protected override nowMs(ctx: AuthnContext, method: string): number {
    return checkedMs(ctx?.now, `DbAuthnThrottle.${method}: ctx.now`);
  }

  /** @internal Tests replace the store to interleave or fail its statements. */
  protected createStore(options: DbThrottleStoreOptions): DbThrottleStore {
    return new DbThrottleStore(options);
  }

  private async dbStore(): Promise<DbThrottleStore> {
    await this.init();
    this.rows ??= this.createStore({ driver: this.driver!, resetAfterMs: this.params.resetAfterSeconds * 1000 });
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

  private async load(): Promise<void> {
    const container = this.options.container ?? DI.RootContainer;
    if (this.fromConfiguration) {
      // A @Config read needs the container's Configuration resolved.
      await container.resolve(Configuration);
      this.loadedParams = this.fixedParams ?? this.snapshotConfigured();
      const secret = this.hashSecret();
      this.hmacKey = hashKeyOf(secret);
      if (!isSecret(secret)) {
        warnOnce('DbAuthnThrottle: authn.audit.hashKey.secret is not set, so throttle rows are keyed with a random key of this process: their counts end with the process and are not shared with other instances');
      }
    }
    if (!this.driver) {
      const orm = await container.resolve(Orm);
      const driver = orm.Connections.get('default');
      if (!driver) throw new InvalidOption("DbAuthnThrottle: the Orm has no 'default' connection");
      this.driver = driver;
    }
  }
}

function checkKey(key: ThrottleKey): void {
  if (typeof key?.value !== 'string') {
    throw new InvalidArgument(`DbAuthnThrottle: the value of a ${JSON.stringify(String(key?.kind))} key must be a string`);
  }
}

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  try {
    if (DI.check(Log)) {
      (DI.resolve(Log, ['authn-orm']) as Log).warn(message);
      return;
    }
  } catch {
    // no usable Log: fall back to the console
  }
  console.warn(message);
}

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const isSecret = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function hashKeyOf(secret: unknown): Buffer {
  return isSecret(secret) ? Buffer.from(secret, 'utf8') : (processKey ??= randomBytes(32));
}

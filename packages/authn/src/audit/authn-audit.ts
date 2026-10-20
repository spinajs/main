import { AsyncService, Autoinject, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { ResiliencePipelineBuilder, TimeoutRejectedException, TimeSpan, frozenCopy, isNonEmptyString } from '@spinajs/util';
import type { ResiliencePipeline } from '@spinajs/util';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { errorClass } from '../support/guards.js';
import type { AuditConfig } from './config.js';

/** An AuthnEvent without the fields AuthnAudit.publishIn takes from the AuthnContext. */
export type AuthnEventBody = Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>;

/** What an event emitter needs of AuthnAudit. */
export type AuthnAuditor = Pick<AuthnAudit, 'publish' | 'publishIn'>;

export interface AuthnAuditOverOptions {
  /** Default 2000, as `authn.audit.sinkTimeoutMs`. */
  readonly sinkTimeoutMs?: number;
  /** Where sink failures and timeouts are reported; default none. */
  readonly log?: Pick<Log, 'warn'>;
}

const stamped = (ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): AuthnEvent => ({ ...body, at: ctx.now, ...(isNonEmptyString(ctx.ip) ? { ip: ctx.ip } : {}), ...(isNonEmptyString(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });

class SinkDelivery implements AuthnAuditor {
  private readonly pipeline: ResiliencePipeline<void>;

  constructor(
    readonly sinks: readonly AuthnEventSink[],
    private readonly timeoutMs: number,
    private readonly log: () => Pick<Log, 'warn'>,
  ) {
    this.pipeline = new ResiliencePipelineBuilder<void>().addTimeout(TimeSpan.fromMilliseconds(timeoutMs)).build();
  }

  public async publish(e: AuthnEvent): Promise<void> {
    const event = frozenCopy(e);
    await Promise.allSettled(this.sinks.map((sink) => this.deliver(sink, event)));
  }

  public publishIn(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): Promise<void> {
    return this.publish(stamped(ctx, body));
  }

  // Logs the error class only: a sink's error message can echo event values.
  private async deliver(sink: AuthnEventSink, event: AuthnEvent): Promise<void> {
    const name = sink.constructor.name;
    try {
      await this.pipeline.execute(() => Promise.resolve().then(() => sink.publish(event)));
    } catch (err) {
      if (err instanceof TimeoutRejectedException) this.log().warn({ sink: name, eventType: event.type, timeoutMs: this.timeoutMs }, 'AuthnAudit: sink ${sink} timed out on a ${eventType} event after ${timeoutMs} ms');
      else this.log().warn({ sink: name, eventType: event.type, errorClass: errorClass(err) }, 'AuthnAudit: sink ${sink} failed to publish a ${eventType} event (${errorClass})');
    }
  }
}

const SILENT: Pick<Log, 'warn'> = { warn: () => undefined };

/**
 * Every AuthnEventSink registered in the container's lineage gets every event (A21). Sinks run concurrently, each
 * bounded by `sinkTimeoutMs`, so a stuck sink cannot hold up a login. One per container, so a child boot reads its own
 * `authn.audit` and sinks.
 */
@PerChildInstance()
export class AuthnAudit extends AsyncService {
  @Config('authn.audit')
  protected Config: AuditConfig;

  @Logger('authn-audit')
  protected Log: Log;

  // A child that registers its own sink keeps its ancestors' ones; each is built where it was registered.
  @Autoinject(Array.chainOf(AuthnEventSink))
  protected Sinks: AuthnEventSink[];

  private delivery!: SinkDelivery;

  /** The same delivery over explicit sinks, for a service built outside DI with its sinks passed in. */
  public static over(sinks: readonly AuthnEventSink[], options: AuthnAuditOverOptions = {}): AuthnAuditor {
    const log = options.log ?? SILENT;
    return new SinkDelivery(Object.freeze([...sinks]), options.sinkTimeoutMs ?? 2000, () => log);
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    if (this.Sinks.length === 0) this.Log.warn('AuthnAudit: no AuthnEventSink is registered; authentication events are not audited');

    this.delivery = new SinkDelivery(Object.freeze([...this.Sinks]), config.sinkTimeoutMs, () => this.Log);
    await super.resolve();
  }

  public sinks(): readonly AuthnEventSink[] {
    this.assertResolved();
    return this.delivery.sinks;
  }

  /** Never rejects because of a sink. */
  public async publish(e: AuthnEvent): Promise<void> {
    this.assertResolved();
    await this.delivery.publish(e);
  }

  /** Publishes `body` stamped with the context's `now`, `ip` and `userAgent`. Never rejects because of a sink. */
  public publishIn(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): Promise<void> {
    return this.publish(stamped(ctx, body));
  }

  private assertResolved(): void {
    if (!this.Resolved) throw new InvalidOperation('AuthnAudit is not resolved');
  }
}

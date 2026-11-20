import { AsyncService, Autoinject, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { ResiliencePipelineBuilder, TimeoutRejectedException, TimeSpan, frozenCopy, isNonEmptyString } from '@spinajs/util';
import type { ResiliencePipeline } from '@spinajs/util';

import { AuthnEventListener, AuthnListenerFailed } from '../contracts/audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { errorClass } from '../support/guards.js';
import type { AuditConfig } from './config.js';

/** An AuthnEvent without the fields AuthnAudit.publishIn takes from the AuthnContext. */
export type AuthnEventBody = Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>;

/** What an event emitter needs of AuthnAudit. */
export type AuthnAuditor = Pick<AuthnAudit, 'publish' | 'publishIn'>;

export interface AuthnAuditOverOptions {
  /** Default 2000, as `authn.audit.listenerTimeoutMs`. */
  readonly listenerTimeoutMs?: number;
  /** Where listener failures and timeouts are reported; default none. */
  readonly log?: Pick<Log, 'warn'>;
}

const stamped = (ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): AuthnEvent => ({ ...body, at: ctx.now, ...(isNonEmptyString(ctx.ip) ? { ip: ctx.ip } : {}), ...(isNonEmptyString(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });

/** A blocking listener and how it takes a stoppable event. */
interface Gate {
  readonly listener: AuthnEventListener;
  readonly take: () => Promise<void>;
}

// A `blocking` getter that throws cannot say the listener may be skipped: it counts as a blocking listener that failed.
function gateOf(listener: AuthnEventListener, event: AuthnEvent): Gate[] {
  try {
    return listener.blocking ? [{ listener, take: () => listener.on(event) }] : [];
  } catch (err) {
    return [
      {
        listener,
        take: () => {
          throw err;
        },
      },
    ];
  }
}

class ListenerDelivery implements AuthnAuditor {
  private readonly pipeline: ResiliencePipeline<void>;
  private readonly detached = new Set<Promise<void>>();

  constructor(
    readonly listeners: readonly AuthnEventListener[],
    private readonly timeoutMs: number,
    private readonly log: () => Pick<Log, 'warn'>,
  ) {
    this.pipeline = new ResiliencePipelineBuilder<void>().addTimeout(TimeSpan.fromMilliseconds(timeoutMs)).build();
  }

  public async publish(e: AuthnEvent): Promise<void> {
    await this.deliverAll(frozenCopy(e), true);
  }

  public publishIn(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): Promise<void> {
    return this.publish(stamped(ctx, body));
  }

  public publishDetached(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): void {
    // The operation has returned, so nothing can stop it any more.
    const delivery: Promise<void> = this.deliverAll(frozenCopy(stamped(ctx, body)), false)
      .catch((err: unknown) => this.log().warn({ eventType: body.type, errorClass: errorClass(err) }, 'AuthnAudit: a detached ${eventType} event was dropped (${errorClass})'))
      .finally(() => this.detached.delete(delivery));
    this.detached.add(delivery);
  }

  public async settled(): Promise<void> {
    await Promise.all([...this.detached]);
    await Promise.allSettled(this.listeners.map((listener) => this.flushed(listener)));
  }

  /**
   * A success event that can still be stopped goes to the blocking listeners first; when one of them fails, nobody
   * else is told and the failure goes to the emitter. Every other delivery is concurrent, bounded and only logged.
   */
  private async deliverAll(event: AuthnEvent, stoppable: boolean): Promise<void> {
    const gates = stoppable && event.outcome === 'success' ? this.listeners.flatMap((listener) => gateOf(listener, event)) : [];
    await Promise.all(gates.map((gate) => this.required(gate, event)));
    const first = gates.map((gate) => gate.listener);
    await Promise.allSettled(this.listeners.filter((listener) => !first.includes(listener)).map((listener) => this.deliver(listener, event)));
  }

  // Running out of time counts as a failure: a blocking listener that does not answer has not taken the event.
  private async required({ listener, take }: Gate, event: AuthnEvent): Promise<void> {
    try {
      await this.pipeline.execute(() => Promise.resolve().then(take));
    } catch (err) {
      const name = listener.constructor.name;
      this.log().warn({ listener: name, eventType: event.type, errorClass: errorClass(err) }, 'AuthnAudit: blocking listener ${listener} stopped a ${eventType} event (${errorClass})');
      throw new AuthnListenerFailed(name, event.type, err);
    }
  }

  // Logs the error class only: a listener's error message can echo event values.
  private async deliver(listener: AuthnEventListener, event: AuthnEvent): Promise<void> {
    const name = listener.constructor.name;
    try {
      await this.pipeline.execute(() => Promise.resolve().then(() => listener.on(event)));
    } catch (err) {
      if (err instanceof TimeoutRejectedException) this.log().warn({ listener: name, eventType: event.type, timeoutMs: this.timeoutMs }, 'AuthnAudit: listener ${listener} timed out on a ${eventType} event after ${timeoutMs} ms');
      else this.log().warn({ listener: name, eventType: event.type, errorClass: errorClass(err) }, 'AuthnAudit: listener ${listener} failed on a ${eventType} event (${errorClass})');
    }
  }

  private async flushed(listener: AuthnEventListener): Promise<void> {
    if (!listener.flush) return;

    try {
      await this.pipeline.execute(() => Promise.resolve().then(() => listener.flush?.()));
    } catch (err) {
      this.log().warn({ listener: listener.constructor.name, errorClass: errorClass(err) }, 'AuthnAudit: listener ${listener} could not flush (${errorClass})');
    }
  }
}

const SILENT: Pick<Log, 'warn'> = { warn: () => undefined };

/**
 * Every AuthnEventListener registered in the container's lineage gets every event (A21). Listeners run concurrently,
 * each bounded by `listenerTimeoutMs`, so a stuck listener holds up a login for that long at most. One per container,
 * so a child boot reads its own `authn.audit` and listeners.
 */
@PerChildInstance()
export class AuthnAudit extends AsyncService {
  @Config('authn.audit')
  protected Config: AuditConfig;

  @Logger('authn-audit')
  protected Log: Log;

  // A child that registers its own listener keeps its ancestors' ones; each is built where it was registered.
  @Autoinject(Array.chainOf(AuthnEventListener))
  protected Listeners: AuthnEventListener[];

  private delivery!: ListenerDelivery;

  /** The same delivery over explicit listeners, for a service built outside DI with its listeners passed in. */
  public static over(listeners: readonly AuthnEventListener[], options: AuthnAuditOverOptions = {}): AuthnAuditor & Pick<AuthnAudit, 'publishDetached' | 'settled'> {
    const log = options.log ?? SILENT;
    return new ListenerDelivery(Object.freeze([...listeners]), options.listenerTimeoutMs ?? 2000, () => log);
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');

    const listeners = Object.freeze([...this.Listeners]);
    if (listeners.length === 0) this.Log.warn('AuthnAudit: no AuthnEventListener is registered; authentication events are neither recorded nor acted on');
    // Neither bounded nor caught: a listener that cannot work, such as a recorder whose trail does not exist, fails the boot.
    for (const listener of listeners) await listener.ready?.();

    this.delivery = new ListenerDelivery(listeners, config.listenerTimeoutMs, () => this.Log);
    await super.resolve();
  }

  public listeners(): readonly AuthnEventListener[] {
    this.assertResolved();
    return this.delivery.listeners;
  }

  /** Rejects only with AuthnListenerFailed: a blocking listener did not take a success event. */
  public async publish(e: AuthnEvent): Promise<void> {
    this.assertResolved();
    await this.delivery.publish(e);
  }

  /** Publishes `body` stamped with the context's `now`, `ip` and `userAgent`. Rejects as `publish` does. */
  public publishIn(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): Promise<void> {
    return this.publish(stamped(ctx, body));
  }

  /** Fire-and-forget: listener errors and timeouts are logged as by `publishIn`; returns at once. */
  public publishDetached(ctx: Pick<AuthnContext, 'now' | 'ip' | 'userAgent'>, body: AuthnEventBody): void {
    this.assertResolved();
    this.delivery.publishDetached(ctx, body);
  }

  /** Resolves when every detached delivery started so far has settled and every buffering listener has flushed. For tests and graceful shutdown. */
  public settled(): Promise<void> {
    return this.Resolved ? this.delivery.settled() : Promise.resolve();
  }

  /** Waits for the detached deliveries and the flushes, each bounded by `listenerTimeoutMs`, so a shutdown does not drop events. */
  public override async dispose(): Promise<void> {
    await this.settled();
    await super.dispose();
  }

  private assertResolved(): void {
    if (!this.Resolved) throw new InvalidOperation('AuthnAudit is not resolved');
  }
}

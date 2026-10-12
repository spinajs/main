import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { frozenCopy } from '@spinajs/util';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent, AuthnEventType } from '../contracts/audit.js';
import type { AuditConfig } from './config.js';

export interface AuthnAuditOptions {
  /** Uniform in [0, 1); decides which sampled events are published. */
  readonly random?: () => number;
}

const SAMPLED: readonly AuthnEventType[] = ['token.use', 'key.use'];

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * Every AuthnEventSink registered in the container's lineage gets every event (A21). Sinks run one at a time, each
 * bounded by `sinkTimeoutMs`, so a stuck sink cannot hold up a login. One per container, so a child boot reads its own
 * `authn.audit` and sinks.
 */
@PerChildInstance()
@Inject(Container)
export class AuthnAudit extends AsyncService {
  @Config('authn.audit')
  protected Config: AuditConfig;

  private all: readonly AuthnEventSink[] | undefined;
  private sampleUse = 0;
  private timeoutMs!: number;
  private readonly random: () => number;

  private log!: Log;

  /** `options` is for tests; DI passes only the container. */
  constructor(private readonly container: IContainer, options: AuthnAuditOptions = {}) {
    super();

    this.random = options.random ?? Math.random;
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    this.log = this.container.resolve(Log, ['authn-audit'], true);
    // A child that registers its own sink keeps its ancestors' ones; each is built where it was registered.
    const sinks = await this.container.resolve(Array.chainOf(AuthnEventSink));
    if (sinks.length === 0) this.log.warn('AuthnAudit: no AuthnEventSink is registered; authentication events are not audited');

    this.sampleUse = config.sampleUse;
    this.timeoutMs = config.sinkTimeoutMs;
    this.all = Object.freeze([...sinks]);
    await super.resolve();
  }

  /** In publish order. */
  public sinks(): readonly AuthnEventSink[] {
    return this.state();
  }

  /** Never rejects because of a sink. */
  public async publish(e: AuthnEvent): Promise<void> {
    const sinks = this.state();

    // TODO: shold not be all sampled ? why random rejections ? remove randomness from production code !
    if (SAMPLED.includes(e.type) && e.outcome === 'success' && !this.sampled()) return;

    //TODO Should run in paraller, explain why in serial
    // Each sink gets its own copy: a frozen Date can still be changed with setTime.
    for (const sink of sinks) await this.deliver(sink, frozenCopy(e));
  }

  // Logs the error class only: a sink's error message can echo event values.
  private async deliver(sink: AuthnEventSink, event: AuthnEvent): Promise<void> {
    const name = sink.constructor.name;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // TODO: instead manual timeout watych - use resilience lib in spinajs/util
    try {
      const done = Promise.resolve()
        .then(() => sink.publish(event))
        .then(() => 'done' as const);
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      });
      if ((await Promise.race([done, timeout])) === 'timeout') {
        done.catch(() => undefined);
        this.log.warn(`AuthnAudit: sink ${q(name)} timed out on a ${q(event.type)} event after ${this.timeoutMs} ms`);
      }
    } catch (err) {
      const kind = err instanceof Error ? err.name : typeof err;
      this.log.warn(`AuthnAudit: sink ${q(name)} failed to publish a ${q(event.type)} event (${kind})`);
    } finally {
      clearTimeout(timer);
    }
  }

  //TODO: remove radnomness, if its needed for testing - implement second class with this behaviour with shared code
  private sampled(): boolean {
    const r = this.random();
    return r >= 0 && r < 1 && r < this.sampleUse;
  }

  // TODO: services have resolved flag - use it DI is setting this flag when service is created
  private state(): readonly AuthnEventSink[] {
    if (!this.all) throw new InvalidOperation('AuthnAudit is not resolved');
    return this.all;
  }
}

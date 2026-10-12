import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { ResiliencePipelineBuilder, TimeoutRejectedException, TimeSpan, frozenCopy } from '@spinajs/util';
import type { ResiliencePipeline } from '@spinajs/util';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import { errorClass } from '../support/guards.js';
import type { AuditConfig } from './config.js';

// The log layout expands `${...}` inside a message.
const q = (v: unknown): string => (JSON.stringify(v) ?? String(v)).replace(/\$/g, '\\u0024');

/**
 * Every AuthnEventSink registered in the container's lineage gets every event (A21). Sinks run concurrently, each
 * bounded by `sinkTimeoutMs`, so a stuck sink cannot hold up a login. One per container, so a child boot reads its own
 * `authn.audit` and sinks.
 */
@PerChildInstance()
@Inject(Container)
export class AuthnAudit extends AsyncService {
  @Config('authn.audit')
  protected Config: AuditConfig;

  private all: readonly AuthnEventSink[] = [];
  private pipeline!: ResiliencePipeline<void>;
  private log!: Log;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    this.log = this.container.resolve(Log, ['authn-audit'], true);
    // A child that registers its own sink keeps its ancestors' ones; each is built where it was registered.
    const sinks = await this.container.resolve(Array.chainOf(AuthnEventSink));
    if (sinks.length === 0) this.log.warn('AuthnAudit: no AuthnEventSink is registered; authentication events are not audited');

    this.pipeline = new ResiliencePipelineBuilder<void>().addTimeout(TimeSpan.fromMilliseconds(config.sinkTimeoutMs)).build();
    this.all = Object.freeze([...sinks]);
    await super.resolve();
  }

  public sinks(): readonly AuthnEventSink[] {
    this.assertResolved();
    return this.all;
  }

  /** Never rejects because of a sink. */
  public async publish(e: AuthnEvent): Promise<void> {
    this.assertResolved();
    const event = frozenCopy(e);
    await Promise.allSettled(this.all.map((sink) => this.deliver(sink, event)));
  }

  // Logs the error class only: a sink's error message can echo event values.
  private async deliver(sink: AuthnEventSink, event: AuthnEvent): Promise<void> {
    const name = sink.constructor.name;
    try {
      await this.pipeline.execute(() => Promise.resolve().then(() => sink.publish(event)));
    } catch (err) {
      if (err instanceof TimeoutRejectedException) this.log.warn(`AuthnAudit: sink ${q(name)} timed out on a ${q(event.type)} event after ${this.Config.sinkTimeoutMs} ms`);
      else this.log.warn(`AuthnAudit: sink ${q(name)} failed to publish a ${q(event.type)} event (${errorClass(err)})`);
    }
  }

  private assertResolved(): void {
    if (!this.Resolved) throw new InvalidOperation('AuthnAudit is not resolved');
  }
}

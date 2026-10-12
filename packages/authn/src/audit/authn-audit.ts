import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent, AuthnEventType } from '../contracts/audit.js';
import { DEFAULT_AUDIT_SINK_TIMEOUT_MS } from './config.js';
import type { AuditConfig } from './config.js';
import { auditLog } from './log.js';
import type { AuditLog } from './log.js';

export interface AuthnAuditOptions {
  /** Uniform in [0, 1); decides which sampled events are published. */
  readonly random?: () => number;
  readonly log?: AuditLog;
}

const SAMPLED: readonly AuthnEventType[] = ['token.use', 'key.use'];

const MAX_COPY_DEPTH = 16;

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

// Each sink gets its own copy: a frozen Date can still be changed with setTime.
function frozenCopy(v: unknown, depth = 0): unknown {
  if (depth > MAX_COPY_DEPTH) return undefined;
  if (v instanceof Date) return Object.freeze(new Date(v.getTime()));
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x) => frozenCopy(x, depth + 1)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = frozenCopy(x, depth + 1);
  return Object.freeze(out);
}

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
  private timeoutMs = DEFAULT_AUDIT_SINK_TIMEOUT_MS;
  private readonly random: () => number;

  // TODO: log should be spinajs lib logger not AutidLog
  private readonly log: AuditLog;

  /** `options` is for tests; DI passes only the container. */
  constructor(private readonly container: IContainer, options: AuthnAuditOptions = {}) {
    super();

    this.random = options.random ?? Math.random;
    this.log = options.log ?? auditLog('authn-audit');
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
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
    //TODO frozenCopy shouyld live in spinajs util if not already
    for (const sink of sinks) await this.deliver(sink, frozenCopy(e) as AuthnEvent);
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

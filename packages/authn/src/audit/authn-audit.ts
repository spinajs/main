import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { AuthnEventSink } from '../contracts/audit.js';
import type { AuthnEvent, AuthnEventType } from '../contracts/audit.js';
import { DEFAULT_AUDIT_SINK_TIMEOUT_MS, readAuditConfig } from './config.js';
import { auditLog } from './log.js';
import type { AuditLog } from './log.js';

export interface AuthnAuditOptions {
  /** Uniform in [0, 1); decides which sampled events are published. */
  readonly random?: () => number;
  readonly log?: AuditLog;
}

interface Active {
  readonly name: string;
  readonly sink: AuthnEventSink;
}

const SAMPLED: readonly AuthnEventType[] = ['token.use', 'key.use'];

const MAX_COPY_DEPTH = 16;

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

const typeName = (t: unknown): string => {
  const n = (t as { name?: unknown }).name;
  return typeof n === 'string' ? n : '';
};

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
 * Every registered AuthnEventSink gets every event (A21); `authn.audit.sinks` names sinks that must be registered and
 * run first. Sinks run one at a time, each bounded by `sinkTimeoutMs`, so a stuck sink cannot hold up a login. One per
 * container, so a child boot reads its own `authn.audit` and sinks.
 */
@PerChildInstance()
@Inject(Container)
export class AuthnAudit extends AsyncService {
  private active: readonly Active[] | undefined;
  private all: readonly AuthnEventSink[] | undefined;
  private sampleUse = 0;
  private timeoutMs = DEFAULT_AUDIT_SINK_TIMEOUT_MS;
  private readonly random: () => number;
  private readonly log: AuditLog;

  /** `options` is for tests; DI passes only the container. */
  constructor(private readonly container: IContainer, options: AuthnAuditOptions = {}) {
    super();
    this.random = options.random ?? Math.random;
    this.log = options.log ?? auditLog('authn-audit');
  }

  public async resolve(): Promise<void> {
    if (this.active) return;
    const configuration = (await this.container.resolve(Configuration)) as Configuration | null;
    if (configuration === null || typeof configuration !== 'object' || typeof configuration.get !== 'function') {
      throw new InvalidOperation('AuthnAudit: the resolved Configuration has no get()');
    }
    const config = readAuditConfig(configuration.get('authn.audit'));
    // The whole lineage: a child that registers its own sink keeps its ancestors' sinks. resolveChain builds each sink
    // where it was registered (a root singleton stays the root's), per-child sinks here; both lists share one order.
    const types = this.container.getRegisteredTypesChain(AuthnEventSink) ?? [];
    const built = (await this.container.resolveChain(AuthnEventSink as unknown as Class<AuthnEventSink>)) as unknown[];
    const registered = types.map((type, i) => ({ type, sink: built[i] }));

    const order: { name: string; sink: unknown }[] = [];
    for (const name of new Set(config.sinks ?? [])) {
      const found = [...registered].reverse().find((r) => typeName(r.type) === name);
      if (!found) throw new InvalidOption(`authn.audit.sinks: no AuthnEventSink is registered as service ${q(name)}`);
      order.push({ name, sink: found.sink });
    }
    for (const r of registered) {
      if (!order.some((o) => o.sink === r.sink)) order.push({ name: typeName(r.type) || '(unnamed factory)', sink: r.sink });
    }

    const active: Active[] = [];
    for (const { name, sink } of order) {
      // Duck-typed: sinks built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
      if (sink === null || typeof sink !== 'object' || typeof (sink as AuthnEventSink).publish !== 'function') {
        throw new InvalidOption(`authn.audit: the service ${q(name)} is not an AuthnEventSink`);
      }
      if (!active.some((a) => a.sink === sink)) active.push({ name, sink: sink as AuthnEventSink });
    }
    if (active.length === 0) this.log.warn('AuthnAudit: no AuthnEventSink is registered; authentication events are not audited');

    this.sampleUse = config.sampleUse;
    this.timeoutMs = config.sinkTimeoutMs;
    this.active = Object.freeze(active);
    this.all = Object.freeze(active.map((a) => a.sink));
    await super.resolve();
  }

  /** In publish order. */
  public sinks(): readonly AuthnEventSink[] {
    this.state();
    return this.all!;
  }

  /** Never rejects because of a sink. */
  public async publish(e: AuthnEvent): Promise<void> {
    const active = this.state();
    if (SAMPLED.includes(e.type) && e.outcome === 'success' && !this.sampled()) return;
    for (const { name, sink } of active) await this.deliver(name, sink, frozenCopy(e) as AuthnEvent);
  }

  // Logs the error class only: a sink's error message can echo event values.
  private async deliver(name: string, sink: AuthnEventSink, event: AuthnEvent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
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

  private sampled(): boolean {
    const r = this.random();
    return r >= 0 && r < 1 && r < this.sampleUse;
  }

  private state(): readonly Active[] {
    if (!this.active) throw new InvalidOperation('AuthnAudit is not resolved');
    return this.active;
  }
}

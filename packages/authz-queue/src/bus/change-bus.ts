import { randomUUID } from 'node:crypto';

import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { ChangeBus, engineLog } from '@spinajs/authz';
import type { AuthzChange } from '@spinajs/authz';
import { Event, QueueEvent, QueueService } from '@spinajs/queue';

interface WireChange {
  domain?: unknown;
  tags?: unknown;
  actor?: unknown;
  at?: unknown;
}

/** What nodes send each other: the change, and the node that made it so that it can skip its own echo. */
@Event()
export class AuthzChangeEvent extends QueueEvent {
  public Node: string;
  public Change: WireChange;
}

/** Rebuilds a change that went through a JSON broker; undefined when it cannot be one. */
export function reviveChange(raw: unknown): AuthzChange | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const c = raw as WireChange;
  if (!Array.isArray(c.tags) || !c.tags.every((t) => typeof t === 'string')) return undefined;
  if (c.domain !== undefined && typeof c.domain !== 'string') return undefined;

  let actor: AuthzChange['actor'];
  if (c.actor !== undefined) {
    const a = c.actor as { type?: unknown; id?: unknown } | null;
    if (a === null || typeof a !== 'object' || typeof a.type !== 'string' || typeof a.id !== 'string') return undefined;
    actor = { type: a.type, id: a.id };
  }

  const at = new Date(typeof c.at === 'string' || typeof c.at === 'number' || c.at instanceof Date ? c.at : NaN);
  return {
    ...(c.domain === undefined ? {} : { domain: c.domain }),
    tags: [...(c.tags as string[])],
    ...(actor ? { actor } : {}),
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  };
}

/**
 * A ChangeBus that carries changes to the other nodes over the queue (design §14.2).
 * Select it with `authz.bus.service: 'QueueChangeBus'`. Subscribers on this node hear a change at once;
 * the copy that comes back from the broker is skipped.
 */
@Singleton()
@Injectable(ChangeBus)
export class QueueChangeBus extends ChangeBus {
  protected readonly node = randomUUID();
  private readonly subscribers = new Set<(c: AuthzChange) => void>();
  private readonly log = engineLog('authz-queue-bus');
  private queue?: Promise<QueueService>;
  private retried = false;
  private disposed = false;
  private timer?: NodeJS.Timeout;
  protected retryMs = 5000;

  @Config('authz.bus.topic')
  protected Topic: string | undefined;

  async publish(change: AuthzChange): Promise<void> {
    this.deliver(change);
    const queue = await this.start();
    const event = new AuthzChangeEvent();
    event.Node = this.node;
    event.Change = { domain: change.domain, tags: [...change.tags], actor: change.actor, at: change.at };
    await queue.emit(event);
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    const entry = (c: AuthzChange) => fn(c);
    this.subscribers.add(entry);
    this.listenWithRetry();
    return () => {
      this.subscribers.delete(entry);
    };
  }

  /** AuthzService subscribes once, at boot: a queue that is not ready yet must not leave the node deaf. */
  private listenWithRetry(): void {
    this.start().then(
      () => {
        // Changes made while the node was deaf are unknown: drop everything.
        if (this.retried) {
          this.retried = false;
          this.deliver({ tags: ['*'], at: new Date() });
        }
      },
      (err) => {
        this.log.error(`authz change bus: cannot listen on the queue, retrying: ${err instanceof Error ? err.message : String(err)}`);
        this.retried = true;
        if (this.disposed || this.timer) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (!this.disposed) this.listenWithRetry();
        }, this.retryMs);
        this.timer.unref?.();
      },
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.subscribers.clear();
    const started = this.queue;
    this.queue = undefined;
    if (started) await (await started.catch(() => undefined))?.stopConsuming(AuthzChangeEvent);
  }

  /** The node's QueueService, with the change listener attached once. */
  protected async queueService(): Promise<QueueService> {
    return DI.resolve(QueueService);
  }

  protected start(): Promise<QueueService> {
    if (this.queue === undefined) {
      this.queue = this.listen();
      // A failed start is retried by the next call.
      this.queue.catch(() => {
        this.queue = undefined;
      });
    }
    return this.queue;
  }

  private async listen(): Promise<QueueService> {
    const queue = await this.queueService();
    this.route();
    await queue.consume<AuthzChangeEvent>(AuthzChangeEvent, async (e) => {
      if (e.Node === this.node) return;
      const change = reviveChange(e.Change);
      if (change === undefined) {
        this.log.warn('authz change bus: dropped a malformed change');
        return;
      }
      this.deliver(change);
    });
    return queue;
  }

  /** `authz.bus.topic` becomes the channel of `AuthzChangeEvent` unless `queue.routing` already routes it. */
  private route(): void {
    const cfg = DI.get(Configuration);
    if (!cfg || cfg.get<unknown>(['queue', 'routing', AuthzChangeEvent.name]) !== undefined) return;
    const topic = this.Topic;
    if (topic === undefined) return;
    cfg.set(['queue', 'routing', AuthzChangeEvent.name], { channel: topic });
  }

  private deliver(change: AuthzChange): void {
    for (const fn of [...this.subscribers]) {
      try {
        const r = fn(change) as unknown;
        if (r !== null && typeof r === 'object' && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, (err) => this.fail(err));
      } catch (err) {
        this.fail(err);
      }
    }
  }

  private fail(err: unknown): void {
    this.log.error(`authz change subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

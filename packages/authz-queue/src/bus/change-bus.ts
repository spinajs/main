import { randomUUID } from 'node:crypto';

import { Autoinject, Container, DI, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ChangeBus, changeTagsField, engineLog, isValidField, thrownError } from '@spinajs/authz';
import type { AuthzChange } from '@spinajs/authz';
import { InvalidOperation } from '@spinajs/exceptions';
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
  if (!isValidField(changeTagsField, c.tags)) return undefined;
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
  /** The container that resolved the bus; undefined when it was built with new. */
  @Autoinject(Container)
  protected Container: IContainer | undefined;

  protected readonly node = randomUUID();
  private readonly subscribers = new Set<(c: AuthzChange) => void>();
  private readonly log = engineLog('authz-queue-bus');
  private queue?: Promise<QueueService>;
  private retried = false;
  private watching = false;
  private disposed = false;
  private timer?: NodeJS.Timeout;
  protected retryMs = 5000;

  async publish(change: AuthzChange): Promise<void> {
    this.deliver(change);
    const queue = await this.start();
    const event = new AuthzChangeEvent();
    event.Node = this.node;
    // The other nodes drop a change past the tag caps (reviveChange); every tag keeps their caches correct.
    const tags = isValidField(changeTagsField, change.tags) ? [...change.tags] : ['*'];
    event.Change = { domain: change.domain, tags, actor: change.actor, at: change.at };
    await queue.emit(event);
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    // A deaf subscriber would keep decisions another node revoked: fail the boot instead.
    if (this.disposed) throw new InvalidOperation('authz change bus: the bus is disposed, a subscriber would never hear the other nodes');
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
        this.log.error({ error: thrownError(err) }, 'authz change bus: cannot listen on the queue, retrying');
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
    this.Container?.removeListener('di.dispose', this.onContainerDispose);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.subscribers.clear();
    const started = this.queue;
    this.queue = undefined;
    if (started) await (await started.catch(() => undefined))?.stopConsuming(AuthzChangeEvent);
  }

  /** Resolved per start, not injected: a queue that cannot start yet must not fail the bus, which retries. */
  protected async queueService(): Promise<QueueService> {
    return DI.resolve(QueueService);
  }

  protected start(): Promise<QueueService> {
    // A disposed bus must not consume again: nothing would stop that consumer. Refused rather than dropped,
    // so a publisher learns that the other nodes keep their decisions.
    if (this.disposed) return Promise.reject(new InvalidOperation('authz change bus: the bus is disposed, the change is not sent to the other nodes'));
    this.watchDispose();
    if (this.queue === undefined) {
      this.queue = this.listen();
      // A failed start is retried by the next call.
      this.queue.catch(() => {
        this.queue = undefined;
      });
    }
    return this.queue;
  }

  /** Container.dispose() disposes Services only; this bus is a plain singleton and would keep its consumer and retry. */
  private watchDispose(): void {
    if (this.watching || this.Container === undefined) return;
    this.watching = true;
    this.Container.once('di.dispose', this.onContainerDispose);
  }

  // di.dispose comes after the container disposed its Services, the QueueService and the Configuration among them.
  private readonly onContainerDispose = (): void => {
    this.dispose().catch((err: unknown) =>
      this.log.warn({ error: thrownError(err) }, 'authz change bus: stopping the consumer at container dispose failed; a queue the container disposed first has closed its connections, so nothing is left to stop'),
    );
  };

  private async listen(): Promise<QueueService> {
    const queue = await this.queueService();
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
    this.log.error({ error: thrownError(err) }, 'authz change subscriber failed');
  }
}

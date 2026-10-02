import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Unauthenticated, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ISocketAuthConfig, ISocketAuthState, SocketPrincipalSource, SocketRevalidationResult, SocketRevalidationStatus } from './interfaces.js';
import { SocketConnection, isAuthState, isClientState } from './connection.js';

/** Revalidations the sweep keeps running at once; commands are never held back by it. */
export const MAX_CONCURRENT_REVALIDATIONS = 16;

const MAX_SWEEP_TICK_MS = 1_000;
const MAX_REVALIDATE_MS = 10_000;

interface IRevalidation {
  status: SocketRevalidationStatus;
  principal?: Principal;
  error?: Error;
}

function toRevalidation(result: SocketRevalidationResult): IRevalidation {
  if (result === true || result === 'valid') {
    return { status: 'valid' };
  }

  if (result === 'unavailable') {
    return { status: 'unavailable' };
  }

  if (typeof result === 'object' && result !== null && result.status === 'valid') {
    return { status: 'valid', principal: result.principal };
  }

  return { status: 'invalid' };
}

/**
 * Re-checks the principal of a live connection ( D16 ): before a command, and in one server-wide
 * sweep, so an idle connection stops receiving pushes once its credential expires or is revoked.
 */
@Injectable()
export class SocketPrincipalGuard {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket.auth')
  protected Options: ISocketAuthConfig;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  /** true when the connection may keep running; a command and the sweep share one check */
  protected pending = new WeakMap<SocketConnection, Promise<boolean>>();

  protected running = 0;

  /** bumped by stop(): a check of an earlier run must not touch the new run's counter or map */
  protected generation = 0;

  protected closing = new WeakSet<SocketConnection>();

  protected closingIds = new Set<string>();

  protected timer: ReturnType<typeof setInterval> | null = null;

  protected connections: () => Iterable<SocketConnection> = () => [];

  public start(connections: () => Iterable<SocketConnection>): void {
    this.stop();
    this.connections = connections;

    const revalidateMs = this.Options.revalidateMs;
    const tick = revalidateMs > 0 ? Math.min(revalidateMs, MAX_SWEEP_TICK_MS) : MAX_SWEEP_TICK_MS;
    this.timer = setInterval(() => {
      this.sweep().catch((err: Error) => this.Log.error(err, 'Socket principal sweep failed'));
    }, tick);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.generation++;
    this.closingIds.clear();
    this.running = 0;
    this.pending = new WeakMap();
  }

  /** One sweep tick; resolves when the revalidations it started have settled. */
  public async sweep(): Promise<void> {
    const now = Date.now();
    const started: Array<Promise<boolean>> = [];

    for (const connection of this.connections()) {
      if (connection.auth.source === null || !connection.connected || this.closing.has(connection)) {
        continue;
      }

      if (this.expired(connection, now)) {
        this.close(connection, 'credentials expired');
        continue;
      }

      // no break at the cap: the remaining connections still get their expiry checked
      if (this.due(connection, now) && !this.pending.has(connection) && this.running < MAX_CONCURRENT_REVALIDATIONS) {
        started.push(this.check(connection));
      }
    }

    await Promise.allSettled(started);
  }

  /** Ids of connections being closed; the hub excludes them from pushes. */
  public get ClosingIds(): ReadonlySet<string> {
    return this.closingIds;
  }

  /** Called once a connection is gone. */
  public release(connectionId: string): void {
    this.closingIds.delete(connectionId);
  }

  /** True once the guard decided to close the connection; it must receive no more pushes. */
  public isClosing(connection: SocketConnection): boolean {
    return this.closing.has(connection);
  }

  public async ensure(connection: SocketConnection): Promise<void> {
    if (connection.auth.source === null) {
      return;
    }

    const now = Date.now();
    if (this.expired(connection, now)) {
      this.refuse(connection, 'credentials expired');
    }

    if (this.closing.has(connection)) {
      this.refuse(connection, 'credentials are no longer valid');
    }

    if (!this.due(connection, now)) {
      return;
    }

    if (!(await (this.pending.get(connection) ?? this.check(connection)))) {
      this.refuse(connection, 'credentials are no longer valid');
    }

    // the check may have adopted a renewed principal that is already expired
    if (this.expired(connection, Date.now())) {
      this.refuse(connection, 'credentials expired');
    }
  }

  /**
   * @internal Whether a session stored by connection state recovery may be restored. socket.io writes its
   * missed packets before any middleware or `connection` handler runs, so this is the last place to refuse them.
   */
  public restorable(data: unknown): boolean {
    const state = data as { client?: unknown; auth?: unknown; revoked?: unknown } | null | undefined;
    if (!state || state.revoked === true || !isClientState(state.client) || !isAuthState(state.auth)) {
      return false;
    }

    const now = Date.now();
    return state.auth.source === null || (!this.expiredAt(state.auth, now) && !this.dueAt(state.auth, now));
  }

  protected expired(connection: SocketConnection, now: number): boolean {
    return this.expiredAt(connection.auth, now);
  }

  protected expiredAt(auth: ISocketAuthState, now: number): boolean {
    const expiresAt = auth.principal.ceiling?.expiresAt;
    // new Date(): a state restored through a serializing adapter carries the date as a string; NaN counts as expired
    return expiresAt != null && !(new Date(expiresAt).getTime() > now);
  }

  protected due(connection: SocketConnection, now: number): boolean {
    return this.dueAt(connection.auth, now);
  }

  protected dueAt(auth: ISocketAuthState, now: number): boolean {
    return this.Options.revalidateMs > 0 && now - (auth.unavailableSince ?? auth.checkedAt) >= this.Options.revalidateMs;
  }

  protected check(connection: SocketConnection): Promise<boolean> {
    const generation = this.generation;
    const pending = this.pending;
    this.running++;
    const check = this.revalidate(connection).finally(() => {
      if (generation === this.generation) {
        this.running--;
        pending.delete(connection);
      }
    });
    pending.set(connection, check);
    return check;
  }

  protected async revalidate(connection: SocketConnection): Promise<boolean> {
    const auth = connection.auth;
    const verdict = await this.ask(connection);

    if (verdict.status === 'valid') {
      auth.checkedAt = Date.now();
      delete auth.unavailableSince;
      if (verdict.principal) {
        auth.principal = verdict.principal;
      }
      return true;
    }

    if (verdict.status === 'unavailable' && auth.unavailableSince === undefined) {
      auth.unavailableSince = Date.now();
      const reason = `Socket ${connection.id}: source ${auth.source} could not revalidate its principal; the connection keeps running for one more ${this.Options.revalidateMs} ms`;
      if (verdict.error) {
        this.Log.warn(verdict.error, reason);
      } else {
        this.Log.warn(reason);
      }
      return true;
    }

    if (verdict.status === 'unavailable') {
      this.Log.warn(`Socket ${connection.id}: source ${auth.source} is still unavailable, closing after grace`);
    }
    this.close(connection, verdict.status === 'unavailable' ? 'its principal source is still unavailable' : 'credentials are no longer valid');
    return false;
  }

  protected async ask(connection: SocketConnection): Promise<IRevalidation> {
    const source = this.Sources.find((s) => s.name === connection.auth.source);
    if (!source) {
      return { status: 'invalid' };
    }

    const limit = this.Options.revalidateMs > 0 ? Math.min(this.Options.revalidateMs, MAX_REVALIDATE_MS) : MAX_REVALIDATE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`revalidate() of source ${source.name} timed out after ${limit} ms`)), limit);
      timer.unref?.();
    });

    let verdict: IRevalidation;
    try {
      // a late answer of a timed out call is dropped by the race
      verdict = toRevalidation(await Promise.race([source.revalidate(connection.handshake, connection.principal), timeout]));
    } catch (err) {
      return { status: 'unavailable', error: err as Error };
    } finally {
      clearTimeout(timer);
    }

    if (verdict.principal && principalKey(verdict.principal) !== principalKey(connection.principal)) {
      this.Log.warn(`Socket ${connection.id}: source ${source.name} revalidated it as another principal; refusing it`);
      return { status: 'invalid' };
    }

    return verdict;
  }

  /** setImmediate: a command reply refused by the same check is written first ( it goes out in a microtask ). */
  protected close(connection: SocketConnection, why: string): void {
    // before the early return: a session persisted by a drop that came first must not be restored either
    connection.markClosing();

    // the socket may have dropped while a revalidation was awaited; its id must not outlive the connection (recovery reuses ids)
    if (this.closing.has(connection) || connection.signal.aborted) {
      return;
    }

    this.closing.add(connection);
    this.closingIds.add(connection.id);
    this.Log.info(`Socket ${connection.id} closed: ${why}`);

    setImmediate(() => {
      if (connection.connected) {
        connection.disconnect('unauthenticated');
      }
    });
  }

  protected refuse(connection: SocketConnection, message: string): never {
    this.close(connection, message);
    throw new Unauthenticated(message);
  }
}

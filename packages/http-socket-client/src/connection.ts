import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { MAX_ID_LENGTH, PROTOCOL_VERSION, SYSTEM_EVENTS, WIRE_EVENTS, isSocketError, type EventFrame, type Handshake, type ShutdownNotice, type SocketError } from '@spinajs/http-socket-common';
import { Emitter } from './emitter.js';
import { ReconnectPolicy, type ReconnectOptions } from './reconnect.js';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'closed';

export interface AuthPayload {
  token?: string;
  [key: string]: unknown;
}

export type AuthProvider = () => AuthPayload | Promise<AuthPayload>;

export type IoOptions = Partial<ManagerOptions & SocketOptions>;

export interface ConnectionOptions {
  url: string;
  path?: string;
  clientId: string;
  auth?: AuthProvider;
  reconnect?: Partial<ReconnectOptions>;
  connectTimeoutMs?: number;
  io?: IoOptions;
  onListenerError?: (error: unknown) => void;
}

export interface ConnectionEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  auth_required: (error: SocketError) => void;
  incompatible: (error: SocketError) => void;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Sole owner of the socket.io socket: state machine, handshake, reconnect and stop conditions.
 * Commands, durable commands and streams use it and never touch socket.io directly.
 */
export class Connection {
  public readonly events: Emitter<ConnectionEvents>;
  private readonly socket: Socket;
  private readonly policy: ReconnectPolicy;
  private readonly connectTimeoutMs: number;
  private current: ConnectionState = 'offline';
  // no automatic attempt may start: before connect(), after disconnect()/close(), after a fatal refusal
  private stopped = true;
  private attempt = 0;
  // bumped whenever an attempt is abandoned, so a late auth callback cannot revive it
  private attemptId = 0;
  private retryAfterMs: number | undefined;
  private retryTimer: Timer | undefined;
  private connectTimer: Timer | undefined;

  constructor(private readonly options: ConnectionOptions) {
    // the server refuses such a handshake with invalid_argument, which no retry can fix
    if (typeof options.clientId !== 'string' || options.clientId.length === 0 || options.clientId.length > MAX_ID_LENGTH) {
      throw new RangeError(`clientId must be 1-${MAX_ID_LENGTH} characters`);
    }
    this.events = new Emitter<ConnectionEvents>(options.onListenerError);
    this.policy = new ReconnectPolicy(options.reconnect);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.socket = io(options.url, {
      ...options.io,
      ...(options.path !== undefined ? { path: options.path } : {}),
      autoConnect: false,
      // socket.io's Manager does not retry refused handshakes or server disconnects and cannot
      // honour retryAfterMs; one policy here covers all of them. Reusing this one Socket keeps its
      // pid/offset, which connection state recovery needs.
      reconnection: false,
      // a Manager multiplexed with another client to the same URL would share its failures and closes
      forceNew: true,
      // socket.io's packet retries would re-send commands without idempotency keys
      retries: 0,
      auth: (cb: (data: object) => void) => this.provideAuth(cb),
    });
    this.socket.on('connect', () => this.onConnect());
    this.socket.on('connect_error', (error: Error) => this.onConnectError(error));
    this.socket.on('disconnect', () => this.onDisconnect());
    this.socket.on(WIRE_EVENTS.event, (frame: EventFrame) => this.onEventFrame(frame));
  }

  public get state(): ConnectionState {
    return this.current;
  }

  public get connected(): boolean {
    return this.current === 'online' && this.socket.connected;
  }

  public connect(): void {
    if (this.current === 'closed') throw new Error('the client is closed');
    this.stopped = false;
    this.retryAfterMs = undefined;
    if (this.current !== 'offline') return;
    this.attempt = 0;
    this.clearTimers();
    this.open();
  }

  public disconnect(): void {
    if (this.current === 'closed') return;
    this.stopped = true;
    this.abortAttempt();
    this.setState('offline');
  }

  public close(): void {
    if (this.current === 'closed') return;
    this.stopped = true;
    this.setState('closed');
    this.abortAttempt();
  }

  public send(event: string, ...args: unknown[]): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, ...args);
    return true;
  }

  public request<R>(event: string, data: unknown, onReply: (reply: R) => void): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, data, onReply);
    return true;
  }

  public listen(event: string, handler: (...args: any[]) => void): () => void {
    this.socket.on(event, handler);
    return () => {
      this.socket.off(event, handler);
    };
  }

  private open(): void {
    this.attemptId++;
    this.setState('connecting');
    // a state listener may have closed or stopped the connection
    if (this.current !== 'connecting' || this.stopped) return;
    this.connectTimer = setTimeout(() => this.onConnectTimeout(), this.connectTimeoutMs);
    this.socket.connect();
  }

  private provideAuth(cb: (data: object) => void): void {
    const attemptId = this.attemptId;
    Promise.resolve()
      .then(() => this.options.auth?.())
      .then(
        (extra) => {
          if (attemptId !== this.attemptId) return;
          const handshake: Handshake = { ...extra, protocol: PROTOCOL_VERSION, clientId: this.options.clientId };
          cb(handshake);
        },
        (error: unknown) => {
          if (attemptId !== this.attemptId) return;
          const reason = error instanceof Error ? error.message : String(error);
          this.halt('auth_required', { code: 'unauthenticated', message: `auth callback failed: ${reason}`, retryable: false });
        },
      );
  }

  private onConnect(): void {
    if (this.stopped || this.current === 'closed') {
      this.socket.disconnect();
      return;
    }
    this.clearTimers();
    this.attempt = 0;
    this.retryAfterMs = undefined;
    this.setState('online');
  }

  private onConnectError(error: Error): void {
    this.clearConnectTimer();
    if (this.stopped) return;
    const data = (error as Error & { data?: unknown }).data;
    if (isSocketError(data)) {
      if (data.code === 'unauthenticated') return this.halt('auth_required', data);
      if (data.code === 'version_mismatch') return this.halt('incompatible', data);
      if (data.retryAfterMs !== undefined) this.retryAfterMs = data.retryAfterMs;
    }
    this.scheduleRetry();
  }

  private onDisconnect(): void {
    // socket.io re-sends what it buffered during a drop once it reconnects; only the durable
    // queue may re-send a command, and only with an idempotency key
    this.socket.sendBuffer = [];
    if (this.current === 'closed') return;
    this.setState('offline');
    if (!this.stopped) this.scheduleRetry();
  }

  private onEventFrame(frame: EventFrame): void {
    if (frame?.name !== SYSTEM_EVENTS.shutdown) return;
    const retryAfterMs = (frame.payload as Partial<ShutdownNotice> | undefined)?.retryAfterMs;
    if (typeof retryAfterMs === 'number') this.retryAfterMs = retryAfterMs;
  }

  private onConnectTimeout(): void {
    this.connectTimer = undefined;
    this.abortAttempt();
    this.scheduleRetry();
  }

  private halt(event: 'auth_required' | 'incompatible', error: SocketError): void {
    this.stopped = true;
    this.abortAttempt();
    this.setState('offline');
    this.events.emit(event, error);
  }

  private scheduleRetry(): void {
    this.clearTimers();
    this.setState('offline');
    // a state listener may have closed or stopped the connection
    if (this.current !== 'offline' || this.stopped) return;
    const delay = this.policy.delay(this.attempt++, this.retryAfterMs);
    this.retryAfterMs = undefined;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && this.current === 'offline') this.open();
    }, delay);
  }

  private abortAttempt(): void {
    this.attemptId++;
    this.clearTimers();
    this.socket.disconnect();
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.events.emit('state', next, previous);
  }
}

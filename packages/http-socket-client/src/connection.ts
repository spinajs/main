import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { PROTOCOL_VERSION, type Handshake } from '@spinajs/http-socket-common';
import { Emitter } from './emitter.js';

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
  io?: IoOptions;
  onListenerError?: (error: unknown) => void;
}

export interface ConnectionEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
}

export class Connection {
  public readonly events: Emitter<ConnectionEvents>;
  private readonly socket: Socket;
  private current: ConnectionState = 'offline';
  private attemptId = 0;

  constructor(private readonly options: ConnectionOptions) {
    this.events = new Emitter<ConnectionEvents>(options.onListenerError);
    this.socket = io(options.url, {
      ...options.io,
      ...(options.path !== undefined ? { path: options.path } : {}),
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      retries: 0,
      auth: (cb: (data: object) => void) => this.provideAuth(cb),
    });
    this.socket.on('connect', () => this.setState('online'));
    this.socket.on('connect_error', () => this.setState('offline'));
    this.socket.on('disconnect', () => {
      if (this.current !== 'closed') this.setState('offline');
    });
  }

  public get state(): ConnectionState {
    return this.current;
  }

  public get connected(): boolean {
    return this.current === 'online' && this.socket.connected;
  }

  public connect(): void {
    if (this.current === 'closed') throw new Error('the client is closed');
    if (this.current !== 'offline') return;
    this.open();
  }

  public disconnect(): void {
    if (this.current === 'closed') return;
    this.abortAttempt();
    this.setState('offline');
  }

  public close(): void {
    if (this.current === 'closed') return;
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
        () => {
          if (attemptId !== this.attemptId) return;
          this.abortAttempt();
          this.setState('offline');
        },
      );
  }

  private abortAttempt(): void {
    this.attemptId++;
    this.socket.disconnect();
  }

  private setState(next: ConnectionState): void {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.events.emit('state', next, previous);
  }
}

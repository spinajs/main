import { SocketError } from './errors.js';

export const PROTOCOL_VERSION = 1;

/** Longest accepted command / cancel id. */
export const MAX_ID_LENGTH = 128;

/** Longest accepted command / event name. */
export const MAX_NAME_LENGTH = 128;

/** Characters a command / event name may use: names end up in log lines and metric labels. */
export const NAME_PATTERN = /^[\w.:-]+$/;

export const WIRE_EVENTS = {
  /** client → server, answered through the socket.io ack */
  command: 'cmd',
  /** either direction, fire-and-forget */
  event: 'evt',
  /** server → client stream frames (W4) */
  chunk: 'chunk',
  end: 'end',
  fail: 'fail',
  /** client → server */
  credit: 'credit',
  cancel: 'cancel',
} as const;

export type WireEventName = (typeof WIRE_EVENTS)[keyof typeof WIRE_EVENTS];

/** Names of server events sent as `evt` frames. */
export const SYSTEM_EVENTS = {
  shutdown: 'sys.shutdown',
  disconnect: 'sys.disconnect',
} as const;

export type SystemEventName = (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS];

/**
 * `io(url, { auth })`. A refused handshake rejects with a `connect_error` whose `data` is a
 * `SocketError` (`version_mismatch`, `invalid_argument`, `unauthenticated`).
 */
export interface Handshake {
  protocol: number;
  clientId: string;
  token?: string;
  [key: string]: unknown;
}

export interface CommandRequest<P = unknown> {
  id: string;
  name: string;
  payload: P;
  idempotencyKey?: string;
  /**
   * Milliseconds the caller is still willing to wait, measured from when the request was sent.
   * Relative on purpose: client and server clocks never have to agree.
   */
  deadline?: number;
  traceparent?: string;
}

export interface CommandResultReply<R = unknown> {
  id: string;
  ok: true;
  /** `null` when the handler returned nothing. */
  result: R;
}

/** The result follows as `chunk` frames (W4). */
export interface CommandStreamReply {
  id: string;
  ok: true;
  stream: true;
}

export interface CommandErrorReply {
  id: string;
  ok: false;
  error: SocketError;
}

export type CommandReply<R = unknown> = CommandResultReply<R> | CommandStreamReply | CommandErrorReply;

export interface EventFrame<P = unknown> {
  name: string;
  payload: P;
}

export interface Chunk<D = unknown> {
  id: string;
  seq: number;
  data: D;
}

/** `seq` is the number of chunks sent. */
export interface StreamEnd {
  id: string;
  seq: number;
}

export interface StreamFail {
  id: string;
  error: SocketError;
}

export interface StreamCredit {
  id: string;
  credits: number;
}

/** Cancels a running command or stream with this request id. */
export interface CancelFrame {
  id: string;
}

export interface ShutdownNotice {
  retryAfterMs: number;
}

export interface DisconnectNotice {
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value);
}

export function isCommandRequest(value: unknown): value is CommandRequest {
  if (!isRecord(value)) {
    return false;
  }

  return isId(value.id) && isName(value.name) && (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string') && (value.deadline === undefined || (typeof value.deadline === 'number' && Number.isFinite(value.deadline))) && (value.traceparent === undefined || typeof value.traceparent === 'string');
}

export function isEventFrame(value: unknown): value is EventFrame {
  return isRecord(value) && isName(value.name);
}

export function isCancelFrame(value: unknown): value is CancelFrame {
  return isRecord(value) && isId(value.id);
}

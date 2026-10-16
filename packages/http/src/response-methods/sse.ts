import * as express from 'express';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
// import from the defining module, not the package barrel ( see file.ts: the barrel re-forms an import cycle )
import { _setCoockies, _setHeaders } from '../responses.js';

export const SSE_DEFAULT_HEARTBEAT_MS = 15_000;

export interface ISseEvent {
  id?: string | number;
  event?: string;
  data: unknown;
}

export interface ISseResponseOptions extends IResponseOptions {
  /**
   * Interval of the `: ping` comment in ms, 0 disables it.
   */
  HeartbeatMs?: number;
}

export type SseHandler = (stream: SseStream, req: express.Request) => Promise<void> | void;

const OPEN_STREAMS = new Set<SseStream>();
const SERVER_CLOSING_EVENT = 'http.server.closing';

export function closeAllSseStreams(): void {
  for (const stream of [...OPEN_STREAMS]) {
    // HttpServer.stop() already closed idle sockets; a kept-alive one would hold it for the keep-alive timeout
    stream.close({ dropConnection: true });
  }
}

function installShutdownHook() {
  // HttpServer.stop() waits for in-flight requests; an open stream would hold shutdown until its watchdog fires.
  // Checked on every open because disposing the root container may drop its listeners.
  if (!DI.RootContainer.listeners(SERVER_CLOSING_EVENT).includes(closeAllSseStreams)) {
    DI.on(SERVER_CLOSING_EVENT, closeAllSseStreams);
  }
}

export class SseStream {
  private _closed = false;
  private _heartbeat: NodeJS.Timeout | null = null;
  private readonly _onClose: Array<() => void> = [];

  constructor(private readonly res: express.Response, private readonly heartbeatMs: number) {}

  public get Closed(): boolean {
    return this._closed;
  }

  public open(): void {
    this.res.status(HTTP_STATUS_CODE.OK);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform makes the compression middleware pass events through instead of buffering them
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
    this.res.on('close', () => this.close());

    // 'close' does not fire for a client that left before the listener was attached
    if (this.res.destroyed || this.res.writableEnded) {
      this.close();
      return;
    }

    if (this.heartbeatMs > 0) {
      this._heartbeat = setInterval(() => this.comment('ping'), this.heartbeatMs);
      this._heartbeat.unref?.();
    }

    installShutdownHook();
    OPEN_STREAMS.add(this);
  }

  public send(event: ISseEvent): void {
    // a line break would start a new SSE field, e.g. an injected data: line
    if (/[\r\n]/.test(`${event.id ?? ''}${event.event ?? ''}`)) {
      throw new InvalidArgument('SSE event name and id cannot contain a line break');
    }

    if (this._closed) {
      return;
    }

    let frame = '';
    if (event.id !== undefined) {
      frame += `id: ${event.id}\n`;
    }
    if (event.event) {
      frame += `event: ${event.event}\n`;
    }

    const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    for (const line of payload.split(/\r?\n/)) {
      frame += `data: ${line}\n`;
    }

    this.write(`${frame}\n`);
  }

  public comment(text: string): void {
    if (!this._closed) {
      this.write(`: ${text}\n\n`);
    }
  }

  public onClose(callback: () => void): void {
    if (this._closed) {
      callback();
      return;
    }

    this._onClose.push(callback);
  }

  public close(options?: { dropConnection?: boolean }): void {
    if (this._closed) {
      return;
    }

    this._closed = true;
    OPEN_STREAMS.delete(this);

    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }

    for (const callback of this._onClose.splice(0)) {
      callback();
    }

    if (!this.res.writableEnded) {
      if (options?.dropConnection) {
        // the response detaches its socket on finish, and the compression middleware's end() drops callbacks
        const socket = this.res.socket;
        this.res.once('finish', () => socket?.destroy());
        this.res.end();
      } else {
        this.res.end();
      }
    }
  }

  private write(chunk: string) {
    this.res.write(chunk);
    (this.res as express.Response & { flush?: () => void }).flush?.();
  }
}

/**
 * Streams Server-Sent Events. The handler may keep using the stream after it returns;
 * the response ends when the handler or the client closes the stream.
 */
export class SseResponse extends Response {
  private readonly heartbeatMs: number;

  constructor(protected handler: SseHandler, options?: ISseResponseOptions) {
    super(null, options);
    this.heartbeatMs = options?.HeartbeatMs ?? SSE_DEFAULT_HEARTBEAT_MS;
  }

  public async execute(req: express.Request, res: express.Response): Promise<void> {
    const stream = new SseStream(res, this.heartbeatMs);

    if (this.options?.Coockies?.length) {
      _setCoockies(res, this.options);
    }
    _setHeaders(res, this.options);
    stream.open();

    try {
      await this.handler(stream, req);
    } catch (err) {
      // headers are already sent, so the http error handler can no longer answer
      stream.send({ event: 'stream-error', data: { message: (err as Error).message } });
      stream.close();
    }
  }
}

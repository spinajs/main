import * as net from 'node:net';
import pg from 'pg';

/** The backend's identity from its BackendKeyData message: what a CancelRequest must quote. */
export interface IPostgresCancelKey {
  readonly processID: number;
  readonly secretKey: number;
}

/** A pooled client that keeps its backend's cancel key while its socket is open; pg's typed API does not expose it. */
export class CancellableClient extends pg.Client {
  public cancelKey: IPostgresCancelKey | undefined;

  constructor(config?: pg.ClientConfig) {
    super(config);
    this.connection.once('backendKeyData', (key: IPostgresCancelKey) => {
      this.cancelKey = { processID: key.processID, secretKey: key.secretKey };
    });
    // a socket closed by a connection error leaves no statement to stop, or no route to the server
    this.connection.once('end', () => {
      this.cancelKey = undefined;
    });
  }
}

const CANCEL_REQUEST_CODE = 80877102;

// pg-pool reads an AcquireTimeout of 0 as "wait for ever", which a socket nobody awaits must never do
export const CANCEL_TIMEOUT_FALLBACK_MS = 5000;

function cancelRequest(key: IPostgresCancelKey): Buffer {
  const message = Buffer.alloc(16);
  message.writeInt32BE(16, 0);
  message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  message.writeInt32BE(key.processID, 8);
  message.writeInt32BE(key.secretKey, 12);
  return message;
}

/**
 * Sends PostgreSQL's CancelRequest on a connection of its own, in plain text before any TLS, as pg does: the
 * server reads it in place of a startup packet. Resolves with the failure instead of rejecting.
 *
 * @param timeoutMs - how long the whole exchange may take; not positive or not finite: `CANCEL_TIMEOUT_FALLBACK_MS`
 */
export function sendCancelRequest(host: string, port: number, key: IPostgresCancelKey, timeoutMs: number): Promise<Error | undefined> {
  const bound = timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : CANCEL_TIMEOUT_FALLBACK_MS;

  return new Promise((resolve) => {
    let failure: Error | undefined;
    const socket = host.startsWith('/') ? net.connect({ path: `${host}/.s.PGSQL.${port}` }) : net.connect({ host, port });
    socket.unref();
    const timer = setTimeout(() => socket.destroy(new Error(`cancel request to ${host}:${port} got no answer in ${bound} ms`)), bound);
    timer.unref();
    socket.once('error', (err) => {
      failure = err;
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(failure);
    });
    socket.once('connect', () => socket.end(cancelRequest(key)));
  });
}

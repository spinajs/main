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
 */
export function sendCancelRequest(host: string, port: number, key: IPostgresCancelKey, timeoutMs: number): Promise<Error | undefined> {
  return new Promise((resolve) => {
    let failure: Error | undefined;
    const socket = host.startsWith('/') ? net.connect({ path: `${host}/.s.PGSQL.${port}` }) : net.connect({ host, port });
    socket.unref();
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`cancel request to ${host}:${port} got no answer in ${timeoutMs} ms`)));
    socket.once('error', (err) => {
      failure = err;
    });
    socket.once('close', () => resolve(failure));
    socket.once('connect', () => socket.end(cancelRequest(key)));
  });
}

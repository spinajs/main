import http from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface RawExchange {
  readonly response: Promise<RawResponse>;
  write(chunk: Buffer): void;
  end(chunk?: Buffer): void;
  /** Whether the response head has arrived. */
  answered(): boolean;
}

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request over node:http on a keep-alive agent of its own, so only the server decides whether the connection
 * closes. superagent cannot do this: it always sends Content-Length for a Buffer and cannot pause mid-body.
 */
export function rawRequest(port: number, method: string, path: string, headers: http.OutgoingHttpHeaders): RawExchange {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let answered = false;
  const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent });
  const response = new Promise<RawResponse>((resolve, reject) => {
    req.once('error', (err) => {
      agent.destroy();
      reject(err);
    });
    req.once('response', (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        agent.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
  });
  return {
    response,
    write: (chunk) => {
      req.write(chunk);
    },
    end: (chunk) => {
      if (chunk) req.end(chunk);
      else req.end();
    },
    answered: () => answered,
  };
}

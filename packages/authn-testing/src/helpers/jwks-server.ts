import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KitKeyPair } from '../harness/index.js';

export interface JwksServer {
  readonly url: string;
  hits(): number;
  setKeys(keys: readonly KitKeyPair[]): void;
  close(): Promise<void>;
}

/** GET /jwks.json on 127.0.0.1, ephemeral port; counts every GET, whatever its path. */
export async function startJwksServer(keys: readonly KitKeyPair[]): Promise<JwksServer> {
  let current = keys;
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      hits += 1;
    }
    if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: current.map((k) => ({ ...k.publicJwk, kid: k.kid, alg: k.alg, use: 'sig' })) }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    hits: () => hits,
    setKeys(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}

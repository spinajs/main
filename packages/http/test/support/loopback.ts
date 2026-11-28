import { expect } from 'chai';
import { once } from 'node:events';
import http from 'node:http';

const servers = new Set<http.Server>();

/**
 * Starts `app` on 127.0.0.1 and gives its origin for `chai.request`. Given the app itself, chai-http calls
 * `listen(0)` without a host, which opens the test server on every network interface.
 */
export async function loopbackOrigin(app: http.RequestListener): Promise<string> {
  const server = http.createServer(app);
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`not a TCP address: ${String(address)}`);
  expect(address.address, 'the test server binds loopback only').to.eq('127.0.0.1');
  return `http://127.0.0.1:${address.port}`;
}

export function closeLoopbackServers(): void {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers.clear();
}

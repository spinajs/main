import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as http from 'http';
import { AddressInfo } from 'net';
import { LocalAssetServer } from '../src/asset-server.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

// minimal Log stub - the server only traces/warns
const log: any = {
  trace: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('LocalAssetServer', () => {
  it('serves files from the base path on a loopback port', async () => {
    const server = new LocalAssetServer(log, () => undefined);
    const s = await server.serve(process.cwd());
    try {
      const port = (s.address() as AddressInfo).port;
      expect(port).to.be.greaterThan(0);
      // package.json exists at cwd; it must be served
      const res = await get(port, '/package.json');
      expect(res.status).to.eq(200);
      expect(res.body).to.contain('templates-puppeteer');
    } finally {
      await server.close(s);
    }
  });

  it('binds to loopback only (OS-assigned port when no range)', async () => {
    const server = new LocalAssetServer(log, () => undefined);
    const s = await server.serve(process.cwd());
    try {
      expect((s.address() as AddressInfo).address).to.eq('127.0.0.1');
    } finally {
      await server.close(s);
    }
  });

  it('honors a configured port range', async () => {
    const server = new LocalAssetServer(log, () => [8171, 8180]);
    const s = await server.serve(process.cwd());
    try {
      const port = (s.address() as AddressInfo).port;
      expect(port).to.be.gte(8171);
      expect(port).to.be.lte(8180);
    } finally {
      await server.close(s);
    }
  });

  it('close() resolves and stops serving', async () => {
    const server = new LocalAssetServer(log, () => undefined);
    const s = await server.serve(process.cwd());
    const port = (s.address() as AddressInfo).port;

    await server.close(s);

    await expect(get(port, '/package.json')).to.be.rejected;
  });
});

import 'mocha';
import { expect } from 'chai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Configuration } from '@spinajs/configuration';

import { appEnvOf } from '../src/providers.js';
import { readOidcOptions } from './support/oidc-config.js';
import { FetchOidcHttpClient } from '../src/http/client.js';
import { flowCookie } from '../src/flow/cookie.js';

const generic = { issuer: 'http://localhost:8080/realms/corp', clientId: 'canvas', clientSecret: { secret: 'S'.repeat(32) } };

/** A Configuration as Configuration.load leaves it when no env source was given: APP_ENV fell back to development. */
const fellBack = { get: (path: string) => (path === 'process.env.APP_ENV' ? 'development' : undefined) } as unknown as Configuration;
const named = (env: string) => ({ Env: env, get: (path: string) => (path === 'process.env.APP_ENV' ? env : undefined) }) as unknown as Configuration;

describe('authn-oidc without any app env (SR-16)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['APP_ENV', 'NODE_ENV']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('SR-16 an env-less deployment accepts only https OIDC endpoints and a Secure __Host- flow cookie', () => {
    expect(appEnvOf(fellBack)).to.eq(undefined);
    expect(() => readOidcOptions({ providers: { a: generic } }, appEnvOf(fellBack))).to.throw();
    const cookie = flowCookie({ v: 1, p: 'a', s: 'x'.repeat(43), t: Math.floor(Date.now() / 1000), r: '/', u: 'https://app.example.test/auth/oidc/a/callback', m: 'login' }, appEnvOf(fellBack));
    expect(cookie.Name).to.eq('__Host-spinajs-oidc');
    expect(cookie.Options).to.deep.include({ secure: true, path: '/' });
  });

  it('a named development env still accepts http endpoints', () => {
    expect(appEnvOf(named('development'))).to.eq('development');
    expect(readOidcOptions({ providers: { a: generic } }, appEnvOf(named('development'))).providers.get('a')!.issuer).to.eq(generic.issuer);
  });

  describe('the default http client', () => {
    let url = '';
    let hits = 0;
    let close: () => Promise<void> = async () => undefined;

    before(async () => {
      const server = createServer((_req, res) => {
        hits++;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    });

    after(async () => close());

    class ClientOver extends FetchOidcHttpClient {
      constructor(private readonly config: Configuration) {
        super();
      }
      protected configuration(): Configuration {
        return this.config;
      }
    }

    it('refuses http when the Configuration fell back to development, and allows it for a named one', async () => {
      const before = hits;
      let failed = false;
      await new ClientOver(fellBack).getJson(`${url}/json`).catch(() => (failed = true));
      expect(failed).to.eq(true);
      expect(hits).to.eq(before);
      expect(await new ClientOver(named('test')).getJson(`${url}/json`)).to.deep.eq({ status: 200, json: { ok: true } });
    });
  });
});

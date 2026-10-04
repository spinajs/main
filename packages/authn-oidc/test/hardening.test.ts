import 'mocha';
import { expect } from 'chai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import { readOidcOptions } from '../src/config/options.js';
import { OidcDiscovery } from '../src/discovery.js';
import { FetchOidcHttpClient, OIDC_HTTP_MAX_BODY_BYTES } from '../src/http/client.js';
import { OidcJwks } from '../src/jwks.js';
import { appPathOrNull } from '../src/flow/cookie.js';
import { FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';

const SECRET = 'SUPER-SECRET-VALUE-42';
const generic = { issuer: 'https://idp.example.test', clientId: 'canvas', clientSecret: { secret: SECRET } };

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  return expect.fail('expected a rejection');
}

describe('authn-oidc hardening', () => {
  describe('app paths', () => {
    it('refuses control characters, spaces and backslashes anywhere in a redirect or returnTo', () => {
      for (const path of ['/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/ /evil.example', '/a\\b', '/a\u007f', '/a\u0000']) {
        expect(() => readOidcOptions({ providers: {}, redirects: { success: path } }, undefined), JSON.stringify(path)).to.throw();
        expect(appPathOrNull(path), JSON.stringify(path)).to.eq(null);
      }
      expect(readOidcOptions({ providers: {}, redirects: { success: '/app?x=1&y=%20' } }, undefined).redirects.success).to.eq('/app?x=1&y=%20');
    });
  });

  describe('config', () => {
    it('refuses a port outside 1–65535 in a domain or host', () => {
      for (const domain of ['corp.auth0.com:0', 'corp.auth0.com:65536', 'corp.auth0.com:99999', 'corp.auth0.com:080']) {
        expect(() => readOidcOptions({ providers: { a: { preset: 'auth0', domain, clientId: 'c', clientSecret: { secret: SECRET } } } }, undefined), domain).to.throw();
      }
      expect(readOidcOptions({ providers: { a: { preset: 'auth0', domain: 'corp.auth0.com:65535', clientId: 'c', clientSecret: { secret: SECRET } } } }, undefined).providers.get('a')!.issuer).to.eq('https://corp.auth0.com:65535/');
    });

    it('refuses an issuer with a control character the URL parser would drop', () => {
      expect(() => readOidcOptions({ providers: { a: { ...generic, issuer: 'https://idp.example.test/real\tms' } } }, undefined)).to.throw();
    });

    it('keeps the client secret readable but out of JSON and inspect output', () => {
      const p = readOidcOptions({ providers: { a: generic } }, undefined).providers.get('a')!;
      expect(p.clientSecret.secret).to.eq(SECRET);
      expect(JSON.stringify(p)).to.not.contain(SECRET);
      expect(inspect(p, { depth: 10 })).to.not.contain(SECRET);
    });

    it('warns about a provider linking switch when no global switches are given (they default to off)', () => {
      const warnings: string[] = [];
      readOidcOptions({ providers: { a: { ...generic, linking: { jit: true } } } }, undefined, { log: { warn: (m) => warnings.push(m) } });
      expect(warnings).to.have.length(1);
    });
  });

  describe('time and header guards', () => {
    it('refuses a time that is not finite instead of refetching', async () => {
      const idp = await FakeIdp.create();
      await rejects(new OidcDiscovery(FAKE_ISSUER, idp, false).metadata(Number.NaN));
      await rejects(new OidcJwks(idp.jwksUri, idp, false).key({ alg: 'RS256' }, Number.NaN));
      expect(idp.requests).to.have.length(0);
    });

    it('refuses a kid that is not a string', async () => {
      const idp = await FakeIdp.create();
      await rejects(new OidcJwks(idp.jwksUri, idp, false).key({ alg: 'RS256', kid: 42 as unknown as string }, Date.now()));
      expect(idp.requests).to.have.length(0);
    });
  });

  describe('fetch client (loopback test server)', () => {
    let url: string;
    let close: () => Promise<void>;
    let hits = 0;

    before(async () => {
      const server = createServer((req, res) => {
        hits += 1;
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (path === '/json') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, method: req.method }));
        } else if (path === '/redirect') {
          res.writeHead(302, { location: '/json', 'content-type': 'application/json' }).end('{}');
        } else if (path === '/html') {
          res.writeHead(200, { 'content-type': 'text/html' }).end('{"ok":true}');
        } else if (path === '/big') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(`"${'x'.repeat(OIDC_HTTP_MAX_BODY_BYTES)}"`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end('not json');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
    });

    after(async () => close());

    it('refuses http outside development and test without sending anything', async () => {
      const before = hits;
      await rejects(new FetchOidcHttpClient(false).getJson(`${url}/json`));
      expect(hits).to.eq(before);
      await rejects(new FetchOidcHttpClient(true).getJson('ftp://127.0.0.1/x'));
    });

    it('fetches JSON over http in development and test, GET and POST', async () => {
      const client = new FetchOidcHttpClient(true);
      expect(await client.getJson(`${url}/json`)).to.deep.eq({ status: 200, json: { ok: true, method: 'GET' } });
      expect(await client.postForm(`${url}/json`, { a: 'b' })).to.deep.eq({ status: 200, json: { ok: true, method: 'POST' } });
    });

    it('fails on a redirect, a non-JSON content type or body, and a body over the cap', async () => {
      const client = new FetchOidcHttpClient(true);
      for (const path of ['/redirect', '/html', '/garbage', '/big']) {
        await rejects(client.getJson(`${url}${path}`));
      }
    });
  });
});

import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import sinon from 'sinon';
import express from 'express';
import { InvalidOption } from '@spinajs/exceptions';

import { CorsMiddleware, parseOrigin } from '../src/middlewares/Cors.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';

chai.use(chaiHttp);

const PARTNER = 'https://partner.example.test';
const EVIL = 'https://evil.example.test';

/** A CorsMiddleware reading `http.cors` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(cors: unknown) {
  const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], cors === undefined ? {} : { http: { cors } });
  const mw = readingFrom(new CorsMiddleware(), child);
  const warn = sinon.stub();
  Object.defineProperty(mw, 'Log', { value: { warn } });
  return { mw, warn };
}

async function app(cors: unknown) {
  const handler = (await middleware(cors)).mw.before();
  const a = express();
  if (handler) a.use(handler);
  a.all('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

const simple = async (cors: unknown, origin: string) => chai.request(await app(cors)).get('/probe').set('Origin', origin);
const preflight = async (cors: unknown, origin: string) =>
  chai.request(await app(cors)).options('/probe').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

const acHeaders = (res: { header: Record<string, string> }) => Object.keys(res.header).filter((n) => n.startsWith('access-control-'));

describe('CorsMiddleware (A31)', () => {
  afterEach(disposeBooted);

  it('A31 without http.cors installs no middleware and warns', async () => {
    for (const cors of [undefined, null, false, true]) {
      const { mw, warn } = await middleware(cors);
      expect(mw.before(), String(cors)).to.eq(null);
      expect(warn.calledOnce).to.eq(true);
    }
  });

  it('SR-12 an empty CORS list reflects no origin', async () => {
    for (const cors of [{ origins: [] }, { origins: null }, {}]) {
      const s = await simple(cors, EVIL);
      expect(s.status, JSON.stringify(cors)).to.eq(200);
      expect(acHeaders(s), JSON.stringify(cors)).to.deep.eq([]);
      const p = await preflight(cors, EVIL);
      expect(acHeaders(p), JSON.stringify(cors)).to.deep.eq([]);
    }
  });

  it('A31 a listed origin is echoed with credentials and Vary: Origin', async () => {
    const res = await simple({ origins: [PARTNER] }, PARTNER);
    expect(res.status).to.eq(200);
    expect(res.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(res.header['access-control-allow-credentials']).to.eq('true');
    expect(res.header['vary']).to.match(/(^|,\s*)origin(\s*,|$)/i);
  });

  it("A31 a listed origin's preflight is answered", async () => {
    const res = await preflight({ origins: [PARTNER] }, PARTNER);
    expect(res.status).to.eq(204);
    expect(res.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(res.header['access-control-allow-credentials']).to.eq('true');
    expect(res.header['access-control-allow-methods']).to.contain('POST');
    expect(res.header['access-control-allow-headers']).to.eq('content-type');
  });

  it('A31 a listed origin matches exactly: scheme, host and port', async () => {
    for (const origin of [`${PARTNER}:8443`, PARTNER.replace('https:', 'http:'), PARTNER.replace('//', '//sub.'), `${PARTNER}.evil.test`, 'https://partner.example', EVIL, 'null']) {
      const s = await simple({ origins: [PARTNER] }, origin);
      expect(s.status, origin).to.eq(200);
      expect(acHeaders(s), origin).to.deep.eq([]);
      expect(s.header['vary'], origin).to.match(/origin/i);
      expect(acHeaders(await preflight({ origins: [PARTNER] }, origin)), origin).to.deep.eq([]);
    }
  });

  it('A31 a listed origin compares as a URL origin: case of scheme and host, default port, trailing slash', async () => {
    expect((await simple({ origins: ['HTTPS://Partner.Example.Test:443/'] }, PARTNER)).header['access-control-allow-origin']).to.eq(PARTNER);
  });

  it('A31 a request without Origin gets no CORS headers', async () => {
    const res = await chai.request(await app({ origins: [PARTNER] })).get('/probe');
    expect(res.status).to.eq(200);
    expect(acHeaders(res)).to.deep.eq([]);
  });

  it("A31 '*' is never combined with credentials", async () => {
    const res = await simple({ origins: ['*'] }, EVIL);
    expect(res.header['access-control-allow-origin']).to.eq('*');
    expect(res.header['access-control-allow-credentials']).to.eq(undefined);
    const p = await preflight({ origins: ['*'] }, EVIL);
    expect(p.header['access-control-allow-origin']).to.eq('*');
    expect(p.header['access-control-allow-credentials']).to.eq(undefined);
  });

  it("A31 with '*' and explicit origins, only a listed origin gets credentials", async () => {
    const cors = { origins: ['*', PARTNER] };
    const listed = await simple(cors, PARTNER);
    expect(listed.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(listed.header['access-control-allow-credentials']).to.eq('true');
    const other = await simple(cors, EVIL);
    expect(other.header['access-control-allow-origin']).to.eq('*');
    expect(other.header['access-control-allow-credentials']).to.eq(undefined);
    expect(other.header['vary']).to.match(/origin/i);
  });

  it('A31 exposedHeaders and allowedHeaders apply to allowed origins only', async () => {
    const cors = { origins: [PARTNER], exposedHeaders: ['x-request-id', 'x-total'], allowedHeaders: ['content-type', 'x-csrf'] };
    expect((await simple(cors, PARTNER)).header['access-control-expose-headers']).to.eq('x-request-id,x-total');
    expect((await preflight(cors, PARTNER)).header['access-control-allow-headers']).to.eq('content-type,x-csrf');
    expect(acHeaders(await simple(cors, EVIL))).to.deep.eq([]);
  });

  it('A31 a listed origin is never allowed to send Forwarded or X-Forwarded-* headers', async () => {
    const ask = async (cors: unknown, headers: string) =>
      chai.request(await app(cors)).options('/probe').set('Origin', PARTNER).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', headers);

    const echoed = await ask({ origins: [PARTNER] }, 'content-type, X-Forwarded-Host, x-forwarded-proto, forwarded, x-forwarded-for');
    expect(echoed.status).to.eq(204);
    expect(echoed.header['access-control-allow-headers']).to.eq('content-type');

    const onlyProxy = await ask({ origins: [PARTNER] }, 'x-forwarded-host');
    expect(onlyProxy.header['access-control-allow-headers']).to.eq(undefined);

    const configured = await ask({ origins: [PARTNER], allowedHeaders: ['content-type', 'X-Forwarded-Host', 'Forwarded'] }, 'content-type, x-forwarded-host');
    expect(configured.header['access-control-allow-headers']).to.eq('content-type');
  });

  it('A31 an origin entry that is not a URL origin fails the boot', async () => {
    for (const entry of ['partner.example.test', 'localhost:3000', 'null', '', 'https://partner.example.test/app', 'https://partner.example.test?x=1', 'https://*.example.test', 'https://user@partner.example.test']) {
      expect(await violationsOf([HTTP_CONFIGURATION_SCHEMA], { http: { cors: { origins: [entry] } } }), entry).to.include('http.cors.origins.0');
    }
    expect(await violationsOf([HTTP_CONFIGURATION_SCHEMA], { http: { cors: { origins: 'https://a.example' } } })).to.include('http.cors.origins');
  });

  it('A31 an origin entry the schema lets through but URL refuses fails when the middleware is built', async () => {
    for (const entry of ['http://app.example.test:99999', 'http://app:port', 'http://[::1']) {
      const { mw } = await middleware({ origins: [entry] });
      expect(() => mw.before(), entry).to.throw(InvalidOption, 'http.cors.origins');
    }
  });
});

describe('parseOrigin', () => {
  it('gives the serialized origin: lower case, default port and trailing slash dropped', () => {
    expect(parseOrigin('HTTPS://Partner.Example.Test:443/')).to.eq(PARTNER);
    expect(parseOrigin('http://localhost:8889')).to.eq('http://localhost:8889');
    expect(parseOrigin('http://app.example.test:80')).to.eq('http://app.example.test');
    expect(parseOrigin('http://[::1]:8889')).to.eq('http://[::1]:8889');
  });

  it('refuses anything that is not an origin rather than cutting it down to one', () => {
    const values = [
      'partner.example.test', 'localhost:3000', 'null', '', 'http://', 'https://partner.example.test/app', 'https://partner.example.test?x=1',
      'https://partner.example.test#x', 'https://*.example.test', 'https://user@partner.example.test', 'http://evil.example\\app.example.test',
      'http://a b', 'http://app:port', 'data:text/plain,x', undefined, null, 1, ['https://a.example'],
    ];
    for (const value of values) expect(parseOrigin(value), String(value)).to.eq(undefined);
  });
});

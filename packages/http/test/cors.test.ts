import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import sinon from 'sinon';
import express from 'express';
import { InvalidOption } from '@spinajs/exceptions';

import { CorsMiddleware } from '../src/middlewares/Cors.js';

chai.use(chaiHttp);

const PARTNER = 'https://partner.example.test';
const EVIL = 'https://evil.example.test';

function middleware(cors: unknown) {
  const mw = new CorsMiddleware();
  const warn = sinon.stub();
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path === 'http.cors' ? cors : def) } });
  Object.defineProperty(mw, 'Log', { value: { warn } });
  return { mw, warn };
}

function app(cors: unknown) {
  const handler = middleware(cors).mw.before();
  const a = express();
  if (handler) a.use(handler);
  a.all('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

const simple = (cors: unknown, origin: string) => chai.request(app(cors)).get('/probe').set('Origin', origin);
const preflight = (cors: unknown, origin: string) =>
  chai.request(app(cors)).options('/probe').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

const acHeaders = (res: { header: Record<string, string> }) => Object.keys(res.header).filter((n) => n.startsWith('access-control-'));

describe('CorsMiddleware (A31)', () => {
  it('A31 without http.cors installs no middleware and warns', () => {
    for (const cors of [undefined, null, false]) {
      const { mw, warn } = middleware(cors);
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
    const res = await chai.request(app({ origins: [PARTNER] })).get('/probe');
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

  it('A31 an origin entry that is not a URL origin fails when the middleware is built', () => {
    for (const entry of ['partner.example.test', 'localhost:3000', 'null', '']) {
      expect(() => middleware({ origins: [entry] }).mw.before(), entry).to.throw(InvalidOption, 'http.cors.origins');
    }
    expect(() => middleware({ origins: 'https://a.example' }).mw.before()).to.throw(InvalidOption, 'http.cors.origins');
  });
});

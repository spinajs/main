import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { WEBHOOK_SIGNATURE_HEADER, WebhookAuthnEventSink, signWebhook } from '../src/index.js';
import type { AuthnWebhookTarget } from '../src/index.js';
import { configurationViolations, createTestApp, disposeTestApps } from '@spinajs/testing';

const SECRET = 'whsec-0123456789abcdef-0123456789abcdef';
const OTHER_SECRET = 'whsec-other-0123456789abcdef-0123456789';

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  readonly hits: Hit[];
  close(): Promise<void>;
}

type Respond = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A local HTTP server; `respond` decides the answer, and may leave the request hanging. */
async function receiver(respond: Respond = (_req, res) => void res.writeHead(204).end()): Promise<Receiver> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const event = (over: Partial<AuthnEvent> = {}): AuthnEvent => ({
  type: 'login',
  outcome: 'success',
  at: new Date('2026-10-03T10:00:00.000Z'),
  identity: { type: 'user', id: 'u-42' },
  strategy: 'local',
  ip: '198.51.100.23',
  ...over,
});

function sinkFor(targets: readonly AuthnWebhookTarget[]) {
  const sink = new WebhookAuthnEventSink();
  const warn = sinon.spy();
  Object.defineProperty(sink, 'Webhooks', { value: targets });
  Object.defineProperty(sink, 'Log', { value: { warn } });
  return { sink, warn };
}

const target = (url: string, over: Partial<AuthnWebhookTarget> = {}): AuthnWebhookTarget => ({ url, secret: { secret: SECRET }, ...over });

const logged = (warn: sinon.SinonSpy): string => JSON.stringify(warn.args);

describe('signWebhook', () => {
  it('signs "<t>.<body>" with HMAC-SHA256 and writes t and v1', () => {
    const body = '{"type":"login"}';
    const t = 1_760_000_000;
    const expected = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    expect(signWebhook(SECRET, body, t * 1000)).to.equal(`t=${t},v1=${expected}`);
  });

  it('truncates the time to whole seconds', () => {
    expect(signWebhook(SECRET, 'x', new Date(1_760_000_000_999))).to.match(/^t=1760000000,v1=[0-9a-f]{64}$/);
  });

  it('changes with the secret and the body', () => {
    const a = signWebhook(SECRET, 'x', 1000);
    expect(signWebhook(OTHER_SECRET, 'x', 1000)).to.not.equal(a);
    expect(signWebhook(SECRET, 'y', 1000)).to.not.equal(a);
  });

  it('names the header Spinajs-Signature', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).to.equal('Spinajs-Signature');
  });
});

describe('WebhookAuthnEventSink', function () {
  this.timeout(10000);

  const open: Receiver[] = [];
  const listen = async (respond?: Respond): Promise<Receiver> => {
    const r = await receiver(respond);
    open.push(r);
    return r;
  };

  afterEach(async () => {
    for (const r of open.splice(0)) await r.close();
  });

  it('POSTs one signed JSON request per matching event', async () => {
    const rx = await listen();
    const { sink, warn } = sinkFor([target(rx.url)]);

    const before = Math.floor(Date.now() / 1000);
    await sink.publish(event());
    const after = Math.floor(Date.now() / 1000);

    expect(rx.hits).to.have.length(1);
    const [hit] = rx.hits;
    expect(hit.method).to.equal('POST');
    expect(hit.path).to.equal('/hook');
    expect(hit.headers['content-type']).to.match(/^application\/json/);

    const header = String(hit.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    expect(m, header).to.not.equal(null);
    const t = Number(m![1]);
    expect(t).to.be.within(before, after);
    expect(m![2]).to.equal(createHmac('sha256', SECRET).update(`${t}.${hit.body}`).digest('hex'));
    expect(warn.callCount).to.equal(0);
  });

  it('signs for each target with its own secret and delivers each matching event once', async () => {
    const a = await listen();
    const b = await listen();
    const { sink } = sinkFor([target(a.url), target(b.url, { secret: { secret: OTHER_SECRET } })]);

    await sink.publish(event());
    await sink.publish(event({ type: 'logout' }));

    for (const [rx, secret] of [[a, SECRET], [b, OTHER_SECRET]] as const) {
      expect(rx.hits).to.have.length(2);
      for (const hit of rx.hits) {
        const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(hit.headers['spinajs-signature']))!;
        expect(v1).to.equal(createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex'));
      }
    }
  });

  it('drops events whose type a target does not list, and sends all types to a target with no list', async () => {
    const filtered = await listen();
    const everything = await listen();
    const { sink } = sinkFor([target(filtered.url, { types: ['login', 'mfa.verify'] }), target(everything.url)]);

    await sink.publish(event({ type: 'login' }));
    await sink.publish(event({ type: 'logout' }));
    await sink.publish(event({ type: 'mfa.verify' }));

    expect(filtered.hits.map((h) => (JSON.parse(h.body) as { type: string }).type)).to.deep.equal(['login', 'mfa.verify']);
    expect(everything.hits).to.have.length(3);
  });

  it('treats an empty type list as a filter that matches nothing', async () => {
    const rx = await listen();
    const { sink } = sinkFor([target(rx.url, { types: [] })]);
    await sink.publish(event());
    expect(rx.hits).to.have.length(0);
  });

  it('posts nothing and does not fail when no webhook is configured', async () => {
    const { sink, warn } = sinkFor([]);
    await sink.publish(event());
    expect(warn.callCount).to.equal(0);
  });

  it('sends the event as it is: no field it did not have, and no secret', async () => {
    const rx = await listen();
    const { sink } = sinkFor([target(rx.url)]);
    const e = event({ data: { reason: 'support ticket' }, userAgent: 'curl/8', session: 'hdl_k3JxQ0bR7Tz' });

    await sink.publish(e);

    const body = JSON.parse(rx.hits[0].body) as Record<string, unknown>;
    expect(body).to.deep.equal(JSON.parse(JSON.stringify(e)));
    expect(rx.hits[0].body).to.not.contain(SECRET);

    const minimal = event();
    await sink.publish(minimal);
    expect(Object.keys(JSON.parse(rx.hits[1].body) as object).sort()).to.deep.equal(Object.keys(minimal).sort());
  });

  describe('a failing receiver', () => {
    it('logs a warn and resolves on HTTP 500', async () => {
      const rx = await listen((_req, res) => void res.writeHead(500).end('boom'));
      const { sink, warn } = sinkFor([target(rx.url)]);

      await sink.publish(event());

      expect(rx.hits).to.have.length(1);
      expect(warn.callCount).to.equal(1);
      expect(logged(warn)).to.contain('500').and.not.contain(SECRET);
    });

    it('logs a warn and resolves when the receiver does not answer within timeoutMs', async () => {
      const rx = await listen(() => undefined);
      const { sink, warn } = sinkFor([target(rx.url, { timeoutMs: 100 })]);

      const started = Date.now();
      await sink.publish(event());

      expect(Date.now() - started).to.be.lessThan(3000);
      expect(warn.callCount).to.equal(1);
      expect(logged(warn)).to.not.contain(SECRET);
    });

    it('logs a warn and resolves when the connection is refused', async () => {
      const rx = await listen();
      const url = rx.url;
      await rx.close();
      open.splice(open.indexOf(rx), 1);
      const { sink, warn } = sinkFor([target(url)]);

      await sink.publish(event());

      expect(warn.callCount).to.equal(1);
    });

    it('does not follow a redirect and counts it as a failure', async () => {
      const elsewhere = await listen();
      const rx = await listen((_req, res) => void res.writeHead(302, { location: elsewhere.url }).end());
      const { sink, warn } = sinkFor([target(rx.url)]);

      await sink.publish(event());

      expect(elsewhere.hits).to.have.length(0);
      expect(warn.callCount).to.equal(1);
    });

    it('does not log the URL query, which may carry a token', async () => {
      const rx = await listen((_req, res) => void res.writeHead(500).end());
      const { sink, warn } = sinkFor([target(`${rx.url}?token=url-token-value`)]);

      await sink.publish(event());

      expect(logged(warn)).to.not.contain('url-token-value');
    });

    it('still delivers to the other targets', async () => {
      const bad = await listen((_req, res) => void res.writeHead(500).end());
      const good = await listen();
      const { sink, warn } = sinkFor([target(bad.url), target(good.url)]);

      await sink.publish(event());

      expect(good.hits).to.have.length(1);
      expect(warn.callCount).to.equal(1);
    });

    it('never throws into publish for a malformed URL or an unusable secret', async () => {
      const { sink, warn } = sinkFor([target('not a url'), target('http://127.0.0.1:1/hook', { secret: { secret: '' } })]);

      await sink.publish(event());

      expect(warn.callCount).to.equal(2);
    });
  });
});

describe('authn.webhooks configuration', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];

  it('sets no webhook by default, and gives a target a 2000 ms timeout', async () => {
    expect((await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} })).config.get('authn.webhooks')).to.equal(undefined);

    const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { webhooks: [{ url: 'https://hooks.example.com/a', secret: { secret: SECRET }, types: ['login'] }] } } });
    expect(configuration.get('authn.webhooks')).to.deep.equal([{ url: 'https://hooks.example.com/a', secret: { secret: SECRET }, types: ['login'], timeoutMs: 2000 }]);
  });

  it('names a target without a secret, an empty secret, a bad URL or a bad timeout', async () => {
    const url = 'https://hooks.example.com/a';
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { webhooks: [{ url }] } } })).to.have.length.greaterThan(0);
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { webhooks: [{ url, secret: { secret: '' } }] } } })).to.include('authn.webhooks.0.secret.secret');
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { webhooks: [{ url: 'ftp://x/y', secret: { secret: SECRET } }] } } })).to.include('authn.webhooks.0.url');
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { webhooks: [{ url, secret: { secret: SECRET }, timeoutMs: 0 }] } } })).to.include('authn.webhooks.0.timeoutMs');
  });
});

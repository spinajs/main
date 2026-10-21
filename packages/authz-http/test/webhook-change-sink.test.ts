import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InProcessChangeBus } from '@spinajs/authz';
import type { AuthzChange } from '@spinajs/authz';

import { WEBHOOK_SIGNATURE_HEADER, signWebhook } from '../src/webhook/sign.js';
import { WebhookChangeSink } from '../src/webhook/change-sink.js';
import type { AuthzWebhookTarget } from '../src/webhook/change-sink.js';

const SECRET = 'whsec-0123456789abcdef-0123456789abcdef';
const OTHER_SECRET = 'whsec-other-0123456789abcdef-0123456789';

interface Hit {
  readonly method: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  readonly hits: Hit[];
  /** Resolves once `count` requests have arrived. */
  arrived(count: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

type Respond = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function receiver(respond: Respond = (_req, res) => void res.writeHead(204).end()): Promise<Receiver> {
  const hits: Hit[] = [];
  const waiting: (() => void)[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      respond(req, res);
      for (const w of waiting.splice(0)) w();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    async arrived(count, ms = 3000) {
      const deadline = Date.now() + ms;
      while (hits.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} requests, got ${hits.length}`);
        await new Promise<void>((ok) => {
          waiting.push(ok);
          setTimeout(ok, 25);
        });
      }
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const change = (over: Partial<AuthzChange> = {}): AuthzChange => ({ domain: 'root', tags: ['scope:doc:1', 'principal:user:u-1'], at: new Date('2026-10-03T10:00:00.000Z'), ...over });

function sinkFor(targets: readonly AuthzWebhookTarget[]) {
  const sink = new WebhookChangeSink();
  const warn = sinon.spy();
  Object.defineProperty(sink, 'Webhooks', { value: targets });
  Object.defineProperty(sink, 'Log', { value: { warn } });
  return { sink, warn };
}

const target = (url: string, over: Partial<AuthzWebhookTarget> = {}): AuthzWebhookTarget => ({ url, secret: { secret: SECRET }, ...over });

describe('authz-http signWebhook', () => {
  it('signs "<t>.<body>" with HMAC-SHA256 and writes t and v1', () => {
    const body = '{"kind":"authz.changed"}';
    const t = 1_760_000_000;
    const expected = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    expect(signWebhook(SECRET, body, t * 1000)).to.equal(`t=${t},v1=${expected}`);
    expect(WEBHOOK_SIGNATURE_HEADER).to.equal('Spinajs-Signature');
  });
});

describe('WebhookChangeSink', function () {
  this.timeout(10000);

  const open: Receiver[] = [];
  const listen = async (respond?: Respond): Promise<Receiver> => {
    const r = await receiver(respond);
    open.push(r);
    return r;
  };
  const stops: (() => void)[] = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const r of open.splice(0)) await r.close();
  });

  it('posts { kind, tags } with a valid signature for each ChangeBus publish', async () => {
    const rx = await listen();
    const { sink, warn } = sinkFor([target(rx.url)]);
    const bus = new InProcessChangeBus();
    stops.push(sink.start(bus));

    await bus.publish(change());
    await rx.arrived(1);

    expect(rx.hits).to.have.length(1);
    const [hit] = rx.hits;
    expect(hit.method).to.equal('POST');
    expect(hit.headers['content-type']).to.match(/^application\/json/);
    expect(JSON.parse(hit.body)).to.deep.include({ kind: 'authz.changed', tags: ['scope:doc:1', 'principal:user:u-1'] });

    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers['spinajs-signature']))!;
    expect(v1).to.equal(createHmac('sha256', SECRET).update(`${t}.${hit.body}`).digest('hex'));
    expect(warn.callCount).to.equal(0);
  });

  it('posts one request per publish and per target, each signed with its own secret', async () => {
    const a = await listen();
    const b = await listen();
    const { sink } = sinkFor([target(a.url), target(b.url, { secret: { secret: OTHER_SECRET } })]);
    const bus = new InProcessChangeBus();
    stops.push(sink.start(bus));

    await bus.publish(change());
    await bus.publish(change({ tags: ['scope:doc:2'] }));
    await Promise.all([a.arrived(2), b.arrived(2)]);

    for (const [rx, secret] of [[a, SECRET], [b, OTHER_SECRET]] as const) {
      expect(rx.hits.map((h) => (JSON.parse(h.body) as { tags: string[] }).tags)).to.have.deep.members([['scope:doc:1', 'principal:user:u-1'], ['scope:doc:2']]);
      for (const hit of rx.hits) {
        const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(hit.headers['spinajs-signature']))!;
        expect(v1).to.equal(createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex'));
      }
    }
  });

  it('sends only what the change carried, and no secret or actor', async () => {
    const rx = await listen();
    const { sink } = sinkFor([target(rx.url)]);

    await sink.deliver(change({ actor: { type: 'user', id: 'u-9' } }));

    const body = JSON.parse(rx.hits[0].body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).to.deep.equal(['at', 'domain', 'kind', 'tags']);
    expect(rx.hits[0].body).to.not.contain(SECRET).and.not.contain('u-9');

    await sink.deliver({ tags: ['x'], at: new Date(0) });
    expect(Object.keys(JSON.parse(rx.hits[1].body) as object).sort()).to.deep.equal(['at', 'kind', 'tags']);
  });

  it('stops posting after the returned function is called', async () => {
    const rx = await listen();
    const { sink } = sinkFor([target(rx.url)]);
    const bus = new InProcessChangeBus();
    const stop = sink.start(bus);

    await bus.publish(change());
    await rx.arrived(1);
    stop();
    await bus.publish(change());
    await new Promise((ok) => setTimeout(ok, 100));

    expect(rx.hits).to.have.length(1);
  });

  describe('a failing receiver', () => {
    it('logs a warn and resolves on HTTP 500', async () => {
      const rx = await listen((_req, res) => void res.writeHead(500).end('boom'));
      const { sink, warn } = sinkFor([target(rx.url)]);

      await sink.deliver(change());

      expect(rx.hits).to.have.length(1);
      expect(warn.callCount).to.equal(1);
      expect(JSON.stringify(warn.args)).to.contain('500').and.not.contain(SECRET);
    });

    it('logs a warn and resolves when the receiver does not answer within timeoutMs', async () => {
      const rx = await listen(() => undefined);
      const { sink, warn } = sinkFor([target(rx.url, { timeoutMs: 100 })]);

      const started = Date.now();
      await sink.deliver(change());

      expect(Date.now() - started).to.be.lessThan(3000);
      expect(warn.callCount).to.equal(1);
    });

    it('never throws for a malformed URL or an unusable secret, and still reaches the other targets', async () => {
      const good = await listen();
      const { sink, warn } = sinkFor([target('not a url'), target('http://127.0.0.1:1/hook', { secret: { secret: '' } }), target(good.url)]);

      await sink.deliver(change());

      expect(good.hits).to.have.length(1);
      expect(warn.callCount).to.equal(2);
    });

    it('does not turn a failing delivery into a failing publish', async () => {
      const rx = await listen((_req, res) => void res.writeHead(500).end());
      const { sink, warn } = sinkFor([target(rx.url)]);
      const bus = new InProcessChangeBus();
      stops.push(sink.start(bus));

      await bus.publish(change());
      await rx.arrived(1);

      await new Promise((ok) => setTimeout(ok, 50));
      expect(warn.callCount).to.equal(1);
    });
  });

  it('posts nothing when no webhook is configured', async () => {
    const { sink, warn } = sinkFor([]);
    const bus = new InProcessChangeBus();
    stops.push(sink.start(bus));

    await bus.publish(change());

    expect(warn.callCount).to.equal(0);
  });
});

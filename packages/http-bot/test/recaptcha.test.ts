import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { BotVerifier, BotVerifierRegistry } from '@spinajs/http';
import type { BotCheckInput } from '@spinajs/http';

import { RECAPTCHA_SITEVERIFY_URL, RecaptchaV2Verifier, RecaptchaV3Verifier } from '../src/index.js';
import { BOT_HTTP_MAX_BODY_BYTES } from '../src/fetch.js';

chai.use(chaiAsPromised);

const SECRET = 'Zq7secretXk2Lm9Pw';
const INPUT: BotCheckInput = { token: 'tok-abc', action: 'login', ip: '203.0.113.7' };

interface ILogStub {
  trace: sinon.SinonStub;
  debug: sinon.SinonStub;
  info: sinon.SinonStub;
  warn: sinon.SinonStub;
  error: sinon.SinonStub;
}

function logStub(): ILogStub {
  return { trace: sinon.stub(), debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
}

function withLog<T extends object>(verifier: T): { verifier: T; log: ILogStub } {
  const log = logStub();
  Object.defineProperty(verifier, 'Log', { value: log });
  return { verifier, log };
}

function v3(options: Record<string, unknown> = {}) {
  return withLog(new RecaptchaV3Verifier({ service: 'RecaptchaV3Verifier', name: 'recaptcha-v3', secret: SECRET, ...options } as any));
}

function v2(options: Record<string, unknown> = {}) {
  return withLog(new RecaptchaV2Verifier({ service: 'RecaptchaV2Verifier', name: 'recaptcha-v2', secret: SECRET, ...options } as any));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
}

const now = () => new Date().toISOString();

function answer(overrides: Record<string, unknown> = {}) {
  return { success: true, score: 0.9, action: 'login', challenge_ts: now(), hostname: 'app.example.com', ...overrides };
}

describe('http-bot: reCAPTCHA verifiers', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the siteverify request', () => {
    it('POSTs secret, response and remoteip as a form to siteverify, without following redirects', async () => {
      fetchStub.resolves(json(answer()));
      const { verifier } = v3();
      await verifier.verify(INPUT);

      expect(fetchStub.calledOnce).to.eq(true);
      const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
      expect(url).to.eq(RECAPTCHA_SITEVERIFY_URL);
      expect(url).to.eq('https://www.google.com/recaptcha/api/siteverify');
      expect(init.method).to.eq('POST');
      expect(init.redirect).to.eq('manual');
      expect(init.signal).to.be.instanceOf(AbortSignal);
      expect((init.headers as Record<string, string>)['content-type']).to.eq('application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body as string);
      expect(Object.fromEntries(form)).to.deep.eq({ secret: SECRET, response: 'tok-abc', remoteip: '203.0.113.7' });
    });

    it('leaves remoteip out without an ip', async () => {
      fetchStub.resolves(json(answer()));
      await v3().verifier.verify({ token: 't', action: 'login' });
      const form = new URLSearchParams((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(form.has('remoteip')).to.eq(false);
    });
  });

  describe('RecaptchaV3Verifier', () => {
    it('passes a successful answer with score >= minScore, the action, an expected hostname and a fresh challenge_ts', async () => {
      fetchStub.resolves(json(answer({ score: 0.5 })));
      const { verifier } = v3({ minScore: 0.5, expectedHostnames: ['app.example.com'] });
      expect(await verifier.verify(INPUT)).to.deep.eq({ result: 'passed', score: 0.5 });
    });

    it('fails a low score as low_score', async () => {
      fetchStub.resolves(json(answer({ score: 0.3 })));
      expect(await v3({ minScore: 0.5 }).verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'low_score', score: 0.3 });
    });

    it('defaults minScore to 0.5', async () => {
      fetchStub.resolves(json(answer({ score: 0.49 })));
      expect((await v3().verifier.verify(INPUT)).result).to.eq('failed');
    });

    it('fails an action mismatch', async () => {
      fetchStub.resolves(json(answer({ action: 'register' })));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'action_mismatch' });
    });

    it('fails an answer with no score', async () => {
      fetchStub.resolves(json(answer({ score: undefined })));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'no_score' });
    });

    it('fails a hostname mismatch when expectedHostnames is set, and accepts any hostname when not', async () => {
      fetchStub.resolves(json(answer({ hostname: 'evil.example.net' })));
      expect(await v3({ expectedHostnames: ['app.example.com'] }).verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'hostname_mismatch' });

      fetchStub.resolves(json(answer({ hostname: 'evil.example.net' })));
      expect((await v3().verifier.verify(INPUT)).result).to.eq('passed');
    });

    it('fails a stale token, and one with no valid challenge_ts', async () => {
      fetchStub.resolves(json(answer({ challenge_ts: new Date(Date.now() - 121_000).toISOString() })));
      expect(await v3({ maxAgeSeconds: 120 }).verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'stale_token' });

      fetchStub.resolves(json(answer({ challenge_ts: 'yesterday' })));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'stale_token' });
    });

    it('fails timeout-or-duplicate', async () => {
      fetchStub.resolves(json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'timeout-or-duplicate' });
    });

    it('fails an invalid token, and an unsuccessful answer with no codes', async () => {
      fetchStub.resolves(json({ success: false, 'error-codes': ['invalid-input-response'] }));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'invalid-input-response' });
      fetchStub.resolves(json({ success: false }));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'rejected' });
    });

    for (const code of ['invalid-input-secret', 'missing-input-secret']) {
      it(`is unavailable on ${code}, logged at error level as misconfiguration`, async () => {
        fetchStub.resolves(json({ success: false, 'error-codes': [code] }));
        const { verifier, log } = v3();
        expect(await verifier.verify(INPUT)).to.deep.eq({ result: 'unavailable', reason: 'misconfigured' });
        expect(log.error.calledOnce).to.eq(true);
        expect(String(log.error.firstCall.args[1])).to.match(/misconfigured/);
      });
    }
  });

  describe('RecaptchaV2Verifier', () => {
    it('ignores score and action', async () => {
      fetchStub.resolves(json({ success: true, challenge_ts: now(), hostname: 'app.example.com' }));
      expect(await v2().verifier.verify(INPUT)).to.deep.eq({ result: 'passed' });
      fetchStub.resolves(json(answer({ score: 0.1, action: 'other' })));
      expect(await v2().verifier.verify(INPUT)).to.deep.eq({ result: 'passed' });
    });

    it('checks hostname and age like v3', async () => {
      fetchStub.resolves(json(answer({ hostname: 'evil.example.net' })));
      expect((await v2({ expectedHostnames: ['app.example.com'] }).verifier.verify(INPUT)).result).to.eq('failed');
      fetchStub.resolves(json(answer({ challenge_ts: new Date(Date.now() - 600_000).toISOString() })));
      expect(await v2().verifier.verify(INPUT)).to.deep.eq({ result: 'failed', reason: 'stale_token' });
    });
  });

  describe('an unusable answer is unavailable', () => {
    const cases: [string, () => Promise<Response> | Response, string][] = [
      ['a non-2xx answer', () => json({ success: true }, { status: 500 }), 'status'],
      ['a 4xx answer', () => json({ success: true }, { status: 429 }), 'status'],
      ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'redirect'],
      ['a non-JSON content type', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'not_json'],
      ['a body that is not JSON', () => new Response('{nope', { status: 200, headers: { 'content-type': 'application/json' } }), 'not_json'],
      ['an oversized body', () => new Response(JSON.stringify({ success: true, pad: 'x'.repeat(BOT_HTTP_MAX_BODY_BYTES) }), { status: 200, headers: { 'content-type': 'application/json' } }), 'too_large'],
      ['an answer without success', () => json({ ok: true }), 'invalid_answer'],
    ];

    for (const [name, make, reason] of cases) {
      it(name, async () => {
        fetchStub.callsFake(async () => make());
        expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'unavailable', reason });
      });
    }

    it('a timeout', async () => {
      fetchStub.callsFake((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))));
      expect(await v3({ timeoutMs: 20 }).verifier.verify(INPUT)).to.deep.eq({ result: 'unavailable', reason: 'timeout' });
    });

    it('a network failure', async () => {
      fetchStub.rejects(new TypeError('fetch failed'));
      expect(await v3().verifier.verify(INPUT)).to.deep.eq({ result: 'unavailable', reason: 'network' });
    });
  });

  describe('configuration', () => {
    it('refuses an empty secret', () => {
      expect(() => new RecaptchaV3Verifier({ service: 'RecaptchaV3Verifier', name: 'r', secret: '' })).to.throw(InvalidOption, 'secret');
      expect(() => new RecaptchaV2Verifier({ service: 'RecaptchaV2Verifier', name: 'r' } as any)).to.throw(InvalidOption, 'secret');
    });

    it('refuses an endpoint that is not https', () => {
      expect(() => new RecaptchaV3Verifier({ service: 'RecaptchaV3Verifier', name: 'r', secret: SECRET, endpoint: 'http://www.google.com/recaptcha/api/siteverify' })).to.throw(InvalidOption, 'https');
    });

    it('takes its name from the config entry', () => {
      expect(v3().verifier.Name).to.eq('recaptcha-v3');
      expect(v3().verifier.ServiceName).to.eq('recaptcha-v3');
    });

    it('is built from http.bot.verifiers by name, one instance per entry', async () => {
      const values = {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        http: {
          bot: {
            verifiers: [
              { service: 'RecaptchaV3Verifier', name: 'score', secret: 's1', minScore: 0.7 },
              { service: 'RecaptchaV3Verifier', name: 'score-strict', secret: 's2', minScore: 0.9 },
              { service: 'RecaptchaV2Verifier', name: 'challenge', secret: 's3' },
            ],
          },
        },
      };
      const SpecConfiguration = configurationOf(values);
      DI.uncache(Configuration);
      DI.register(SpecConfiguration).as(Configuration);
      try {
        await DI.resolve(Configuration);
        const registry = await DI.resolve(BotVerifierRegistry);
        const verifiers = registry.Verifiers;
        const minScore = (name: string) => (verifiers.get(name) as unknown as { MinScore: number }).MinScore;
        expect([...verifiers.keys()]).to.deep.eq(['score', 'score-strict', 'challenge']);
        expect(verifiers.get('score')).to.be.instanceOf(RecaptchaV3Verifier).and.instanceOf(BotVerifier);
        expect(minScore('score')).to.eq(0.7);
        expect(minScore('score-strict')).to.eq(0.9);
        expect(verifiers.get('challenge')).to.be.instanceOf(RecaptchaV2Verifier);
      } finally {
        DI.unregister(SpecConfiguration);
        DI.uncache(SpecConfiguration);
        DI.uncache(Configuration);
        DI.uncache(BotVerifierRegistry);
      }
    });
  });

  describe('the secret', () => {
    it('never appears in a log line, whatever the outcome', async () => {
      const outcomes: (() => Promise<Response> | Response)[] = [
        () => json({ success: false, 'error-codes': ['invalid-input-secret'] }),
        () => json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
        () => json(answer({ score: 0.1 })),
        () => json({ success: true }, { status: 503 }),
        () => new Response(null, { status: 302, headers: { location: 'https://x.example/' } }),
        () => {
          throw new TypeError(`fetch failed ${SECRET}`);
        },
      ];
      for (const outcome of outcomes) {
        fetchStub.callsFake(async () => outcome());
        const { verifier, log } = v3();
        await verifier.verify(INPUT);
        for (const stub of Object.values(log) as sinon.SinonStub[]) {
          for (const call of stub.getCalls()) {
            expect(JSON.stringify(call.args, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v))).to.not.include(SECRET);
          }
        }
      }
    });
  });
});

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

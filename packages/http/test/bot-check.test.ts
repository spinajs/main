import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import {
  BaseController,
  BasePath,
  Body,
  BotCheck,
  BotCheckFailed,
  BotCheckMiddleware,
  BotCheckService,
  BotVerifier,
  BOT_TOKEN_MAX_LENGTH,
  CONTROLLED_DESCRIPTOR_SYMBOL,
  FromBody,
  HttpAcceptHeaders,
  Ok,
  Post,
  HTTP_CONFIGURATION_SCHEMA,
} from '../src/index.js';
import type { BotCheckInput, BotVerdict, IControllerDescriptor } from '../src/index.js';
import { boot, configurationOf, disposeBooted } from './support/config-boot.js';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

const calls: { verifier: string; input: BotCheckInput }[] = [];
const verdicts = new Map<string, BotVerdict | Error>();

abstract class StubVerifier extends BotVerifier {
  public async verify(input: BotCheckInput): Promise<BotVerdict> {
    calls.push({ verifier: this.Name, input });
    const verdict = verdicts.get(this.Name) ?? { result: 'passed' };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  }
}

@Injectable(BotVerifier)
export class StubScoreVerifier extends StubVerifier {}

@Injectable(BotVerifier)
export class StubChallengeVerifier extends StubVerifier {}

const VERIFIERS = [
  { service: 'StubScoreVerifier', name: 'stub-score' },
  { service: 'StubChallengeVerifier', name: 'stub-challenge' },
];

let actionRuns = 0;

@BasePath('bot')
class BotSpecController extends BaseController {
  @Post('login')
  @BotCheck('login')
  public async login() {
    actionRuns++;
    return new Ok({ ok: true });
  }

  @Post('guarded')
  @BotCheck('login')
  public async guarded(@Body() _body: unknown) {
    actionRuns++;
    return new Ok({ ok: true });
  }

  @Post('signup')
  @BotCheck('signup')
  public async signup() {
    actionRuns++;
    return new Ok({ ok: true });
  }
}

function botConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    header: 'x-bot-token',
    verifierHeader: 'x-bot-verifier',
    verifiers: VERIFIERS,
    checks: {
      login: { enabled: true, verifier: 'stub-score', action: 'sign_in', fallback: 'stub-challenge' },
      signup: { enabled: true, verifier: 'stub-challenge' },
    },
    ...overrides,
  };
}

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

async function app(): Promise<express.Express> {
  const controller = new BotSpecController();
  const cfg = DI.get(Configuration)!;
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(controller, name, { value });
  }
  await controller.resolve();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { storage: object }).storage = { realIp: '203.0.113.7' };
    next();
  });
  server.use(controller.Router);
  return server;
}

function useConfiguration(bot: unknown) {
  const values: Record<string, unknown> = {
    logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    http: { AcceptHeaders: HttpAcceptHeaders.JSON, ...(bot === undefined ? {} : { bot }) },
  };
  const SpecConfiguration = configurationOf(values);
  DI.uncache(Configuration);
  DI.uncache(BotCheckService);
  DI.register(SpecConfiguration).as(Configuration);
  return SpecConfiguration;
}

describe('http: bot check', function () {
  this.timeout(15000);

  let spec: ReturnType<typeof useConfiguration> | null = null;

  async function start(bot: unknown) {
    spec = useConfiguration(bot);
    await DI.resolve(Configuration);
    return app();
  }

  beforeEach(() => {
    calls.length = 0;
    verdicts.clear();
    actionRuns = 0;
  });

  afterEach(async () => {
    sinon.restore();
    if (spec) {
      DI.unregister(spec);
      DI.uncache(spec);
      spec = null;
    }
    DI.uncache(Configuration);
    DI.uncache(BotCheckService);
    await disposeBooted();
  });

  it('is a no-op with the master switch off: no verifier call, the action runs', async () => {
    const server = await start(botConfig({ enabled: false }));
    const res = await chai.request(server).post('/bot/login').send({});
    expect(res.status, res.text).to.eq(200);
    expect(actionRuns).to.eq(1);
    expect(calls).to.be.empty;
  });

  it('is a no-op with the check off', async () => {
    const server = await start(botConfig({ checks: { login: { enabled: false, verifier: 'stub-score' } } }));
    const res = await chai.request(server).post('/bot/login').send({});
    expect(res.status, res.text).to.eq(200);
    expect(calls).to.be.empty;
  });

  it('is a no-op with no http.bot config at all, and resolves no verifier', async () => {
    const server = await start(undefined);
    const res = await chai.request(server).post('/bot/login').send({});
    expect(res.status, res.text).to.eq(200);
    expect(calls).to.be.empty;
    expect((DI.get(BotCheckService) as unknown as { Verifiers: unknown }).Verifiers).to.eq(null);
  });

  it('answers 400 bot_check_failed (missing) with no-store when the token is absent; the action and argument extraction never run', async () => {
    const extract = sinon.spy(FromBody.prototype, 'extract');
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/guarded').send({ a: 1 });
    expect(res.status, res.text).to.eq(400);
    expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'missing' });
    expect(res.get('cache-control')).to.eq('no-store');
    expect(actionRuns).to.eq(0);
    expect(extract.called).to.eq(false);
    expect(calls).to.be.empty;
  });

  it('lets the action run on a passed verdict and hands the verifier the token, action and ip', async () => {
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/login').set('x-bot-token', 'tok-1').send({});
    expect(res.status, res.text).to.eq(200);
    expect(actionRuns).to.eq(1);
    expect(calls).to.have.length(1);
    expect(calls[0].verifier).to.eq('stub-score');
    expect(calls[0].input).to.include({ token: 'tok-1', action: 'sign_in', ip: '203.0.113.7' });
  });

  it('uses the check name as the action when the check names none', async () => {
    const server = await start(botConfig());
    await chai.request(server).post('/bot/signup').set('x-bot-token', 'tok').send({});
    expect(calls[0].verifier).to.eq('stub-challenge');
    expect(calls[0].input.action).to.eq('signup');
  });

  it('answers failed with next set to the fallback when the verifier fails the token', async () => {
    verdicts.set('stub-score', { result: 'failed', reason: 'low_score', score: 0.1 });
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/login').set('x-bot-token', 'tok').send({});
    expect(res.status, res.text).to.eq(400);
    expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'failed', next: 'stub-challenge' });
    expect(res.get('cache-control')).to.eq('no-store');
    expect(actionRuns).to.eq(0);
  });

  it('answers failed without next when the check has no fallback', async () => {
    verdicts.set('stub-challenge', { result: 'failed', reason: 'timeout-or-duplicate' });
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/signup').set('x-bot-token', 'tok').send({});
    expect(res.status, res.text).to.eq(400);
    expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'failed' });
  });

  it('verifies with the fallback when the client names it, and gives no further next', async () => {
    verdicts.set('stub-score', { result: 'failed', reason: 'low_score' });
    const server = await start(botConfig());
    const ok = await chai.request(server).post('/bot/login').set('x-bot-token', 'v2').set('x-bot-verifier', 'stub-challenge').send({});
    expect(ok.status, ok.text).to.eq(200);
    expect(calls.map((c) => c.verifier)).to.deep.eq(['stub-challenge']);

    verdicts.set('stub-challenge', { result: 'failed', reason: 'bad' });
    const failed = await chai.request(server).post('/bot/login').set('x-bot-token', 'v2').set('x-bot-verifier', 'stub-challenge').send({});
    expect(failed.body).to.deep.eq({ error: 'bot_check_failed', reason: 'failed' });
  });

  it('refuses a verifier the check does not name, without calling any verifier', async () => {
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/signup').set('x-bot-token', 'tok').set('x-bot-verifier', 'stub-score').send({});
    expect(res.status, res.text).to.eq(400);
    expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'failed' });
    expect(calls).to.be.empty;
  });

  it('answers 503 bot_check_unavailable with Retry-After and no-store when the verifier is unavailable (default refuse)', async () => {
    verdicts.set('stub-score', { result: 'unavailable', reason: 'timeout' });
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/login').set('x-bot-token', 'tok').send({});
    expect(res.status, res.text).to.eq(503);
    expect(res.body).to.deep.eq({ error: 'bot_check_unavailable' });
    expect(res.get('retry-after')).to.eq('30');
    expect(res.get('cache-control')).to.eq('no-store');
    expect(actionRuns).to.eq(0);
  });

  it('treats a verifier that throws as unavailable', async () => {
    verdicts.set('stub-score', new Error('boom'));
    const server = await start(botConfig());
    const res = await chai.request(server).post('/bot/login').set('x-bot-token', 'tok').send({});
    expect(res.status, res.text).to.eq(503);
    expect(res.body).to.deep.eq({ error: 'bot_check_unavailable' });
  });

  it("lets the action run on unavailable with onUnavailable 'allow', warning once per period", async () => {
    verdicts.set('stub-score', { result: 'unavailable', reason: 'timeout' });
    const server = await start(botConfig({ checks: { login: { enabled: true, verifier: 'stub-score', onUnavailable: 'allow' } } }));
    const service = DI.get(BotCheckService) as unknown as { Log: { warn(): void } };
    const warn = sinon.stub(service.Log, 'warn');

    for (let i = 0; i < 3; i++) {
      const res = await chai.request(server).post('/bot/login').set('x-bot-token', 'tok').send({});
      expect(res.status, res.text).to.eq(200);
    }
    expect(actionRuns).to.eq(3);
    expect(warn.callCount).to.eq(1);
  });

  it(`caps the token at ${BOT_TOKEN_MAX_LENGTH} characters; a longer one counts as missing`, async () => {
    const server = await start(botConfig());
    const atCap = await chai.request(server).post('/bot/login').set('x-bot-token', 'a'.repeat(BOT_TOKEN_MAX_LENGTH)).send({});
    expect(atCap.status, atCap.text).to.eq(200);

    calls.length = 0;
    const over = await chai.request(server).post('/bot/login').set('x-bot-token', 'a'.repeat(BOT_TOKEN_MAX_LENGTH + 1)).send({});
    expect(over.status, over.text).to.eq(400);
    expect(over.body).to.deep.eq({ error: 'bot_check_failed', reason: 'missing' });
    expect(calls).to.be.empty;
  });

  it('reads the token from the configured header', async () => {
    const server = await start(botConfig({ header: 'x-captcha' }));
    expect((await chai.request(server).post('/bot/login').set('x-bot-token', 'tok').send({})).status).to.eq(400);
    expect((await chai.request(server).post('/bot/login').set('x-captcha', 'tok').send({})).status).to.eq(200);
  });

  it('fails the route build when an enabled check names an unknown verifier', async () => {
    spec = useConfiguration(botConfig({ checks: { login: { enabled: true, verifier: 'nope' } } }));
    await DI.resolve(Configuration);
    await expect(app()).to.be.rejectedWith(InvalidOption, 'http.bot.checks.login.verifier');
  });

  it('fails the route build when an enabled check names an unknown fallback', async () => {
    spec = useConfiguration(botConfig({ checks: { login: { enabled: true, verifier: 'stub-score', fallback: 'nope' } } }));
    await DI.resolve(Configuration);
    await expect(app()).to.be.rejectedWith(InvalidOption, 'http.bot.checks.login.fallback');
  });

  it('does not check names of a disabled check', async () => {
    const server = await start(botConfig({ checks: { login: { enabled: false, verifier: 'nope' } } }));
    expect((await chai.request(server).post('/bot/login').send({})).status).to.eq(200);
  });

  describe('BotCheckFailed', () => {
    it('carries the check, the reason and next', () => {
      const err = new BotCheckFailed('login', 'failed', 'stub-challenge');
      expect(err).to.include({ check: 'login', reason: 'failed', next: 'stub-challenge' });
    });
  });

  describe('BotCheckMiddleware', () => {
    it('is attached by @BotCheck with the check name', () => {
      const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, BotSpecController.prototype) as IControllerDescriptor;
      expect(descriptor.Routes.get('signup')!.Middlewares).to.deep.eq([{ Type: BotCheckMiddleware, Options: ['signup'] }]);
    });
  });

  describe('http.bot schema', () => {
    it('defaults to off with the x-bot-token header', async () => {
      const { configuration } = await boot([HTTP_CONFIGURATION_SCHEMA], {});
      expect(configuration.get('http.bot')).to.deep.eq({ enabled: false, header: 'x-bot-token', verifierHeader: 'x-bot-verifier', verifiers: [], checks: {} });
    });

    it('defaults a check to off and refuse', async () => {
      const { configuration } = await boot([HTTP_CONFIGURATION_SCHEMA], { http: { bot: { checks: { login: { verifier: 'v' } } } } });
      expect(configuration.get('http.bot.checks.login')).to.deep.eq({ enabled: false, verifier: 'v', onUnavailable: 'refuse' });
    });

    it('refuses an unknown onUnavailable mode and a verifier entry with no name', async () => {
      await expect(boot([HTTP_CONFIGURATION_SCHEMA], { http: { bot: { checks: { login: { verifier: 'v', onUnavailable: 'maybe' } } } } })).to.be.rejected;
      await expect(boot([HTTP_CONFIGURATION_SCHEMA], { http: { bot: { verifiers: [{ service: 'X' }] } } })).to.be.rejected;
    });
  });
});

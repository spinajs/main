import 'mocha';
import { expect } from 'chai';
import { DI, Injectable } from '@spinajs/di';
import { BotCheckMiddleware, BotCheckService, BotVerifier, BotVerifierRegistry, CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { BotCheckInput, BotVerdict, IControllerDescriptor } from '@spinajs/http';

import { AUTHN_FAILURE_BODY } from '../../src/v3/index.js';
import { AuthnCodeLoginController } from '../../src/v3/controllers/AuthnCodeLoginController.js';
import { AuthnLoginController } from '../../src/v3/controllers/AuthnLoginController.js';
import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnPasswordController } from '../../src/v3/controllers/AuthnPasswordController.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { Client, config, events, passwordStrategy, resetRecorders, seedUser, startApp, stopApp, throttle } from './app.js';

const calls: BotCheckInput[] = [];
let verdict: BotVerdict = { result: 'passed' };

@Injectable(BotVerifier)
export class V3AppBotVerifier extends BotVerifier {
  public async verify(input: BotCheckInput): Promise<BotVerdict> {
    calls.push(input);
    return verdict;
  }
}

type ControllerClass = abstract new (...args: never[]) => object;

const CHECKS: [ControllerClass, string, string][] = [
  [AuthnLoginController, 'login', 'login'],
  [AuthnRegistrationController, 'register', 'register'],
  [AuthnPasswordController, 'requestReset', 'password_reset'],
  [AuthnCodeLoginController, 'request', 'code_request'],
  [AuthnPasskeyController, 'challenge', 'passkey_challenge'],
];

function middlewaresOf(controller: ControllerClass, method: string) {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
  return descriptor.Routes.get(method)!.Middlewares;
}

function switchBot(on: boolean): void {
  DI.uncache(BotCheckService);
  DI.uncache(BotVerifierRegistry);
  config().set('http.bot.verifiers', on ? [{ service: 'V3AppBotVerifier', name: 'recaptcha-v3' }] : []);
  config().set('http.bot.checks.login.enabled', on);
  config().set('http.bot.enabled', on);
}

// Sorts before behaviour/, like the other auth-*.test.ts files.
describe('3.0 bot checks (HARD-BOT B2)', function () {
  this.timeout(60000);

  before(startApp);
  after(async () => {
    switchBot(false);
    await stopApp();
  });

  beforeEach(() => {
    resetRecorders();
    calls.length = 0;
    verdict = { result: 'passed' };
  });

  describe('the shipped configuration', () => {
    it('marks login, register, reset request, code request and passkey challenge with their check', () => {
      for (const [controller, method, check] of CHECKS) {
        const bot = middlewaresOf(controller, method).filter((m) => m.Type === BotCheckMiddleware);
        expect(bot, `${controller.name}.${method}`).to.deep.eq([{ Type: BotCheckMiddleware, Options: [check] }]);
      }
    });

    it('ships every check off, on recaptcha-v3, refusing when the provider is down', () => {
      expect(config().get('http.bot.enabled')).to.eq(false);
      for (const [, , check] of CHECKS) {
        expect(config().get(`http.bot.checks.${check}`), check).to.deep.eq({ enabled: false, verifier: 'recaptcha-v3', action: check, onUnavailable: 'refuse' });
      }
    });

    it('logs in with no token, and never resolves a verifier', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(calls).to.be.empty;
      expect(DI.get(BotVerifierRegistry), 'the verifier registry').to.not.be.ok;
    });
  });

  describe('with the login check on', () => {
    before(() => switchBot(true));
    after(() => switchBot(false));

    it('refuses a login without a token: 400 bot_check_failed, no-store, no throttle attempt, no strategy, no audit', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
      expect(res.status, JSON.stringify(res.body)).to.eq(400);
      expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'missing' });
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(throttle.attempts).to.have.length(0);
      expect(passwordStrategy.verifyCalls).to.have.length(0);
      expect(events.ofType('login')).to.deep.eq([]);
      expect(events.all()).to.deep.eq([]);
      expect(calls).to.be.empty;
    });

    it('refuses a token the verifier fails, with the same answer shape', async () => {
      verdict = { result: 'failed', reason: 'low_score', score: 0.1 };
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password }, { 'x-bot-token': 'tok' });
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.eq({ error: 'bot_check_failed', reason: 'failed' });
      expect(throttle.attempts).to.have.length(0);
    });

    it('answers 503 bot_check_unavailable when the verifier is down', async () => {
      verdict = { result: 'unavailable', reason: 'timeout' };
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password }, { 'x-bot-token': 'tok' });
      expect(res.status).to.eq(503);
      expect(res.body).to.deep.eq({ error: 'bot_check_unavailable' });
      expect(res.headers['retry-after']).to.eq('30');
      expect(throttle.attempts).to.have.length(0);
    });

    it('logs in with a passed token; the verifier gets the token and the login action', async () => {
      const u = await seedUser();
      const c = new Client();
      const res = await c.post('/auth/login', { login: u.login, password: u.password }, { 'x-bot-token': 'tok-ok' });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(c.cookie).to.not.eq(null);
      expect(calls).to.have.length(1);
      expect(calls[0]).to.include({ token: 'tok-ok', action: 'login' });
      expect(events.ofType('login')).to.have.length(1);
    });

    it('keeps the uniform 401 for wrong credentials once the check passes (A02)', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: 'wrong-password' }, { 'x-bot-token': 'tok' });
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
      expect(throttle.attempts.filter((a) => a.flow === 'login')).to.have.length(1);
    });

    it('leaves the routes whose check stays off alone', async () => {
      const res = await new Client().post('/auth/password/reset-request', { login: 'nobody@example.test' });
      expect((res.body as { error?: unknown } | undefined)?.error, JSON.stringify(res.body)).to.not.eq('bot_check_failed');
      expect(calls).to.be.empty;
    });
  });
});

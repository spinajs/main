import 'mocha';
import { expect } from 'chai';
import { BotCheckMiddleware, CONTROLLED_DESCRIPTOR_SYMBOL, Response } from '@spinajs/http';
import type { IControllerDescriptor, IMiddlewareContext } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import { AuthnThrottle } from '@spinajs/authn/contracts';
import { fakeContainer, readingFrom } from '@spinajs/testing';

import { AuthnIpThrottleMiddleware } from '../../src/middleware/ip-throttle.js';
import { INVALID_INPUT } from '../../src/validation/answers.js';
import { AuthnCodeLoginController } from '../../src/v3/controllers/AuthnCodeLoginController.js';
import { AuthnKeysController } from '../../src/v3/controllers/AuthnKeysController.js';
import { AuthnLoginController } from '../../src/v3/controllers/AuthnLoginController.js';
import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnPasswordController } from '../../src/v3/controllers/AuthnPasswordController.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { AuthnTokenRevocationController } from '../../src/v3/controllers/AuthnTokenRevocationController.js';
import { AuthnVerificationController } from '../../src/v3/controllers/AuthnVerificationController.js';

type ControllerClass = abstract new (...args: never[]) => object;

/** Every anonymous route that reads a body: the IP gate's flow and mode. */
const GATED: [ControllerClass, string, string, 'gate' | 'count'][] = [
  [AuthnLoginController, 'login', 'login', 'gate'],
  [AuthnCodeLoginController, 'login', 'login', 'gate'],
  [AuthnKeysController, 'login', 'login', 'gate'],
  [AuthnPasskeyController, 'login', 'login', 'gate'],
  [AuthnKeysController, 'challenge', 'login', 'gate'],
  [AuthnCodeLoginController, 'request', 'reset', 'gate'],
  [AuthnPasswordController, 'requestReset', 'reset', 'gate'],
  [AuthnPasswordController, 'reset', 'reset', 'gate'],
  [AuthnVerificationController, 'verify', 'reset', 'gate'],
  [AuthnRegistrationController, 'register', 'register', 'gate'],
  [AuthnTokenRevocationController, 'revoke', 'reset', 'count'],
];

const routeOf = (controller: ControllerClass, method: string) => (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor).Routes.get(method)!;
const middlewaresOf = (controller: ControllerClass, method: string) => routeOf(controller, method).Middlewares;

class Answer extends Response {
  constructor(public readonly retryAfterSeconds: number) {
    super(null);
  }

  public async execute(): Promise<void> {}
}

/** A throttle refusing every key for 29 seconds; `peek` only where asked. */
function refusing(withPeek: boolean) {
  const calls: string[] = [];
  const verdict = async (name: string) => {
    calls.push(name);
    return { allowed: false as const, retryAfterSeconds: 29 };
  };
  const throttle = Object.assign(Object.create(AuthnThrottle.prototype) as AuthnThrottle, { attempt: () => verdict('attempt'), ...(withPeek ? { peek: () => verdict('peek') } : {}) });
  return { throttle, calls };
}

function gate(mode: 'gate' | 'count', throttle: AuthnThrottle): AuthnIpThrottleMiddleware {
  const mw = readingFrom(new AuthnIpThrottleMiddleware('login', (s) => new Answer(s), mode), fakeContainer({}));
  Object.assign(mw, { Container: { resolve: async () => throttle } as unknown as IContainer });
  return mw;
}

const ctxOf = (ip = '192.0.2.7') => ({ req: { headers: {}, storage: { ClientIp: ip } }, res: {}, storage: { ClientIp: ip } } as unknown as IMiddlewareContext);

describe('the IP throttle gate of the anonymous routes (V8, D11(a))', () => {
  for (const [controller, method, flow, mode] of GATED) {
    it(`${controller.name}.${method}: the ${flow} gate (${mode}) runs first, before the bot check`, () => {
      const types = middlewaresOf(controller, method).map((m) => m.Type);
      expect(types[0], 'the first route middleware').to.eq(AuthnIpThrottleMiddleware);
      const [optFlow, answer, optMode] = middlewaresOf(controller, method)[0].Options;
      expect([optFlow, typeof answer, optMode]).to.deep.eq([flow, 'function', mode]);
      const bot = types.indexOf(BotCheckMiddleware);
      if (bot >= 0) expect(bot).to.be.greaterThan(0);
    });
  }
});

describe('AuthnIpThrottleMiddleware answers a throttled client itself', () => {
  for (const mode of ['gate', 'count'] as const) {
    it(`${mode}: onBefore returns the route's throttled answer with the retry delay, and throws nothing`, async () => {
      const { throttle, calls } = refusing(true);
      const answer = await gate(mode, throttle).onBefore(ctxOf());
      expect(answer).to.be.instanceOf(Answer);
      expect((answer as Answer).retryAfterSeconds).to.eq(29);
      expect(calls).to.deep.eq([mode === 'gate' ? 'peek' : 'attempt']);
    });
  }

  it('gate: lets the request on without a peek, for its invalid input to be counted', async () => {
    const { throttle, calls } = refusing(false);
    expect(await gate('gate', throttle).onBefore(ctxOf())).to.eq(undefined);
    expect(calls).to.deep.eq([]);
  });

  it('@IpThrottle adds no middleware-stage error handler: nothing is thrown to answer', () => {
    for (const [controller, method] of GATED) {
      const handlers = routeOf(controller, method).ErrorHandlers ?? [];
      expect(
        handlers.filter((h) => h.Stages?.includes('middleware')),
        `${controller.name}.${method}`,
      ).to.have.length(0);
      expect(
        handlers.some((h) => h.Stages?.includes('arguments') && h.On.every((t) => INVALID_INPUT.includes(t))),
        `${controller.name}.${method}`,
      ).to.eq(true);
    }
  });
});

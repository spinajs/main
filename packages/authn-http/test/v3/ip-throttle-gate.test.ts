import 'mocha';
import { expect } from 'chai';
import { BotCheckMiddleware, CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import { AuthnIpThrottleMiddleware } from '../../src/middleware/ip-throttle.js';
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

const middlewaresOf = (controller: ControllerClass, method: string) => (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor).Routes.get(method)!.Middlewares;

describe('the IP throttle gate of the anonymous routes (V8, D11(a))', () => {
  for (const [controller, method, flow, mode] of GATED) {
    it(`${controller.name}.${method}: the ${flow} gate (${mode}) runs first, before the bot check`, () => {
      const types = middlewaresOf(controller, method).map((m) => m.Type);
      expect(types[0], 'the first route middleware').to.eq(AuthnIpThrottleMiddleware);
      expect(middlewaresOf(controller, method)[0].Options).to.deep.eq([flow, mode]);
      const bot = types.indexOf(BotCheckMiddleware);
      if (bot >= 0) expect(bot).to.be.greaterThan(0);
    });
  }
});

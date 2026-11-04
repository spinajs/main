import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DataValidator, ValidationFailed } from '@spinajs/validation';
import type { ErrorContext } from '@spinajs/http';
import '@spinajs/log';

import { byField, failedInput } from '../../src/validation/answers.js';

class ShippedValidation extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false },
    };
  }
}

const BODY = {
  $id: 'authn.AnswersTestBody',
  type: 'object',
  required: ['login', 'password', 'confirmPassword'],
  properties: { login: { type: 'string' }, password: { type: 'string', minLength: 8 }, confirmPassword: { type: 'string' } },
  additionalProperties: false,
};

describe('validation answers over a real DataValidator', function () {
  this.timeout(15000);

  let validator: DataValidator;

  before(async () => {
    DI.register(ShippedValidation).as(Configuration);
    DI.uncache(Configuration);
    DI.uncache(DataValidator);
    await DI.resolve(Configuration);
    validator = await DI.resolve(DataValidator);
  });

  after(() => {
    DI.uncache(DataValidator);
    DI.uncache(Configuration);
    DI.unregister(ShippedValidation);
  });

  const refusal = (body: object): ValidationFailed => {
    try {
      validator.validate(BODY, body);
    } catch (err) {
      if (err instanceof ValidationFailed) return err;
      throw err;
    }
    throw new Error('the body passed');
  };

  it('failedInput gets every missing and every unknown field', () => {
    const input = failedInput(refusal({ x: 1, y: 2 }));

    expect(input.schema).to.eq('authn.AnswersTestBody');
    expect(input.fields).to.deep.eq(['login', 'password', 'confirmPassword']);
    expect(input.unknown).to.deep.eq(['x', 'y']);
  });

  it('byField answers for the first failed field in its own order', async () => {
    const answer = byField(
      { password: () => 'password' as never, confirmPassword: () => 'confirmPassword' as never },
      () => 'otherwise' as never,
    );
    const ctx = {} as ErrorContext;

    for (const [body, expected] of [
      [{ login: 'a' }, 'password'],
      [{ login: 'a', password: 'long enough' }, 'confirmPassword'],
      [{ login: 'a', password: 'long enough', confirmPassword: 'x', extra: 1 }, 'otherwise'],
    ] as const) {
      const err = refusal(body);
      expect(await answer(failedInput(err), err, ctx), JSON.stringify(body)).to.eq(expected);
    }
  });
});

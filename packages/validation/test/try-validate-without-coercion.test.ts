import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';

class CoercingConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      validation: { allErrors: true, coerceTypes: true, useDefaults: true },
    };
  }
}

const nullableLimit = {
  type: 'object',
  properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, page: { type: 'integer', default: 1 } },
};

describe('tryValidate with coerceTypes: false', function () {
  this.timeout(15000);

  let validator: DataValidator;

  before(async () => {
    DI.register(CoercingConfiguration).as(Configuration);
    DI.uncache(Configuration);
    DI.uncache(DataValidator);
    await DI.resolve(Configuration);
    validator = await DI.resolve(DataValidator);
  });

  after(() => {
    DI.uncache(DataValidator);
    DI.uncache(Configuration);
    DI.unregister(CoercingConfiguration);
  });

  it('refuses a value that passes only after a type conversion', () => {
    const data = { limit: '5' };
    const [valid, errors] = validator.tryValidate(nullableLimit, data, { coerceTypes: false });

    expect(valid).to.eq(false);
    expect(errors!.map((e) => e.keyword)).to.include('type');
    expect(data.limit).to.eq('5');
  });

  it('accepts a later anyOf branch as sent, where coercion takes the first one', () => {
    const coerced: Record<string, unknown> = { limit: null };
    expect(validator.tryValidate(nullableLimit, coerced)[0]).to.eq(true);
    expect(coerced.limit).to.eq(0);

    const sent: Record<string, unknown> = { limit: null };
    expect(validator.tryValidate(nullableLimit, sent, { coerceTypes: false })[0]).to.eq(true);
    expect(sent.limit).to.eq(null);
  });

  it('still fills defaults', () => {
    const data: Record<string, unknown> = { limit: 5 };
    expect(validator.tryValidate(nullableLimit, data, { coerceTypes: false })[0]).to.eq(true);
    expect(data).to.deep.equal({ limit: 5, page: 1 });
  });

  it('resolves a $ref without coercion', () => {
    validator.addSchema({ $id: 'app.perPage', type: 'integer' }, 'app.perPage');
    const schema = { type: 'object', properties: { perPage: { $ref: 'app.perPage' } } };

    expect(validator.tryValidate(schema, { perPage: '50' }, { coerceTypes: false })[0]).to.eq(false);
    expect(validator.tryValidate(schema, { perPage: '50' })[0]).to.eq(true);
  });
});

import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { ValidationFailed } from '../src/exceptions/index.js';
import { ManifestValidator } from '../src/manifest-source.js';
import { manifestOf } from './manifest-of.js';

function validationConfig(validation: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        validation,
      };
    }
  };
}

// `type T = number | T[]`: with coerceTypes 'array' the array branch wraps "x" into ["x"], whose item is T again.
const RECURSIVE = { $id: 'rec.T', anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: 'rec.T' } }] };
const TOO_DEEP = { keyword: 'maxDepth', instancePath: '', schemaPath: '#', params: {}, message: 'the value is nested too deeply to validate' };

describe('a value Ajv recurses on without end', function () {
  this.timeout(30000);

  let validator: DataValidator;
  let config: unknown;

  before(async () => {
    config = validationConfig({ allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: 'array', messages: false });
    DI.register(config as never).as(Configuration);
    DI.uncache(Configuration);
    DI.uncache(DataValidator);
    await DI.resolve(Configuration);
    validator = await DI.resolve(DataValidator);
    validator.addSchema(RECURSIVE, 'rec.T');
  });

  after(() => {
    DI.uncache(DataValidator);
    DI.uncache(Configuration);
    DI.unregister(config as never);
  });

  for (const value of ['x', '']) {
    it(`${JSON.stringify(value)} fails at the root instead of overflowing the stack`, () => {
      const [valid, errors] = validator.tryValidate('rec.T', value as unknown as object);
      expect(valid).to.eq(false);
      expect(errors).to.deep.eq([TOO_DEEP]);

      try {
        validator.validate('rec.T', value as unknown as object);
        expect.fail('validated');
      } catch (err) {
        expect(err).to.be.instanceOf(ValidationFailed);
        expect((err as ValidationFailed).parameter).to.deep.eq([TOO_DEEP]);
      }
    });
  }

  it('still validates what terminates', () => {
    expect(validator.tryValidate('rec.T', '5' as unknown as object)[0]).to.eq(true);
    expect(validator.tryValidate('rec.T', [1, [2, [3]]])[0]).to.eq(true);
  });

  it('lets any other error through', () => {
    expect(() => validator.validate({ type: 'string', format: 'no-such-format' }, 'x' as unknown as object)).to.throw(Error, /no-such-format/);
  });
});

describe('ManifestValidator: a value Ajv recurses on without end', () => {
  // Query, path, header and cookie values coerce as 'array' by default, so this needs no configuration.
  const validators = () => new ManifestValidator(manifestOf({ 'app/T': { anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: 'app/T' } }] } }));

  for (const value of ['x', '']) {
    it(`${JSON.stringify(value)} on a coerced wire fails at the root instead of overflowing the stack`, () => {
      try {
        validators().validator('app/T', { coerce: true })(value);
        expect.fail('validated');
      } catch (err) {
        expect(err).to.be.instanceOf(ValidationFailed);
        expect((err as ValidationFailed).parameter).to.deep.eq([TOO_DEEP]);
      }
    });
  }

  it('still validates what terminates, and a body is not coerced', () => {
    expect(() => validators().validator('app/T', { coerce: true })('5')).to.not.throw();
    expect(() => validators().validator('app/T', { coerce: false })('x')).to.throw(ValidationFailed);
  });
});

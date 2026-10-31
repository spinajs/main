import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { Schema } from '../src/decorators.js';
import { ValidationFailed } from '../src/exceptions/index.js';

function validationConfig(validation: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        validation,
      };
    }
  };
}

const loginBody = (id: string) => ({
  $id: id,
  type: 'object',
  required: ['login'],
  properties: { login: { type: 'string', maxLength: 16 }, remember: { type: 'boolean' } },
});

@Schema(loginBody('authz.DecoratedBody'))
class DecoratedBody {
  public login: string;
}

async function boot(validation: Record<string, unknown>) {
  const config = validationConfig(validation);
  DI.register(config).as(Configuration);
  DI.uncache(Configuration);
  DI.uncache(DataValidator);
  await DI.resolve(Configuration);
  return { config, validator: await DI.resolve(DataValidator) };
}

describe('strict validation for configured schema ids', function () {
  this.timeout(15000);

  describe('default prefixes', () => {
    let validator: DataValidator;
    let config: unknown;

    before(async () => {
      ({ config, validator } = await boot({ allErrors: true, coerceTypes: true, useDefaults: true }));
    });

    after(() => {
      DI.uncache(DataValidator);
      DI.uncache(Configuration);
      DI.unregister(config as any);
    });

    it('does not coerce a number into a string for an authn. schema', () => {
      const [valid, errors] = validator.tryValidate(loginBody('authn.LoginBody'), { login: 123 });
      expect(valid).to.eq(false);
      expect(errors![0].keyword).to.eq('type');
    });

    it('still coerces for a schema outside the strict prefixes', () => {
      const data = { login: 123 };
      const [valid] = validator.tryValidate(loginBody('app.LoginBody'), data);
      expect(valid).to.eq(true);
      expect(data.login).to.eq('123');
    });

    it('does not coerce for a schema registered by an authz. id', () => {
      validator.addSchema(loginBody('authz.RegisteredBody'), 'authz.RegisteredBody');
      expect(validator.tryValidate('authz.RegisteredBody', { login: 'a', remember: 'true' })[0]).to.eq(false);
      expect(validator.tryValidate('authz.RegisteredBody', { login: 'a', remember: true })[0]).to.eq(true);
    });

    it('does not coerce for a @Schema class with a strict id', () => {
      const body = Object.assign(new DecoratedBody(), { login: 5 });
      expect(() => validator.validate(body)).to.throw(ValidationFailed);
    });

    it('keeps the other options on the strict instance', () => {
      const [valid, errors] = validator.tryValidate(loginBody('authn.AllErrorsBody'), { login: 7, remember: 'yes' });
      expect(valid).to.eq(false);
      expect(errors).to.have.length(2);
    });

    it('resolves a $ref from a strict schema to a shared schema without coercion', () => {
      validator.addSchema({ $id: 'shared.login', type: 'string', maxLength: 16 }, 'shared.login');
      const schema = { $id: 'authn.RefBody', type: 'object', properties: { login: { $ref: 'shared.login' } } };
      expect(validator.tryValidate(schema, { login: 1 })[0]).to.eq(false);
      expect(validator.tryValidate(schema, { login: 'a' })[0]).to.eq(true);
    });
  });

  describe('configured prefixes', () => {
    let validator: DataValidator;
    let config: unknown;

    before(async () => {
      ({ config, validator } = await boot({ allErrors: true, coerceTypes: true, strict: { idPrefixes: ['billing.'] } }));
    });

    after(() => {
      DI.uncache(DataValidator);
      DI.uncache(Configuration);
      DI.unregister(config as any);
    });

    it('validates a listed prefix strictly and an unlisted one with coercion', () => {
      expect(validator.tryValidate(loginBody('billing.Invoice'), { login: 1 })[0]).to.eq(false);
      expect(validator.tryValidate(loginBody('app.NotStrictHere'), { login: 1 })[0]).to.eq(true);
    });

    // A list that replaced the shipped one would put credentials back on type coercion.
    it('keeps the shipped prefixes strict next to an app list', () => {
      expect(validator.tryValidate(loginBody('authn.Login'), { login: 1 })[0]).to.eq(false);
      expect(validator.tryValidate(loginBody('authz.Grant'), { login: 1 })[0]).to.eq(false);
    });
  });

  for (const [mode, strict] of [
    ['a boolean strict is still Ajv strict mode', false],
    ['ajvStrict next to the prefixes', { idPrefixes: ['authn.'], ajvStrict: false }],
  ] as const) {
    describe(mode, () => {
      let validator: DataValidator;
      let config: unknown;

      before(async () => {
        ({ config, validator } = await boot({ allErrors: true, coerceTypes: true, strict }));
      });

      after(() => {
        DI.uncache(DataValidator);
        DI.uncache(Configuration);
        DI.unregister(config as any);
      });

      it('tolerates an unknown keyword and keeps authn. schemas strict', () => {
        const schema = { $id: `authn.UnknownKeyword.${String(mode.length)}`, type: 'object', properties: { login: { type: 'string', sku: true } } };
        expect(validator.tryValidate(schema, { login: 1 })[0]).to.eq(false);
        expect(validator.tryValidate(schema, { login: 'a' })[0]).to.eq(true);
      });
    });
  }
});

import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { IValidationError, ValidationFailed } from '../src/exceptions/index.js';

const SECRET_NAMES = ['password', 'newPassword', 'currentPassword', 'reauthPassword', 'code', 'totp', 'token', 'refreshToken', 'apiKey', 'secret', 'clientSecret'];

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

// Deterministic, so a failure names a value that reproduces.
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return (length: number) => Array.from({ length }, () => ALNUM[next() % ALNUM.length]).join('');
}

const SEEDS = [1, 7, 42, 1337, 65537, 2147483647];

/** Distinctive values: a match in the error output can only come from the request. */
function secretValues(): string[] {
  const fixed = ['Qv7Kr2Lp9Wx4Zs', 'hunter2Hunter2Zq', 'S3cretPassw0rdZq'];
  return [...fixed, ...SEEDS.map((s) => 'Zq' + generator(s)(14))];
}

const schemas = new Map<string, ReturnType<typeof buildSchema>>();

// Ajv refuses a second schema object under an $id it already compiled.
function schemaFor(secret: string) {
  if (!schemas.has(secret)) schemas.set(secret, buildSchema(secret));
  return schemas.get(secret)!;
}

function buildSchema(secret: string) {
  return {
    $id: `http://spinajs/no-echo/${secret}.schema.json`,
    type: 'object',
    properties: {
      [secret]: { type: 'string', minLength: 12, pattern: '^[A-Za-z0-9]+$' },
      email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 18 },
    },
    required: [secret],
  };
}

interface Case {
  name: string;
  data: Record<string, unknown>;
  /** Every request value that must not come back. */
  values: string[];
}

function casesFor(secret: string, value: string, other: string): Case[] {
  return [
    { name: 'the secret valid, another field fails', data: { [secret]: value, email: other, age: 21 }, values: [value, other] },
    { name: 'the secret has the wrong type', data: { [secret]: { nested: value }, email: 'a@spinajs.test' }, values: [value] },
    { name: 'the secret is too short', data: { [secret]: value.slice(0, 10) }, values: [value.slice(0, 10)] },
    { name: 'the secret misses the pattern', data: { [secret]: value + '!' }, values: [value] },
  ];
}

function outputsOf(err: ValidationFailed): Record<string, string> {
  return {
    'JSON.stringify(err)': JSON.stringify(err),
    'JSON.stringify({ ...err })': JSON.stringify({ ...err }),
    'err.toString()': err.toString(),
    'JSON.stringify(err.details)': JSON.stringify(err.details),
    'JSON.stringify(err.parameter)': JSON.stringify(err.parameter),
  };
}

function expectNoValue(err: unknown, values: string[], label: string): void {
  expect(err, label).to.be.instanceOf(ValidationFailed);
  for (const [where, text] of Object.entries(outputsOf(err as ValidationFailed))) {
    for (const v of values) {
      expect(text.includes(v), `${label}: ${where} holds ${v}: ${text}`).to.eq(false);
    }
  }
}

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

describe('ValidationFailed carries no request value', function () {
  this.timeout(30000);

  for (const [mode, validation] of [
    ['default ajv options', { allErrors: true }],
    ['ajv verbose: true', { allErrors: true, verbose: true }],
    ['ajv verbose: true, messages: false', { allErrors: false, verbose: true, messages: false }],
  ] as const) {
    describe(`DataValidator.validate, ${mode}`, () => {
      const config = validationConfig(validation);
      let validator: DataValidator;

      before(async () => {
        DI.register(config).as(Configuration);
        DI.uncache(Configuration);
        DI.uncache(DataValidator);
        await DI.resolve(Configuration);
        validator = await DI.resolve(DataValidator);
      });

      after(() => {
        DI.uncache(DataValidator);
        DI.uncache(Configuration);
        DI.unregister(config);
      });

      for (const secret of SECRET_NAMES) {
        it(`never echoes ${secret}`, () => {
          const others = generator(secret.length)(12);
          for (const [i, value] of secretValues().entries()) {
            for (const c of casesFor(secret, value, `not-an-email-${others}${i}`)) {
              let failure: unknown;
              try {
                validator.validate(schemaFor(secret), c.data);
              } catch (err) {
                failure = err;
              }
              expectNoValue(failure, c.values, `${secret} / ${c.name}`);
            }
          }
        });
      }

      it('still reports path, rule, message and params', () => {
        let failure: ValidationFailed | undefined;
        try {
          validator.validate(schemaFor('password'), { password: 'short' });
        } catch (err) {
          failure = err as ValidationFailed;
        }

        expect(failure).to.be.instanceOf(ValidationFailed);
        const detail = failure!.details.find((d) => d.rule === 'minLength')!;
        expect(detail.field).to.eq('/password');
        expect(detail.message).to.be.a('string').that.is.not.empty;
        expect(detail.params).to.deep.eq({ limit: 12 });
        expect(detail).to.not.have.property('value');
      });
    });
  }

  describe('ValidationFailed built from verbose ajv errors', () => {
    const secret = 'Zq' + generator(99)(16);
    const schema = schemaFor('reauthPassword');
    const verbose = {
      instancePath: '/reauthPassword',
      schemaPath: '#/properties/reauthPassword/pattern',
      keyword: 'pattern',
      params: { pattern: '^[A-Za-z0-9]+$' },
      message: 'must match pattern "^[A-Za-z0-9]+$"',
      data: secret + '!',
      schema: '^[A-Za-z0-9]+$',
      parentSchema: { type: 'string', minLength: 12, pattern: '^[A-Za-z0-9]+$', examples: [secret] },
    } as unknown as IValidationError;

    it('keeps only instancePath, schemaPath, keyword, params, message on parameter', () => {
      const err = new ValidationFailed('validation error', [verbose], schema);

      expect(err.parameter).to.have.lengthOf(1);
      expect(Object.keys(err.parameter[0]).sort()).to.deep.eq(['instancePath', 'keyword', 'message', 'params', 'schemaPath']);
      expectNoValue(err, [secret], 'verbose errors');
    });

    it('keeps propertyName when ajv set it', () => {
      const err = new ValidationFailed('validation error', [{ ...verbose, keyword: 'propertyNames', propertyName: 'reauthPassword' } as IValidationError], schema);
      expect(err.parameter[0].propertyName).to.eq('reauthPassword');
    });

    it('keeps the schema for server-side use but never serialises it', () => {
      const err = new ValidationFailed('validation error', [verbose], schema);

      expect(err.getExpectedSchema()).to.eq(schema);
      expect(err.schema).to.eq(schema);
      expect(err.getFieldRequirements('reauthPassword')).to.deep.eq(schema.properties.reauthPassword);
      expect(Object.keys(err)).to.not.include('schema');
      expect(JSON.stringify(err)).to.not.contain('no-echo');
      expect(JSON.stringify({ ...err })).to.not.contain('no-echo');
    });

    it('holds no data property', () => {
      const err = new ValidationFailed('validation error', [verbose], schema);
      expect(err).to.not.have.property('data');
    });
  });
});

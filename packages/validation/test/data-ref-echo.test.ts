import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { IValidationError, ValidationFailed } from '../src/exceptions/index.js';

const PASSWORD = 'Zq7PwSecretA1';
const PIN = 482913;
const BALANCE = 731942;
const ALLOWED = ['Zq7EnumAlpha', 'Zq7EnumBeta'];
const PATTERN = '^Zq7PatOnly$';

/** Every value of the request that a `$data` rule could copy into params or the message. */
const VALUES = [PASSWORD, String(PIN), String(BALANCE), ...ALLOWED, 'Zq7PatOnly', 'Zq7ConfirmTypo', 'Zq7ChoiceOther', 'Zq7TagValue'];

const FORM_PROPERTIES = {
  password: { type: 'string' },
  confirm: { type: 'string', const: { $data: '1/password' } },
  pin: { type: 'integer' },
  code: { type: 'string', minLength: { $data: '1/pin' } },
  balance: { type: 'number' },
  amount: { type: 'number', minimum: { $data: '1/balance' } },
  allowed: { type: 'array' },
  choice: { enum: { $data: '1/allowed' } },
  codePattern: { type: 'string' },
  tag: { type: 'string', pattern: { $data: '1/codePattern' } },
};

const FORM_DATA = {
  password: PASSWORD,
  confirm: 'Zq7ConfirmTypo',
  pin: PIN,
  code: 'abc',
  balance: BALANCE,
  amount: 1,
  allowed: ALLOWED,
  choice: 'Zq7ChoiceOther',
  codePattern: PATTERN,
  tag: 'nope',
};

const FORM_SCHEMA = { $id: 'http://spinajs/data-ref/form.schema.json', type: 'object', properties: FORM_PROPERTIES };

const REFERENCED_ID = 'http://spinajs/data-ref/credentials.schema.json';
const REFERENCED_SCHEMA = { $id: REFERENCED_ID, type: 'object', properties: FORM_PROPERTIES };
const OUTER_SCHEMA = { $id: 'http://spinajs/data-ref/outer.schema.json', type: 'object', properties: { creds: { $ref: REFERENCED_ID } } };
const OUTER_SCHEMA_WITH_DATA = {
  type: 'object',
  properties: { creds: { $ref: REFERENCED_ID }, again: { type: 'string', const: { $data: '1/other' } } },
};

const DISCRIMINATOR_SCHEMA = {
  $id: 'http://spinajs/data-ref/discriminator.schema.json',
  type: 'object',
  discriminator: { propertyName: 'kind' },
  required: ['kind'],
  oneOf: [{ properties: { kind: { const: 'card' } } }, { properties: { kind: { const: 'bank' } } }],
};

const DATA_RULES: Record<string, { rule: string; pointer: string }> = {
  confirm: { rule: 'const', pointer: '1/password' },
  code: { rule: 'minLength', pointer: '1/pin' },
  amount: { rule: 'minimum', pointer: '1/balance' },
  choice: { rule: 'enum', pointer: '1/allowed' },
  tag: { rule: 'pattern', pointer: '1/codePattern' },
};

const ERROR_KEYS = ['instancePath', 'keyword', 'message', 'params', 'propertyName', 'schemaPath'];

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

function failureOf(fn: () => void): ValidationFailed {
  try {
    fn();
  } catch (err) {
    return err as ValidationFailed;
  }
  throw new Error('validation passed');
}

function expectRedactedDetails(err: ValidationFailed, prefix: string): void {
  for (const [field, { rule, pointer }] of Object.entries(DATA_RULES)) {
    const detail = err.details.find((d) => d.field === `${prefix}/${field}`);
    expect(detail, `${prefix}/${field} reported`).to.not.eq(undefined);
    expect(detail!.rule).to.eq(rule);
    expect(detail!.params).to.deep.eq({ $data: pointer });
    expect(detail!.message).to.be.a('string').that.is.not.empty;
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

describe('$data rules echo no request value', function () {
  this.timeout(30000);

  for (const [mode, validation] of [
    ['default ajv options', { allErrors: true, discriminator: true }],
    ['ajv verbose: true', { allErrors: true, discriminator: true, verbose: true }],
    ['ajv verbose: false, messages: false', { allErrors: true, discriminator: true, verbose: false, messages: false }],
  ] as const) {
    describe(mode, () => {
      const config = validationConfig(validation);
      let validator: DataValidator;

      before(async () => {
        DI.register(config).as(Configuration);
        DI.uncache(Configuration);
        DI.uncache(DataValidator);
        await DI.resolve(Configuration);
        validator = await DI.resolve(DataValidator);
        validator.addSchema(REFERENCED_SCHEMA, REFERENCED_ID);
      });

      after(() => {
        DI.uncache(DataValidator);
        DI.uncache(Configuration);
        DI.unregister(config);
      });

      it('validate() redacts const, minLength, minimum, enum and pattern rules fed by $data', () => {
        const err = failureOf(() => validator.validate(FORM_SCHEMA, FORM_DATA));

        expectNoValue(err, VALUES, 'validate');
        expectRedactedDetails(err, '');
      });

      it('validate() redacts a $data rule behind a $ref to another registered schema', () => {
        const err = failureOf(() => validator.validate(OUTER_SCHEMA, { creds: FORM_DATA }));

        expectNoValue(err, VALUES, '$ref');
        expectRedactedDetails(err, '/creds');
      });

      it('tryValidate() returns redacted, reduced errors', () => {
        const [valid, errors] = validator.tryValidate(FORM_SCHEMA, FORM_DATA);

        expect(valid).to.eq(false);
        const text = JSON.stringify(errors);
        for (const v of VALUES) {
          expect(text.includes(v), `tryValidate errors hold ${v}: ${text}`).to.eq(false);
        }
        for (const error of errors!) {
          expect(ERROR_KEYS, JSON.stringify(Object.keys(error))).to.include.members(Object.keys(error));
        }
        expect(errors!.find((e) => e.instancePath === '/confirm')!.params).to.deep.eq({ $data: '1/password' });
      });

      it('tryValidate() keeps the params of a rule that holds no $data', () => {
        const [, errors] = validator.tryValidate({ type: 'object', properties: { name: { type: 'string', minLength: 5 } } }, { name: 'ab' });

        expect(errors).to.have.lengthOf(1);
        expect(errors![0].params).to.deep.eq({ limit: 5 });
        expect(Object.keys(errors![0])).to.not.include.members(['data', 'schema', 'parentSchema']);
      });

      it('validateSchema() returns errors without the checked schema data', () => {
        const [valid, errors] = validator.validateSchema({ type: 'object', properties: { x: { minLength: 'Zq7NotANumber' } } });

        expect(valid).to.eq(false);
        expect(JSON.stringify(errors)).to.not.contain('Zq7NotANumber');
        for (const error of errors!) {
          expect(ERROR_KEYS).to.include.members(Object.keys(error));
        }
      });

      it('drops the discriminator tag value', () => {
        const err = failureOf(() => validator.validate(DISCRIMINATOR_SCHEMA, { kind: 'Zq7TagValue' }));

        expectNoValue(err, ['Zq7TagValue'], 'discriminator');
        expect(err.details[0].rule).to.eq('discriminator');
        expect(err.details[0].params).to.deep.eq({ error: 'mapping', tag: 'kind' });
      });
    });
  }

  describe('ValidationFailed built by hand from non-verbose ajv errors', () => {
    const confirmError = {
      instancePath: '/confirm',
      schemaPath: '#/properties/confirm/const',
      keyword: 'const',
      params: { allowedValue: PASSWORD },
      message: 'must be equal to constant',
    } as IValidationError;

    const foreignLimitError = {
      instancePath: '/creds/code',
      schemaPath: `${REFERENCED_ID}#/properties/code/minLength`,
      keyword: 'minLength',
      params: { limit: PIN },
      message: `must NOT have fewer than ${PIN} characters`,
    } as IValidationError;

    it('redacts an error whose schemaPath leads to a $data node', () => {
      const err = new ValidationFailed('validation error', [confirmError], FORM_SCHEMA);

      expectNoValue(err, [PASSWORD], 'local $data path');
      expect(err.details[0].params).to.deep.eq({ $data: '1/password' });
    });

    it('redacts a value-bearing rule it cannot locate when the schema uses $data', () => {
      const err = new ValidationFailed('validation error', [foreignLimitError], OUTER_SCHEMA_WITH_DATA);

      expectNoValue(err, [String(PIN)], 'unresolvable path');
    });

    it('keeps the params when the schema uses no $data', () => {
      const err = new ValidationFailed('validation error', [foreignLimitError], OUTER_SCHEMA);

      expect(err.details[0].params).to.deep.eq({ limit: PIN });
    });

    it('drops the discriminator tag value', () => {
      const error = {
        instancePath: '',
        schemaPath: '#/discriminator',
        keyword: 'discriminator',
        params: { error: 'tag', tag: 'kind', tagValue: { nested: 'Zq7TagObject' } },
        message: 'tag "kind" must be string',
      } as unknown as IValidationError;

      expectNoValue(new ValidationFailed('validation error', [error]), ['Zq7TagObject'], 'discriminator');
    });
  });

  describe('ValidationFailed.toString()', () => {
    it('names the schema by $id only', () => {
      const err = new ValidationFailed('validation error', [], { $id: 'http://spinajs/data-ref/x.json', title: 'Zq7Title', description: 'Zq7Description' });

      expect(err.toString()).to.contain('http://spinajs/data-ref/x.json');
      expect(err.toString()).to.not.contain('Zq7Title');
      expect(err.toString()).to.not.contain('Zq7Description');
    });

    it('prints no title or description of a schema without $id', () => {
      const err = new ValidationFailed('validation error', [], { title: 'Zq7Title', description: 'Zq7Description' });

      expect(err.toString()).to.not.contain('Zq7Title');
      expect(err.toString()).to.not.contain('Zq7Description');
    });
  });
});

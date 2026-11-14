import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MANIFEST_VERSION, type Manifest } from '@spinajs/manifest';
import '@spinajs/log';

import { DECIMAL_PATTERN, manifestSchemaKey, manifestValidatorOf, prepareManifestSchemas } from '../src/index.js';
import { DataValidator } from '../src/validator.js';

class QuietConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, coerceTypes: true, useDefaults: true, messages: false },
    };
  }
}

const MONEY_ID = 'spinajs/app/Money';
const MONEY = {
  $id: MONEY_ID,
  type: 'object',
  properties: {
    amount: { type: 'string', format: 'decimal', 'x-spinajs-type': 'Decimal' },
    at: { type: 'string', format: 'date-time', 'x-spinajs-type': 'DateTime' },
    units: { type: 'string', pattern: '^-?[0-9]+$', 'x-spinajs-type': 'bigint' },
  },
  required: ['amount'],
  additionalProperties: false,
};

const manifest: Manifest = {
  manifestVersion: MANIFEST_VERSION,
  app: { name: 'test-app', version: '0.0.0', root: process.cwd(), outDir: 'lib' },
  packages: [],
  generatedAt: '1970-01-01T00:00:00.000Z',
  hash: '',
  services: [],
  values: [],
  controllers: [],
  socketControllers: [],
  socketContracts: [],
  configModules: [],
  configUsages: [],
  models: [],
  migrations: [],
  schemas: { [MONEY_ID]: MONEY },
  schedules: [],
  commands: [],
  queueMessages: [],
  diagnostics: [],
};

const ACCEPTED = ['12.50', '0', '-3', '-0.5', '1000000000000000000000.000000001'];
const REJECTED = ['1e3', '01', '1.', '.5', '+1', '1,5', ' 1', 'NaN', ''];

describe('the decimal format', function () {
  this.timeout(15000);

  it('is plain decimal text without an exponent', () => {
    for (const text of ACCEPTED) expect(DECIMAL_PATTERN.test(text), text).to.equal(true);
    for (const text of REJECTED) expect(DECIMAL_PATTERN.test(text), text).to.equal(false);
  });

  it('never reaches Ajv as an x-spinajs-type keyword', () => {
    const [money] = prepareManifestSchemas(manifest);
    const properties = money.properties as Record<string, Record<string, unknown>>;
    expect(properties.amount).to.deep.equal({ type: 'string', format: 'decimal' });
    expect(properties.at).to.deep.equal({ type: 'string', format: 'date-time' });
    expect(properties.units).to.deep.equal({ type: 'string', pattern: '^-?[0-9]+$' });
  });

  for (const coerce of [false, true]) {
    it(`is checked by ManifestValidator ${coerce ? 'with' : 'without'} coercion`, () => {
      const validate = manifestValidatorOf(manifest).validator(MONEY_ID, { coerce });
      for (const amount of ACCEPTED) expect(() => validate({ amount }), amount).to.not.throw();
      for (const amount of REJECTED) expect(() => validate({ amount }), amount).to.throw();
    });
  }

  describe('DataValidator', () => {
    let validator: DataValidator;

    before(async () => {
      DI.clearCache();
      DI.register(QuietConfiguration).as(Configuration);
      await DI.resolve(Configuration);
      validator = await DI.resolve(DataValidator);
    });

    after(() => {
      DI.clearCache();
    });

    const amountSchema = (id: string) => ({ $id: id, type: 'object', properties: { amount: { type: 'string', format: 'decimal' } }, required: ['amount'] });

    // An `authn.` id is validated by the strict instance, without coercion.
    for (const id of ['app.Money', 'authn.Money']) {
      it(`checks it on the instance that validates ${id}`, () => {
        expect(validator.isStrict(id)).to.equal(id.startsWith('authn.'));
        for (const amount of ACCEPTED) expect(validator.tryValidate(amountSchema(id), { amount })[0], amount).to.equal(true);
        for (const amount of REJECTED) expect(validator.tryValidate(amountSchema(id), { amount })[0], amount).to.equal(false);
      });
    }

    it('checks it in a manifest schema loaded by manifestSchemaKey', () => {
      const [prepared] = prepareManifestSchemas(manifest);
      validator.addSchema(prepared, manifestSchemaKey(MONEY_ID));
      expect(validator.tryValidate(manifestSchemaKey(MONEY_ID), { amount: '12.50' })[0]).to.equal(true);
      expect(validator.tryValidate(manifestSchemaKey(MONEY_ID), { amount: '1e3' })[0]).to.equal(false);
    });
  });
});

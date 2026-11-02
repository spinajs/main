import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import Ajv from 'ajv';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { InvalidOperation } from '@spinajs/exceptions';
import { DataValidator } from '../src/validator.js';
import { ISchema, SchemaSource } from '../src/types.js';

type AjvPrototype = { validateSchema(schema: unknown): unknown; addKeyword(def: unknown): unknown };
const AjvConstructor = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as unknown as { prototype: AjvPrototype };

const loginBody = (id: string) => ({
  $id: id,
  type: 'object',
  required: ['login'],
  properties: { login: { type: 'string', maxLength: 16 } },
});

const SOURCE_SCHEMAS = [loginBody('boot.First'), loginBody('boot.Second'), { $id: 'boot.Shared', type: 'string', maxLength: 4 }];

class FixedSource extends SchemaSource {
  public Load(): Promise<ISchema[]> {
    return Promise.resolve(SOURCE_SCHEMAS.map((schema) => ({ schema, file: 'fixed' })));
  }
}

class BootCostConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, coerceTypes: true, useDefaults: true },
    };
  }
}

describe('DataValidator boot cost', function () {
  this.timeout(15000);

  let createAjv: sinon.SinonSpy;
  let validateSchema: sinon.SinonSpy;
  let addKeyword: sinon.SinonSpy;
  let validator: DataValidator;

  beforeEach(async () => {
    DI.clearCache();
    DI.register(BootCostConfiguration).as(Configuration);
    DI.register(FixedSource).as(SchemaSource);
    await DI.resolve(Configuration);
    createAjv = sinon.spy(DataValidator.prototype as unknown as { createAjv(o: object): unknown }, 'createAjv');
    validateSchema = sinon.spy(AjvConstructor.prototype, 'validateSchema');
    addKeyword = sinon.spy(AjvConstructor.prototype, 'addKeyword');
    validator = await DI.resolve(DataValidator);
  });

  afterEach(() => {
    sinon.restore();
    DI.unregister(FixedSource);
    DI.clearCache();
  });

  const metaChecksOf = (id: string) => validateSchema.getCalls().filter((c) => (c.args[0] as { $id?: string } | undefined)?.$id === id).length;

  it('creates one Ajv instance while no schema with a strict id is validated', () => {
    expect(createAjv.callCount).to.equal(1);

    expect(validator.tryValidate('boot.First', { login: 5 })[0]).to.equal(true);
    expect(validator.tryValidate(loginBody('app.Inline'), { login: 'a' })[0]).to.equal(true);
    expect(createAjv.callCount).to.equal(1);
  });

  it('creates the strict instance on the first strict validation, with the schemas registered before it', () => {
    validator.addSchema({ $id: 'boot.Late', type: 'string', maxLength: 4 }, 'boot.Late');
    const schema = { $id: 'authn.BootRef', type: 'object', properties: { login: { $ref: 'boot.Shared' }, alias: { $ref: 'boot.Late' } } };

    expect(validator.tryValidate(schema, { login: 1 })[0]).to.equal(false);
    expect(validator.tryValidate(schema, { login: 'abc', alias: 'abcde' })[0]).to.equal(false);
    expect(validator.tryValidate(schema, { login: 'abc', alias: 'abc' })[0]).to.equal(true);
    expect(createAjv.callCount).to.equal(2);
  });

  it('adds a schema registered after the strict instance exists to it as well', () => {
    validator.tryValidate(loginBody('authz.Warmup'), { login: 'a' });
    validator.addSchema({ $id: 'boot.After', type: 'string', maxLength: 2 }, 'boot.After');

    const schema = { $id: 'authz.UsesAfter', type: 'object', properties: { code: { $ref: 'boot.After' } } };
    expect(validator.tryValidate(schema, { code: 'abc' })[0]).to.equal(false);
    expect(validator.tryValidate(schema, { code: 'ab' })[0]).to.equal(true);
  });

  it('builds the strict instance once', () => {
    validator.tryValidate(loginBody('authn.One'), { login: 'a' });
    validator.tryValidate(loginBody('authz.Two'), { login: 'a' });
    expect(createAjv.callCount).to.equal(2);
  });

  it('does not hand a removed schema to a strict instance created later', () => {
    validator.addSchema({ $id: 'boot.Removed', type: 'string' }, 'boot.Removed');
    validator.removeSchema('boot.Removed');
    validator.addSchema({ $id: 'boot.Removed', type: 'number' }, 'boot.Removed');

    const schema = { $id: 'authn.UsesRemoved', type: 'object', properties: { n: { $ref: 'boot.Removed' } } };
    expect(validator.tryValidate(schema, { n: 1 })[0]).to.equal(true);
    expect(validator.tryValidate(schema, { n: 'x' })[0]).to.equal(false);
  });

  it('checks each source schema against the meta-schema once', () => {
    for (const s of SOURCE_SCHEMAS) expect(metaChecksOf(s.$id), s.$id).to.equal(1);
  });

  it('keeps the meta-schema check of a schema added by hand', () => {
    expect(() => validator.addSchema({ $id: 'boot.Bad', type: 7 }, 'boot.Bad')).to.throw(/schema is invalid/);
  });

  it('refuses the strict instance before resolve() built the options it needs', () => {
    class EarlyAccess extends DataValidator {
      public strictBeforeResolve() {
        return this.StrictValidator;
      }
    }
    expect(() => new EarlyAccess().strictBeforeResolve()).to.throw(InvalidOperation, /super\.resolve\(\)/);
  });

  it('installs no keyword plugin until a schema uses one', () => {
    const plugin = () => addKeyword.getCalls().filter((c) => ['$merge', 'uniqueItemProperties'].includes((c.args[0] as { keyword?: string })?.keyword ?? '')).length;
    expect(plugin()).to.equal(0);

    const schema = { $id: 'boot.Unique', type: 'array', uniqueItemProperties: ['id'] };
    expect(validator.tryValidate(schema, [{ id: 1 }, { id: 1 }])[0]).to.equal(false);
    expect(validator.tryValidate(schema, [{ id: 1 }, { id: 2 }])[0]).to.equal(true);
    expect(plugin()).to.equal(2);
  });
});

class LenientConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, strict: false },
    };
  }
}

type CustomAjv = { removeKeyword(k: string): unknown; addKeyword(def: object): unknown };

// Validates `range` as "equals the first bound", so the test can tell it from the ajv-keywords one.
class OwnRangeValidator extends DataValidator {
  protected createAjv(options: object) {
    const ajv = super.createAjv(options) as CustomAjv;
    ajv.removeKeyword('range');
    ajv.addKeyword({ keyword: 'range', type: 'number', schemaType: 'array', validate: (r: number[], v: number) => v === r[0] });
    return ajv;
  }
}

class UniqueIdsValidator extends DataValidator {
  protected createAjv(options: object) {
    const ajv = super.createAjv(options) as CustomAjv;
    ajv.addKeyword({ keyword: 'uniqueIds', macro: () => ({ uniqueItemProperties: ['id'] }) });
    return ajv;
  }
}

// Ajv without strict mode ignores a keyword it does not know, so a plugin keyword missing from an instance would let data through.
describe('DataValidator subclass keywords without Ajv strict mode', function () {
  this.timeout(15000);

  const duplicates = [{ id: 1 }, { id: 1 }];

  async function validatorOf(type: typeof DataValidator) {
    DI.clearCache();
    DI.register(LenientConfiguration).as(Configuration);
    DI.register(FixedSource).as(SchemaSource);
    DI.register(type).as(DataValidator);
    await DI.resolve(Configuration);
    return DI.resolve(DataValidator);
  }

  afterEach(() => {
    DI.unregister(FixedSource);
    DI.unregister(OwnRangeValidator);
    DI.unregister(UniqueIdsValidator);
    DI.clearCache();
  });

  for (const prefix of ['app', 'authn']) {
    it(`keeps a plugin keyword replaced in createAjv and the other plugin keywords (${prefix} id)`, async () => {
      const validator = await validatorOf(OwnRangeValidator);
      const ranged = { $id: `${prefix}.Ranged`, type: 'object', properties: { n: { type: 'number', range: [1, 2] } } };
      expect(validator.tryValidate(ranged, { n: 2 })[0]).to.equal(false);
      expect(validator.tryValidate(ranged, { n: 1 })[0]).to.equal(true);
      expect(validator.tryValidate({ $id: `${prefix}.Unique`, type: 'array', uniqueItemProperties: ['id'] }, duplicates)[0]).to.equal(false);
    });

    it(`enforces a macro keyword of createAjv that expands into an ajv-keywords keyword (${prefix} id)`, async () => {
      const validator = await validatorOf(UniqueIdsValidator);
      const schema = { $id: `${prefix}.UniqueIds`, type: 'array', uniqueIds: true };
      expect(validator.tryValidate(schema, duplicates)[0]).to.equal(false);
      expect(validator.tryValidate(schema, [{ id: 1 }, { id: 2 }])[0]).to.equal(true);
    });
  }
});

/* eslint-disable @typescript-eslint/no-unsafe-return */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import * as sinon from 'sinon';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { DataValidator } from '../src/validator.js';
import { DtoSchemaProvider, Schema } from '../src/index.js';
import { InvalidArgument } from '@spinajs/exceptions';
import "@spinajs/log";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir('./../test/schemas')],
        },
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      validation: {
        // enable all errors on  validation, not only first one that occurred
        allErrors: true,

        // remove properties that are not defined in schema
        removeAdditional: true,

        // set default values if possible
        useDefaults: true,

        // The option coerceTypes allows you to have your data types coerced to the types specified in your schema type keywords
        coerceTypes: true,

        messages: false
      },
    };
  }
}

async function val() {
  return await DI.resolve(DataValidator);
}

describe('validator tests', function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should resolve validator', async () => {
    const v = await val();
    expect(v).to.be.not.null;
  });

  it('should load schemas from json and js files', async () => {
    const v = await val();
    expect(v.hasSchema('http://spinajs/example_js.schema.js')).to.be.true;
    expect(v.hasSchema('http://spinajs/example_json.schema.json')).to.be.true;
  });

  it('should try to validate object with schema from file', async () => {
    const v = await val();

    const [result, errors] = v.tryValidate('http://spinajs/example_json.schema.json', {
      productId: 1,
    });

    expect(result).to.be.true;
    expect(errors).to.be.null;
  });

  it('should validate object with schema from file', async () => {
    const v = await val();

    const func = () =>
      v.validate('http://spinajs/example_json.schema.json', {
        productId: 1,
      });

    expect(func).not.to.throw;
  });

  it('should validate object with schema from decorator', async () => {
    @Schema({
      properties: {
        foo: { type: 'string' },
      },
    })
    class foo {
      foo: string;
    }

    const data = new foo();
    data.foo = 'test';

    const v = await val();

    const [result, errors] = v.tryValidate(data);
    expect(result).to.be.true;
    expect(errors).to.be.null;
  });

  it('Should valide object with schema name from decorator', async () => {
    @Schema('http://spinajs/example_json.schema.json')
    class foo {
      productId: number;
    }

    const data = new foo();
    data.productId = 1;

    const v = await val();

    const [result, errors] = v.tryValidate(data);
    expect(result).to.be.true;
    expect(errors).to.be.null;
  });

  it('trying to validate shouhld fail with proper error', async () => {
    const v = await val();

    const [result, errors] = v.tryValidate('http://spinajs/example_json.schema.json', {
      productId: 'dasdas',
    });

    expect(result).to.be.false;
    expect(errors).to.be.not.null;
    expect(errors)
      .to.be.an('array')
      .to.have.deep.members([
        {
          instancePath: '/productId',
          keyword: 'type',
          schemaPath: '#/properties/productId/type',
          params: {
            type: 'integer',
          },
        },
      ]);
  });

  it('validate should throw on invalid data', async () => {
    const v = await val();

    const func = () =>
      v.validate('http://spinajs/example_json.schema.json', {
        productId: 'sss',
      });

    expect(func).to.throw('validation error');
  });

  describe('filesystem schema sources', () => {
    it('should load .mjs schema files', async () => {
      const v = await val();
      expect(v.hasSchema('http://spinajs/example_mjs.schema.mjs')).to.be.true;
    });

    it('should skip files with no default export without breaking other schemas', async () => {
      const v = await val();

      // the no-default-export fixture must NOT be registered ...
      expect(v.hasSchema('http://spinajs/should_not_be_loaded.schema.mjs')).to.be.false;

      // ... yet the valid schemas around it must still load
      expect(v.hasSchema('http://spinajs/example_json.schema.json')).to.be.true;
      expect(v.hasSchema('http://spinajs/example_js.schema.js')).to.be.true;
      expect(v.hasSchema('http://spinajs/example_mjs.schema.mjs')).to.be.true;
    });

    it('should skip malformed json schema files without breaking other schemas', async () => {
      const v = await val();

      // malformed.json cannot be parsed and must be skipped ...
      expect(v.hasSchema('http://spinajs/malformed.schema.json')).to.be.false;

      // ... while the well-formed schemas remain available
      expect(v.hasSchema('http://spinajs/example_json.schema.json')).to.be.true;
    });
  });

  describe('strict behavior', () => {
    it('tryValidate with unknown schema id returns empty_schema error', async () => {
      const v = await val();

      const [result, errors] = v.tryValidate('http://spinajs/does-not-exist.schema.json', { productId: 1 });

      expect(result).to.be.false;
      expect(errors).to.be.an('array');
      expect(errors![0].keyword).to.equal('empty_schema');
      expect(errors![0].message).to.equal('objects schema is not set');
    });

    it('tryValidate on undecorated plain object returns empty_schema error', async () => {
      const v = await val();

      const [result, errors] = v.tryValidate({ foo: 'bar' });

      expect(result).to.be.false;
      expect(errors![0].keyword).to.equal('empty_schema');
    });

    it('validate(null) throws InvalidArgument for null data', async () => {
      const v = await val();

      const func = () => v.validate(null as any);
      expect(func).to.throw(InvalidArgument, 'data is null or undefined');
    });

    it('validate with unknown schema id throws InvalidArgument', async () => {
      const v = await val();

      const func = () => v.validate('http://spinajs/does-not-exist.schema.json', { productId: 1 });
      expect(func).to.throw(InvalidArgument, 'objects schema is not set');
    });
  });

  describe('validator options', () => {
    it('removeAdditional strips properties not defined in schema', async () => {
      const v = await val();

      v.addSchema(
        {
          $id: 'http://spinajs/no-additional.schema.json',
          type: 'object',
          additionalProperties: false,
          properties: { productId: { type: 'integer' } },
        },
        'http://spinajs/no-additional.schema.json',
      );

      const data: any = { productId: 1, notInSchema: 'strip me' };
      v.validate('http://spinajs/no-additional.schema.json', data);

      expect(data.notInSchema).to.be.undefined;
      expect(data.productId).to.equal(1);
    });

    it('useDefaults fills in default values', async () => {
      const v = await val();

      v.addSchema(
        {
          $id: 'http://spinajs/defaults.schema.json',
          type: 'object',
          properties: {
            role: { type: 'string', default: 'user' },
          },
        },
        'http://spinajs/defaults.schema.json',
      );

      const data: any = {};
      v.validate('http://spinajs/defaults.schema.json', data);

      expect(data.role).to.equal('user');
    });

    it('coerceTypes coerces string "1" to integer 1', async () => {
      const v = await val();

      const data: any = { productId: '1' };
      v.validate('http://spinajs/example_json.schema.json', data);

      expect(data.productId).to.equal(1);
    });
  });

  describe('public api', () => {
    it('addSchema / hasSchema / getSchema / removeSchema', async () => {
      const v = await val();

      const id = 'http://spinajs/api-test.schema.json';
      const schema = {
        $id: id,
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      expect(v.hasSchema(id)).to.be.false;

      v.addSchema(schema, id);
      expect(v.hasSchema(id)).to.be.true;

      const resolved = v.getSchema(id) as any;
      expect(resolved).to.be.an('object');
      expect(resolved.$id).to.equal(id);

      v.removeSchema(id);
      expect(v.hasSchema(id)).to.be.false;
    });

    it('duplicate addSchema warns and keeps the schema resolvable', async () => {
      const v = await val();

      const id = 'http://spinajs/duplicate.schema.json';
      const schema = { $id: id, type: 'object', properties: { a: { type: 'string' } } };

      v.addSchema(schema, id);

      // second registration under the same id must not throw
      const func = () => v.addSchema(schema, id);
      expect(func).not.to.throw();

      // schema is still resolvable
      expect(v.hasSchema(id)).to.be.true;

      v.removeSchema(id);
    });
  });

  describe('registered ajv plugins', () => {
    it('ajv-formats: format "email" rejects invalid email', async () => {
      const v = await val();

      v.addSchema(
        {
          $id: 'http://spinajs/email.schema.json',
          type: 'object',
          properties: { mail: { type: 'string', format: 'email' } },
          required: ['mail'],
        },
        'http://spinajs/email.schema.json',
      );

      const [invalid] = v.tryValidate('http://spinajs/email.schema.json', { mail: 'not-an-email' });
      expect(invalid).to.be.false;

      const [valid, errors] = v.tryValidate('http://spinajs/email.schema.json', { mail: 'someone@example.com' });
      expect(valid).to.be.true;
      expect(errors).to.be.null;
    });

    it('ajv-keywords: transform trims a string property', async () => {
      const v = await val();

      v.addSchema(
        {
          $id: 'http://spinajs/transform.schema.json',
          type: 'object',
          properties: { name: { type: 'string', transform: ['trim'] } },
        },
        'http://spinajs/transform.schema.json',
      );

      const data: any = { name: '  spina  ' };
      v.validate('http://spinajs/transform.schema.json', data);
      expect(data.name).to.equal('spina');
    });

    it('ajv-merge-patch: $merge combines source and with schemas', async () => {
      const v = await val();

      v.addSchema(
        {
          $id: 'http://spinajs/merge.schema.json',
          $merge: {
            source: {
              type: 'object',
              properties: { p: { type: 'string' } },
              required: ['p'],
            },
            with: {
              properties: { q: { type: 'integer' } },
              required: ['q'],
            },
          },
        },
        'http://spinajs/merge.schema.json',
      );

      const [missingQ] = v.tryValidate('http://spinajs/merge.schema.json', { p: 'hello' });
      expect(missingQ).to.be.false;

      const [complete, errors] = v.tryValidate('http://spinajs/merge.schema.json', { p: 'hello', q: 5 });
      expect(complete).to.be.true;
      expect(errors).to.be.null;
    });
  });

  describe('DtoSchemaProvider integration (real DataValidator)', () => {
    it('resolves a $ref @Schema(name) through the resolved DataValidator', async () => {
      @Schema('http://spinajs/example_json.schema.json')
      class SomeRefDto {}
      // reference the class so it is not stripped as unused
      expect(SomeRefDto.name).to.equal('SomeRefDto');

      // ensure the validator (and its file schemas) are resolved first
      await val();

      const provider = await DI.resolve(DtoSchemaProvider);
      const schema = provider.getSchema('SomeRefDto') as any;

      expect(schema).to.be.an('object');
      expect(schema.$id).to.equal('http://spinajs/example_json.schema.json');
    });
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-return */
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import * as sinon from 'sinon';
import { expect } from 'chai';
import * as _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { DataValidator } from '../src/validator';
import { Schema } from '../src';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

class TestConfiguration extends FrameworkConfiguration {
  set(_path: string | string[], _value: any): void {}

  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            schemas: [dir('./../test/schemas')],
          },
        },
        logger: {
          variables: [],
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
        },
      },
      mergeArrays,
    );
  }
}

function val() {
  return DI.resolve(DataValidator);
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
    const v = val();
    expect(v).to.be.not.null;
  });

  it('should load schemas from json and js files', async () => {
    const v = val();
    expect(v.hasSchema('http://spinajs/example_js.schema.js')).to.be.true;
    expect(v.hasSchema('http://spinajs/example_json.schema.json')).to.be.true;
  });

  it('should try to validate object with schema from file', async () => {
    const v = val();

    const [result, errors] = v.tryValidate('http://spinajs/example_json.schema.json', {
      productId: 1,
    });

    expect(result).to.be.true;
    expect(errors).to.be.null;
  });

  it('should validate object with schema from file', async () => {
    const v = val();

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

    const v = val();

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

    const v = val();

    const [result, errors] = v.tryValidate(data);
    expect(result).to.be.true;
    expect(errors).to.be.null;
  });

  it('trying to validate shouhld fail with proper error', async () => {
    const v = val();

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
          message: 'must be integer',
          schemaPath: '#/properties/productId/type',
          params: {
            type: 'integer',
          },
        },
      ]);
  });

  it('validate should throw on invalid data', async () => {
    const v = val();

    const func = () =>
      v.validate('http://spinajs/example_json.schema.json', {
        productId: 'sss',
      });

    expect(func).to.throw('validation error');
  });
});

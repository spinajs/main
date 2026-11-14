import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { Schema } from '../src/decorators.js';
import { ValidationFailed } from '../src/exceptions/index.js';
import { addSafeKeywords, jsonEqual } from '../src/keywords.js';
import Ajv from 'ajv';

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

const DEFAULTS = { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false };

async function boot(validation: Record<string, unknown>) {
  const config = validationConfig(validation);
  DI.register(config).as(Configuration);
  DI.uncache(Configuration);
  DI.uncache(DataValidator);
  await DI.resolve(Configuration);
  return { config, validator: await DI.resolve(DataValidator) };
}

const prop = (v: object, id?: string) => ({ ...(id ? { $id: id } : {}), type: 'object', properties: { v } });

@Schema(prop({ type: 'integer', minimum: 0, maximum: 100 }))
class BoundedDto {
  public v: number;
}

describe('non-finite numbers and deep-equal keywords', function () {
  this.timeout(15000);

  for (const [label, options] of [
    ['coerceTypes: true', DEFAULTS],
    ["coerceTypes: 'array'", { ...DEFAULTS, coerceTypes: 'array' }],
    ['allErrors: false', { ...DEFAULTS, allErrors: false }],
  ] as const) {
    describe(label, () => {
      let validator: DataValidator;
      let config: unknown;

      before(async () => {
        ({ config, validator } = await boot(options));
      });

      after(() => {
        DI.uncache(DataValidator);
        DI.uncache(Configuration);
        DI.unregister(config as any);
      });

      describe('a string coerced to a non-finite number', () => {
        const schemas: [string, object][] = [
          ['integer 0..100', { type: 'integer', minimum: 0, maximum: 100 }],
          ['number 0..100', { type: 'number', minimum: 0, maximum: 100 }],
          ['number, exclusive bounds', { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 5 }],
          ['integer multipleOf 2', { type: 'integer', multipleOf: 2 }],
          ['unbounded number', { type: 'number' }],
          ['nullable number', { type: ['number', 'null'] }],
        ];

        for (const [name, schema] of schemas) {
          for (const raw of ['Infinity', '-Infinity', '1e400', '-1e400']) {
            it(`${name} rejects ${raw} with a type error at the field`, () => {
              const data = { v: raw };
              const [valid, errors] = validator.tryValidate(prop(schema), data);

              expect(valid, `accepted ${String(data.v)}`).to.eq(false);
              expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['/v', 'type']]);
            });
          }
        }

        it('rejects one inside an array of bounded integers, pointing at the item', () => {
          const [valid, errors] = validator.tryValidate(prop({ type: 'array', items: { type: 'integer', minimum: 0, maximum: 100 } }), { v: ['5', '-Infinity'] });

          expect(valid).to.eq(false);
          expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['/v/1', 'type']]);
        });

        it('rejects one in a nested object', () => {
          const schema = { type: 'object', properties: { page: prop({ type: 'integer', minimum: 1 }) } };
          const [valid, errors] = validator.tryValidate(schema, { page: { v: '-Infinity' } });

          expect(valid).to.eq(false);
          expect(errors!.map((e) => e.instancePath)).to.deep.eq(['/page/v']);
        });

        it('rejects one for a @Schema DTO with ValidationFailed', () => {
          const dto = Object.assign(new BoundedDto(), { v: '-Infinity' });
          expect(() => validator.validate(dto)).to.throw(ValidationFailed);
        });

        it('rejects one for a registered schema', () => {
          validator.addSchema(prop({ type: 'integer', minimum: 0 }, 'app.NonFiniteRegistered'), 'app.NonFiniteRegistered');
          expect(validator.tryValidate('app.NonFiniteRegistered', { v: 'Infinity' })[0]).to.eq(false);
          validator.removeSchema('app.NonFiniteRegistered');
        });
      });

      describe('a non-finite number that is not a coerced string', () => {
        it('a JSON body 1e400 literal is rejected', () => {
          const [valid, errors] = validator.tryValidate(prop({ type: 'number', maximum: 5 }), JSON.parse('{"v":1e400}'));

          expect(valid).to.eq(false);
          expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['/v', 'type']]);
        });

        it('a scalar -Infinity is rejected once', () => {
          const [valid, errors] = validator.tryValidate({ type: 'integer', minimum: 1, maximum: 100 }, -Infinity as unknown as object);

          expect(valid).to.eq(false);
          expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['', 'type']]);
        });

        it('NaN is rejected', () => {
          expect(validator.tryValidate(prop({ type: 'number' }), { v: NaN })[0]).to.eq(false);
        });
      });

      describe('finite values and coercion stay as they were', () => {
        it('coerces a numeric string inside the bounds', () => {
          const data = { v: '7' as unknown };
          expect(validator.tryValidate(prop({ type: 'integer', minimum: 0, maximum: 100 }), data)[0]).to.eq(true);
          expect(data.v).to.eq(7);
        });

        it('still reports a finite value out of bounds as minimum / maximum', () => {
          const [, errors] = validator.tryValidate(prop({ type: 'integer', minimum: 0, maximum: 100 }), { v: '500' });
          expect(errors!.map((e) => e.keyword)).to.deep.eq(['maximum']);
        });

        it('keeps a large but finite 1e300, as a string or a number', () => {
          const data = { v: '1e300' as unknown };
          expect(validator.tryValidate(prop({ type: 'number' }), data)[0]).to.eq(true);
          expect(data.v).to.eq(1e300);
          expect(validator.tryValidate(prop({ type: 'number' }), { v: -1e300 })[0]).to.eq(true);
          expect(validator.tryValidate(prop({ type: 'number' }), { v: Number.MAX_VALUE })[0]).to.eq(true);
        });

        it('keeps the string "Infinity" where the type also allows a string', () => {
          const data = { v: 'Infinity' };
          expect(validator.tryValidate(prop({ type: ['number', 'string'] }), data)[0]).to.eq(true);
          expect(data.v).to.eq('Infinity');
          expect(validator.tryValidate(prop({ type: 'string' }), { v: 'Infinity' })[0]).to.eq(true);
        });

        it('refuses a non-finite number no rule constrains, at its path', () => {
          const [valid, errors] = validator.tryValidate(prop({}), { v: Infinity });
          expect(valid).to.eq(false);
          expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['/v', 'type']]);
          expect(validator.tryValidate(prop({ type: 'boolean' }), { v: 'true' })[0]).to.eq(true);
        });
      });

      describe('deep-equal keywords over a value with an own valueOf or toString', () => {
        const cases: [string, object, string, string][] = [
          ['object const', prop({ const: { a: 1 } }), '{"v":{"valueOf":1}}', 'const'],
          ['object const, toString', prop({ const: { a: 1 } }), '{"v":{"toString":false}}', 'const'],
          ['object enum', prop({ enum: [{ a: 1 }, 'b'] }), '{"v":{"valueOf":1}}', 'enum'],
          ['primitive enum', prop({ enum: ['a', 'b'] }), '{"v":{"valueOf":1}}', 'enum'],
          ['uniqueItems over objects', prop({ type: 'array', uniqueItems: true }), '{"v":[{"valueOf":1},{"valueOf":1}]}', 'uniqueItems'],
          ['uniqueItems over typed objects', prop({ type: 'array', items: { type: 'object' }, uniqueItems: true }), '{"v":[{"toString":0},{"toString":0}]}', 'uniqueItems'],
          ['uniqueItemProperties', prop({ type: 'array', uniqueItemProperties: ['m'] }), '{"v":[{"m":{"valueOf":1}},{"m":{"valueOf":1}}]}', 'uniqueItemProperties'],
        ];

        for (const [name, schema, body, keyword] of cases) {
          it(`${name} fails validation at the field instead of throwing`, () => {
            const [valid, errors] = validator.tryValidate(schema, JSON.parse(body));

            expect(valid).to.eq(false);
            expect(errors!.map((e) => [e.instancePath, e.keyword])).to.deep.eq([['/v', keyword]]);
          });

          it(`${name} makes validate() throw ValidationFailed`, () => {
            expect(() => validator.validate(schema, JSON.parse(body))).to.throw(ValidationFailed);
          });
        }

        it('treats valueOf and toString as plain keys when comparing', () => {
          expect(validator.tryValidate(prop({ const: { valueOf: 1 } }), JSON.parse('{"v":{"valueOf":1}}'))[0]).to.eq(true);
          expect(validator.tryValidate(prop({ enum: [{ toString: 'x' }] }), JSON.parse('{"v":{"toString":"x"}}'))[0]).to.eq(true);
          expect(validator.tryValidate(prop({ const: { a: 1 } }), { v: { a: 1 } })[0]).to.eq(true);
          expect(validator.tryValidate(prop({ const: [1, { a: [2] }] }), { v: [1, { a: [2] }] })[0]).to.eq(true);
          expect(validator.tryValidate(prop({ const: { a: 1 } }), { v: { a: 1, b: 2 } })[0]).to.eq(false);
        });

        it('uniqueItems accepts distinct objects, whichever comes first', () => {
          for (const body of ['{"v":[{"a":1},{"valueOf":1}]}', '{"v":[{"valueOf":1},{"a":1}]}', '{"v":[1,{"valueOf":1}]}']) {
            expect(validator.tryValidate(prop({ type: 'array', uniqueItems: true }), JSON.parse(body))[0], body).to.eq(true);
          }
        });

        it('uniqueItems still finds duplicates of plain values', () => {
          expect(validator.tryValidate(prop({ type: 'array', uniqueItems: true }), { v: [{ a: [1] }, { a: [1] }] })[0]).to.eq(false);
          expect(validator.tryValidate(prop({ type: 'array', items: { type: 'string' }, uniqueItems: true }), { v: ['a', 'b', 'a'] })[0]).to.eq(false);
          expect(validator.tryValidate(prop({ type: 'array', items: { type: ['string', 'number'] }, uniqueItems: true }), { v: ['1', 1] })[0]).to.eq(true);
        });

        it('uniqueItems finds a duplicated "__proto__" string', () => {
          expect(validator.tryValidate(prop({ type: 'array', items: { type: 'string' }, uniqueItems: true }), { v: ['__proto__', '__proto__'] })[0]).to.eq(false);
        });

        it('a $data const still compares with the referenced value', () => {
          const schema = { type: 'object', properties: { password: { type: 'string' }, confirm: { type: 'string', const: { $data: '1/password' } } } };
          expect(validator.tryValidate(schema, { password: 'a', confirm: 'a' })[0]).to.eq(true);
          expect(validator.tryValidate(schema, { password: 'a', confirm: 'b' })[0]).to.eq(false);
        });

        it('a $data enum still compares with the referenced values', () => {
          const schema = { type: 'object', properties: { allowed: { type: 'array' }, pick: { enum: { $data: '1/allowed' } } } };
          expect(validator.tryValidate(schema, { allowed: [{ a: 1 }], pick: { a: 1 } })[0]).to.eq(true);
          expect(validator.tryValidate(schema, { allowed: [{ a: 1 }], pick: { valueOf: 1 } })[0]).to.eq(false);
        });

        it('does not swallow an error that is not a comparison', () => {
          expect(() => validator.validate({ type: 'string', format: 'no-such-format' }, 'x' as unknown as object)).to.throw(Error, /no-such-format/);
        });
      });
    });
  }

  describe('jsonEqual', () => {
    it('compares values with a prototype of their own through that prototype', () => {
      expect(jsonEqual(new Date(1), new Date(1))).to.eq(true);
      expect(jsonEqual(new Date(1), new Date(2))).to.eq(false);
      expect(jsonEqual(/a/g, /a/g)).to.eq(true);
      expect(jsonEqual(/a/g, /a/i)).to.eq(false);
      expect(jsonEqual(new Date(1), {})).to.eq(false);
    });

    it('compares objects without a prototype by their keys', () => {
      const a = Object.assign(Object.create(null) as object, { x: 1 });
      const b = Object.assign(Object.create(null) as object, { x: 1 });
      expect(jsonEqual(a, b)).to.eq(true);
      expect(jsonEqual(a, { x: 1 })).to.eq(false);
    });

    it('treats NaN as equal to NaN and an array as different from an object', () => {
      expect(jsonEqual(NaN, NaN)).to.eq(true);
      expect(jsonEqual([], {})).to.eq(false);
      expect(jsonEqual({ constructor: 1 }, { constructor: 1 })).to.eq(true);
    });
  });

  describe('addSafeKeywords on an Ajv without ajv-keywords', () => {
    it('fixes type and const, and does not add uniqueItemProperties', () => {
      const AjvCtor = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (o: object) => { validate(schema: object, data: unknown): boolean; getKeyword(keyword: string): unknown; removeKeyword(keyword: string): unknown; addKeyword(definition: object): unknown };
      const ajv = new AjvCtor({ coerceTypes: true, strict: false });
      addSafeKeywords(ajv as unknown as Parameters<typeof addSafeKeywords>[0]);

      expect(ajv.validate({ type: 'object', properties: { v: { type: 'integer', minimum: 0 } } }, { v: '-Infinity' })).to.eq(false);
      expect(ajv.validate({ const: { a: 1 } }, JSON.parse('{"valueOf":1}'))).to.eq(false);
      expect(ajv.getKeyword('uniqueItemProperties')).to.eq(false);
    });
  });

  describe('a strict schema id ( no coercion )', () => {
    let validator: DataValidator;
    let config: unknown;

    before(async () => {
      ({ config, validator } = await boot(DEFAULTS));
    });

    after(() => {
      DI.uncache(DataValidator);
      DI.uncache(Configuration);
      DI.unregister(config as any);
    });

    it('rejects a non-finite number and a deep-equal trap', () => {
      expect(validator.tryValidate(prop({ type: 'integer', minimum: 0 }, 'authn.NonFinite'), { v: -Infinity })[0]).to.eq(false);
      expect(validator.tryValidate(prop({ type: 'integer', minimum: 0 }, 'authn.NonFiniteString'), { v: '-Infinity' })[0]).to.eq(false);
      expect(validator.tryValidate(prop({ const: { a: 1 } }, 'authn.ConstTrap'), JSON.parse('{"v":{"valueOf":1}}'))[0]).to.eq(false);
    });
  });
});

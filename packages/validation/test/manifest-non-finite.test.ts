import 'mocha';
import { expect } from 'chai';

import { manifestSchemaKey, ManifestValidator, prepareManifestSchemas } from '../src/manifest-source.js';
import { ValidationFailed } from '../src/exceptions/index.js';
import { manifestOf } from './manifest-of.js';

const P = (properties: Record<string, object>, extra: object = {}) => ({ type: 'object', properties, ...extra });

const SCHEMAS: Record<string, object> = {
  'app/Search': P({ page: { type: 'integer', minimum: 1, maximum: 100 } }),
  'app/Bounds': P({ limit: { minimum: 0, maximum: 10 } }),
  'app/IfLimit': P({ limit: { type: ['integer', 'string'], if: { type: 'integer' }, then: { maximum: 100 } } }),
  'app/NotNumber': P({ n: { not: { type: 'number' } } }),
  'app/Const': P({ meta: { const: { a: 1 } } }),
  'app/Enum': P({ kind: { enum: [{ a: 1 }, 'plain'] } }),
  'app/Tags': P({ tags: { type: 'array', uniqueItems: true } }),
  'app/Strings': P({ tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } }),
};
// An object literal's `__proto__` sets the prototype; JSON.parse makes it an own property, as a manifest file does.
SCHEMAS['app/Proto'] = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"name":{"type":"string"}},"required":["name"],"additionalProperties":false}') as object;

const errorOf = (fn: () => void): ValidationFailed => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationFailed) return err;
    throw err;
  }
  throw new Error('the data passed');
};
const fields = (err: ValidationFailed) => err.parameter.map((e) => [e.instancePath, e.keyword]);

describe('ManifestValidator: non-finite numbers and comparisons', function () {
  this.timeout(15000);

  const validators = () => new ManifestValidator(manifestOf(SCHEMAS));
  const query = (id: string) => validators().validator(id, { coerce: true, openRoot: true });
  const body = (id: string) => validators().validator(id, { coerce: false });

  for (const page of ['-Infinity', 'Infinity', '1e400']) {
    it(`a query ?page=${page} under integer bounds fails type at /page`, () => {
      expect(fields(errorOf(() => query('app/Search')({ page }))), page).to.deep.eq([['/page', 'type']]);
    });
  }

  it('a finite query page is still coerced', () => {
    const data = { page: '7' };
    query('app/Search')(data);
    expect(data.page).to.eq(7);
  });

  it('a JSON 1e400 under a type-less bound, and one an if coerced, are refused at their path', () => {
    expect(fields(errorOf(() => body('app/Bounds')(JSON.parse('{"limit":1e400}') as object)))).to.deep.eq([['/limit', 'type']]);
    expect(fields(errorOf(() => query('app/IfLimit')({ limit: '1e400' })))).to.deep.eq([['/limit', 'type']]);
    expect(fields(errorOf(() => query('app/NotNumber')({ n: 'Infinity' })))).to.deep.eq([['/n', 'type']]);
  });

  it('a real non-finite number is reported once, without the marker', () => {
    const err = errorOf(() => query('app/Search')({ page: -Infinity }));
    expect(err.parameter.map((e) => [e.instancePath, e.keyword, e.params])).to.deep.eq([['/page', 'type', { type: 'integer' }]]);
  });

  for (const [id, json, field, keyword] of [
    ['app/Const', '{"meta":{"toString":false}}', '/meta', 'const'],
    ['app/Const', '{"meta":{"valueOf":1}}', '/meta', 'const'],
    ['app/Enum', '{"kind":{"valueOf":1}}', '/kind', 'enum'],
    ['app/Tags', '{"tags":[{"valueOf":1},{"valueOf":1}]}', '/tags', 'uniqueItems'],
  ] as const) {
    it(`${json} fails ${keyword} at ${field} instead of throwing a TypeError`, () => {
      expect(fields(errorOf(() => body(id)(JSON.parse(json) as object)))).to.deep.eq([[field, keyword]]);
    });
  }

  it('distinct objects with an own valueOf are unique, a repeated "__proto__" string is not', () => {
    expect(() => body('app/Tags')(JSON.parse('{"tags":[{"a":1},{"valueOf":1}]}') as object)).to.not.throw();
    expect(fields(errorOf(() => body('app/Strings')({ tags: ['__proto__', '__proto__'] })))).to.deep.eq([['/tags', 'uniqueItems']]);
  });

  describe('a schema with a property named __proto__', () => {
    it('keeps the property through preparation', () => {
      const prepared = prepareManifestSchemas(manifestOf(SCHEMAS)).find((s) => s.$id === manifestSchemaKey('app/Proto'))!;
      const properties = prepared.properties as Record<string, unknown>;
      expect(Object.getPrototypeOf(properties)).to.eq(Object.prototype);
      expect(Object.keys(properties)).to.deep.eq(['__proto__', 'name']);
    });

    it('compiles, and Ajv reports a __proto__ key of the data as unknown, as it skips that name in properties', () => {
      expect(() => body('app/Proto')({ name: 'a' })).to.not.throw();
      const err = errorOf(() => body('app/Proto')(JSON.parse('{"name":"a","__proto__":"x"}') as object));
      expect(err.parameter.map((e) => [e.keyword, e.params])).to.deep.eq([['additionalProperties', { additionalProperty: '__proto__' }]]);
    });
  });
});

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
SCHEMAS['app/ProtoOpen'] = JSON.parse('{"type":"object","properties":{"nested":{"type":"object","properties":{"__proto__":{"type":"string","maxLength":3}}}}}') as object;
SCHEMAS['app/ProtoRequired'] = { type: 'object', properties: { name: { type: 'string' } }, required: ['__proto__'] };
SCHEMAS['app/ProtoHolder'] = P({ inner: { $ref: 'app/Proto' } });
SCHEMAS['app/ProtoBoth'] = { allOf: [{ $ref: 'app/Proto' }, { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: false }] };
SCHEMAS['app/ProtoDependencyValue'] = { type: 'object', dependencies: { a: ['__proto__'] } };
SCHEMAS['app/ProtoDependencyKey'] = JSON.parse('{"type":"object","dependencies":{"__proto__":["a"]}}') as object;
SCHEMAS['app/ProtoAnyRequired'] = { type: 'object', anyRequired: ['__proto__', 'b'] };
SCHEMAS['app/ProtoOneRequired'] = { type: 'object', oneRequired: ['b', '__proto__'] };
SCHEMAS['app/ProtoDeepRequired'] = { type: 'object', deepRequired: ['/a/__proto__'] };
SCHEMAS['app/ProtoDeepRequiredEscaped'] = { type: 'object', deepRequired: ['/a~1__proto__'] };
SCHEMAS['app/DefsNamedProto'] = JSON.parse('{"type":"object","properties":{"v":{"$ref":"#/definitions/__proto__"}},"definitions":{"__proto__":{"type":"string"}}}') as object;

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

  describe('a schema that declares a property named __proto__', () => {
    // Ajv skips that name: an open object would take any __proto__ value, and required: ['__proto__'] passes without it.
    for (const [id, where] of [
      ['app/Proto', 'in properties'],
      ['app/ProtoOpen', 'in the properties of a nested object'],
      ['app/ProtoRequired', 'in required'],
      ['app/ProtoDependencyValue', 'as a dependencies value'],
      ['app/ProtoDependencyKey', 'as a dependencies key'],
      ['app/ProtoAnyRequired', 'in anyRequired'],
      ['app/ProtoOneRequired', 'in oneRequired'],
      ['app/ProtoDeepRequired', 'as a deepRequired pointer segment'],
    ] as const) {
      it(`is refused ${where}, naming the schema`, () => {
        expect(() => body(id)).to.throw(Error, `schema ${id} declares a property named __proto__, which cannot be validated`);
        expect(() => query(id)).to.throw(Error, /declares a property named __proto__/);
      });
    }

    it('is left out of the prepared schemas, with the reason', () => {
      const unenforceable = new Map<string, string>();
      const ids = prepareManifestSchemas(manifestOf(SCHEMAS), unenforceable).map((s) => s.$id);
      expect([...unenforceable.keys()].sort()).to.deep.eq([
        'app/Proto',
        'app/ProtoAnyRequired',
        'app/ProtoBoth',
        'app/ProtoDeepRequired',
        'app/ProtoDependencyKey',
        'app/ProtoDependencyValue',
        'app/ProtoOneRequired',
        'app/ProtoOpen',
        'app/ProtoRequired',
      ]);
      expect(ids).to.not.include(manifestSchemaKey('app/Proto'));
      expect(ids).to.include(manifestSchemaKey('app/Search'));
    });

    it('refuses a schema that references one, by $ref or in an intersection', () => {
      expect(() => body('app/ProtoHolder')).to.throw(Error, 'schema app/ProtoHolder references app/Proto, which declares a property named __proto__ that cannot be validated');
      expect(() => body('app/ProtoBoth')).to.throw(Error, 'schema app/ProtoBoth references app/Proto, which declares a property named __proto__ that cannot be validated');
    });

    it('keeps a deepRequired pointer whose segment only contains __proto__ after an escaped slash', () => {
      expect(() => body('app/ProtoDeepRequiredEscaped')).to.not.throw();
    });

    it('keeps a definition named __proto__, which is a name and not a property', () => {
      expect(() => body('app/DefsNamedProto')({ v: 'a' })).to.not.throw();
      expect(fields(errorOf(() => body('app/DefsNamedProto')({ v: 1 })))).to.deep.eq([['/v', 'type']]);
    });
  });
});

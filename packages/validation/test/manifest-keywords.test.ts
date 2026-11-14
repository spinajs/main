import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import Ajv from 'ajv';

import { ManifestValidator } from '../src/manifest-source.js';
import { ValidationFailed } from '../src/exceptions/index.js';
import { manifestOf } from './manifest-of.js';

type AjvPrototype = { addKeyword(def: unknown): unknown };
const AjvConstructor = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as unknown as { prototype: AjvPrototype };

// An explicit `@Schema` class nested in a derived DTO: the compiler publishes its body, so the manifest validator
// checks it through the parent's $ref closure, with the keywords DataValidator knows.
const NESTED: Record<string, object> = {
  'app/Explicit': {
    type: 'object',
    properties: {
      min: { type: 'integer' },
      count: { type: 'integer', minimum: { $data: '1/min' } },
      level: { type: 'number', range: [1, 3] },
      code: { type: 'string', regexp: '/^a+$/' },
      items: { type: 'array', uniqueItemProperties: ['id'] },
      name: { type: 'string', transform: ['trim', 'toLowerCase'], enum: ['ab'] },
    },
    prohibited: ['admin'],
  },
  'app/Merged': { $merge: { source: { type: 'object', properties: { a: { type: 'string' } } }, with: { required: ['a'] } } },
  'app/Derived': { type: 'object', properties: { inner: { $ref: 'app/Explicit' }, merged: { $ref: 'app/Merged' } } },
  'app/Plain': { type: 'object', properties: { n: { type: 'integer' } } },
};

const fieldsOf = (fn: () => void): string[][] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationFailed) return err.parameter.map((e) => [e.instancePath, e.keyword]);
    throw err;
  }
  return [];
};

describe('ManifestValidator: the keywords DataValidator validates', function () {
  this.timeout(15000);

  for (const coerce of [false, true]) {
    describe(coerce ? 'coercing ( query, path, header, cookie )' : 'strict ( a JSON body )', () => {
      const derived = () => new ManifestValidator(manifestOf(NESTED)).validator('app/Derived', { coerce });

      it('compiles a closure holding a $data limit', () => {
        expect(derived).to.not.throw();
        expect(fieldsOf(() => derived()({ inner: { min: 5, count: 7 } }))).to.deep.eq([]);
      });

      for (const [rule, inner, field] of [
        ['a $data limit', { min: 5, count: 4 }, '/inner/count'],
        ['range', { level: 5 }, '/inner/level'],
        ['regexp', { code: 'b' }, '/inner/code'],
        ['uniqueItemProperties', { items: [{ id: 1 }, { id: 1 }] }, '/inner/items'],
        ['prohibited', { admin: true }, '/inner'],
      ] as const) {
        it(`enforces ${rule} in the nested explicit schema`, () => {
          const fields = fieldsOf(() => derived()({ inner }));
          expect(fields.map(([path]) => path), JSON.stringify(fields)).to.include(field);
        });
      }

      it('enforces a $merge-built rule', () => {
        // Ajv reports the macro's own error next to the rule it built, as DataValidator does
        expect(fieldsOf(() => derived()({ merged: {} }))).to.deep.eq([['/merged', 'required'], ['/merged', '$merge']]);
        expect(fieldsOf(() => derived()({ merged: { a: 'x' } }))).to.deep.eq([]);
      });

      it('applies transform as DataValidator does', () => {
        const data = { inner: { name: ' AB ' } };
        expect(fieldsOf(() => derived()(data))).to.deep.eq([]);
        expect(data.inner.name).to.eq('ab');
      });

      it('still fills no defaults', () => {
        const validator = new ManifestValidator(manifestOf({ 'app/Default': { type: 'object', properties: { n: { type: 'integer', default: 3 } } } })).validator('app/Default', { coerce });
        const data: { n?: number } = {};
        validator(data);
        expect(data).to.deep.eq({});
      });
    });
  }

  it('coerces only the coercing instance', () => {
    const manifest = manifestOf(NESTED);
    const query = { n: '5' };
    new ManifestValidator(manifest).validator('app/Plain', { coerce: true })(query);
    expect(query.n).to.eq(5);
    expect(fieldsOf(() => new ManifestValidator(manifest).validator('app/Plain', { coerce: false })({ n: '5' }))).to.deep.eq([['/n', 'type']]);
  });

  describe('plugin loading', () => {
    afterEach(() => sinon.restore());

    it('installs no keyword plugin until a schema that names one compiles', () => {
      const addKeyword = sinon.spy(AjvConstructor.prototype, 'addKeyword');
      const plugin = () => addKeyword.getCalls().filter((c) => ['$merge', 'transform'].includes((c.args[0] as { keyword?: string })?.keyword ?? '')).length;
      const validators = new ManifestValidator(manifestOf({ 'app/Plain': NESTED['app/Plain'] }));
      validators.validator('app/Plain', { coerce: false })({ n: 1 });
      expect(plugin()).to.eq(0);

      new ManifestValidator(manifestOf(NESTED)).validator('app/Derived', { coerce: false });
      expect(plugin()).to.eq(2);
    });
  });
});

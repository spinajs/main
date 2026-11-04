import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';

import { DataValidator } from '../src/validator.js';
import { ValidationFailed, sanitizeError } from '../src/exceptions/index.js';
import { findNonFinite, nonFiniteErrors } from '../src/keywords.js';

function validationConfig(validation: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        validation,
      };
    }
  };
}

const SHIPPED = { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false };

async function boot(validation: Record<string, unknown>) {
  const config = validationConfig(validation);
  DI.register(config).as(Configuration);
  DI.uncache(Configuration);
  DI.uncache(DataValidator);
  await DI.resolve(Configuration);
  const validator = await DI.resolve(DataValidator);
  return {
    validator,
    release: () => {
      DI.uncache(DataValidator);
      DI.uncache(Configuration);
      DI.unregister(config);
    },
  };
}

const ser = (v: unknown) => JSON.stringify(v, (_k, x: unknown): unknown => (typeof x === 'number' && !Number.isFinite(x) ? `#num:${x}` : x));
const holdsNonFinite = (x: unknown): boolean => (typeof x === 'number' && !Number.isFinite(x)) || (x !== null && typeof x === 'object' && Object.values(x).some(holdsNonFinite));
const P = (v: object) => ({ type: 'object', properties: { v } });
const bounded = { type: 'integer', minimum: 0, maximum: 10 };

// The shapes of the review's bypass.mjs, coerce-in-place.mjs and notflip.mjs.
const SCHEMAS: Record<string, object> = {
  prop: P(bounded),
  root: bounded,
  nested: P(P(bounded)),
  arrItems: P({ type: 'array', items: bounded }),
  nestedArr: P({ type: 'array', items: { type: 'array', items: bounded } }),
  tuple: P({ type: 'array', items: [bounded, { type: 'string' }], additionalItems: bounded }),
  record: P({ type: 'object', additionalProperties: bounded }),
  patternProps: P({ type: 'object', patternProperties: { '^x': bounded } }),
  numNull: P({ type: ['number', 'null'], maximum: 5 }),
  nullable: P({ type: 'integer', nullable: true, maximum: 5 }),
  intBool: P({ type: ['integer', 'boolean'], maximum: 5 }),
  anyOf: P({ anyOf: [bounded, { type: 'null' }] }),
  anyOfStr: P({ anyOf: [bounded, { type: 'string', maxLength: 3 }] }),
  oneOf: P({ oneOf: [bounded, { type: 'boolean' }] }),
  allOf: P({ allOf: [{ type: 'number' }, { maximum: 5 }] }),
  ifThen: P({ if: { type: 'integer' }, then: { maximum: 5 }, else: { type: 'null' } }),
  ifNoElse: P({ if: { type: 'integer' }, then: { maximum: 5 } }),
  outerIf: { type: 'object', if: { properties: { v: { type: 'integer' } } }, then: { properties: { v: { maximum: 5 } } } },
  noType: P({ minimum: 0, maximum: 10 }),
  unconstrained: P({}),
  merge: { $merge: { source: P(bounded), with: { required: ['v'] } } },
  patch: { $patch: { source: P({ type: 'number' }), with: [{ op: 'add', path: '/properties/v/maximum', value: 5 }] } },
  range: P({ type: 'number', range: [0, 5] }),
  int32: P({ type: 'number', format: 'int32' }),
  enumInt: P({ type: 'integer', enum: [1, 2] }),
  select: P({ type: 'object', properties: { k: { type: 'string' } }, select: { $data: '0/k' }, selectCases: { a: { properties: { n: bounded } } } }),
  ref: { $ref: 'app.WalkBounded' },
  refProp: P({ $ref: 'app.WalkBounded#/properties/v' }),
  ifIntString: P({ type: ['integer', 'string'], if: { type: 'integer' }, then: { maximum: 100 } }),
  anyOfIntEnum: P({ anyOf: [{ type: 'integer', maximum: 100 }, { type: 'string', enum: ['all'] }] }),
  oneOfIntNull: P({ oneOf: [{ type: 'integer', maximum: 100 }, { type: 'null' }] }),
  notTyped: P({ type: ['integer', 'string'], not: { type: 'integer', minimum: 101 } }),
  notInteger: P({ not: { type: 'integer' } }),
  notNumber: P({ not: { type: 'number' } }),
  notMaximum: P({ not: { maximum: 5 } }),
  notMinimum: P({ not: { minimum: 0 } }),
  notNot: P({ not: { not: { type: 'number' } } }),
  anyOfNot: P({ anyOf: [{ not: { type: 'number' } }, { type: 'string' }] }),
  discriminator: { type: 'object', properties: { k: { type: 'string' }, v: {} }, if: { properties: { k: { const: 'fixed' } } }, then: { properties: { v: { type: 'integer', minimum: 1, maximum: 100 } } } },
};

const RAWS = ['Infinity', '-Infinity', '1e400', '-1e400', ' Infinity ', '+Infinity', 'NaN', '-0'];
const shapes = (r: string): unknown[] => [
  { v: r }, r, { v: { v: r } }, { v: [r] }, { v: [[r]] }, { v: [r, 'a', r] }, { v: { x1: r } }, { v: { k: 'a', n: r } }, { k: 'fixed', v: r },
  { v: Number(r) }, Number(r), { v: [Number(r)] },
];

const OPTION_SETS = [true, 'array', false].flatMap((coerceTypes) => [true, false].map((allErrors) => ({ coerceTypes, allErrors })));

describe('no validated data holds a non-finite number', function () {
  this.timeout(120000);

  for (const options of OPTION_SETS) {
    it(`${JSON.stringify(options)}: every accepted input is finite, every refusal a plain error`, async () => {
      const { validator, release } = await boot({ ...SHIPPED, ...options });
      const leaks: string[] = [];
      try {
        validator.addSchema({ $id: 'app.WalkBounded', ...P(bounded) }, 'app.WalkBounded');
        for (const [name, schema] of Object.entries(SCHEMAS)) {
          for (const raw of RAWS) {
            for (const shape of shapes(raw)) {
              const data = structuredClone(shape);
              const [valid, errors] = validator.tryValidate(schema, data as object);
              if (valid && holdsNonFinite(data)) leaks.push(`${name} ${ser(shape)} -> ${ser(data)}`);
              for (const error of errors ?? []) {
                if (error.params?.nonFinite !== undefined) leaks.push(`marker ${name} ${ser(shape)}`);
              }
            }
          }
        }
      } finally {
        release();
      }
      expect(leaks, leaks.slice(0, 10).join('\n')).to.deep.eq([]);
    });
  }

  describe('the refusals stock made under not stay refusals', () => {
    let validator: DataValidator;
    let release: () => void;

    before(async () => {
      ({ validator, release } = await boot(SHIPPED));
    });

    after(() => release());

    for (const name of ['notInteger', 'notNumber', 'notTyped', 'notMaximum', 'notMinimum']) {
      for (const raw of ['Infinity', '-Infinity', '1e400']) {
        for (const literal of [false, true]) {
          it(`${name} refuses ${literal ? 'the literal' : 'the string'} ${raw}`, () => {
            const value = literal ? Number(raw) : raw;
            const [valid, errors] = validator.tryValidate(SCHEMAS[name], { v: value });
            expect(valid).to.eq(false);
            expect(errors!.map((e) => e.instancePath)).to.include('/v');
          });
        }
      }
    }

    it('reports the walk refusal as a type error at the path, through validate() too', () => {
      const [valid, errors] = validator.tryValidate(SCHEMAS.ifIntString, { v: '1e400' });
      expect(valid).to.eq(false);
      expect(errors).to.deep.eq([{ keyword: 'type', instancePath: '/v', schemaPath: '#', params: { type: 'finite number' }, message: 'must be a finite number' }]);
      expect(() => validator.validate(SCHEMAS.notNumber, { v: 'Infinity' })).to.throw(ValidationFailed);
    });

    it('accepts the string a branch left when no branch coerced', () => {
      const data = { v: 'Infinity' };
      expect(validator.tryValidate(SCHEMAS.anyOfStr, data)[0]).to.eq(false);
      expect(validator.tryValidate(P({ anyOf: [{ type: 'integer' }, { type: 'string' }] }), data)[0]).to.eq(true);
      expect(data.v).to.eq('Infinity');
    });
  });

  it('sanitizeError drops the nonFinite marker of a raw Ajv error', () => {
    const raw = { keyword: 'type', instancePath: '/v', schemaPath: '#/properties/v/type', params: { type: 'integer', nonFinite: true } };
    expect(sanitizeError(raw).params).to.deep.eq({ type: 'integer' });
  });

  describe('findNonFinite', () => {
    it('walks arrays and plain objects, with JSON pointers', () => {
      expect(findNonFinite({ a: [1, { 'b/c': Infinity, 'd~': NaN }], e: -Infinity }, true)).to.deep.eq(['/e', '/a/1/b~1c', '/a/1/d~0']);
      expect(findNonFinite({ a: [Infinity, Infinity] }, false)).to.deep.eq(['/a/0']);
      expect(findNonFinite(Infinity, true)).to.deep.eq(['']);
      expect(findNonFinite('Infinity', true)).to.deep.eq([]);
    });

    it('walks the root whatever its class, and only plain values below it', () => {
      class Dto {
        public n = Infinity;
        public inner = new (class Inner {
          public n = Infinity;
        })();
      }
      expect(findNonFinite(new Dto(), true)).to.deep.eq(['/n']);
    });

    it('builds the path of a hit deep below arrays and keys', () => {
      let deep: unknown = { 'a/b': [0, -Infinity] };
      for (let i = 0; i < 5000; i++) deep = i % 2 ? { k: deep } : [deep];
      const [path] = findNonFinite({ root: deep }, true);
      expect(path.startsWith('/root/k/0/k/0/'), path.slice(0, 40)).to.eq(true);
      expect(path.endsWith('/a~1b/1')).to.eq(true);
      expect(path.split('/')).to.have.length(5000 + 4);
    });

    const walkTime = (body: unknown) => {
      const started = process.hrtime.bigint();
      const found = findNonFinite(body, true);
      return { found, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };

    // The walk used to build a path string per level: about 3 s for this body. The budgets are generous on purpose.
    it('walks a 4.8 MB body of nested arrays in under 1.5 s', () => {
      const levels = 2_400_000;
      const { found, ms } = walkTime(JSON.parse('['.repeat(levels) + ']'.repeat(levels)));
      expect(found).to.deep.eq([]);
      expect(ms, `${ms.toFixed(0)} ms`).to.be.below(1500);
    });

    it('names a non-finite number at the bottom of that body in under 3 s', () => {
      const levels = 2_400_000;
      const { found, ms } = walkTime(JSON.parse('['.repeat(levels) + '1e400' + ']'.repeat(levels)));
      expect(found).to.deep.eq(['/0'.repeat(levels)]);
      expect(ms, `${ms.toFixed(0)} ms`).to.be.below(3000);
    });

    it('lists 100 of 200k non-finite numbers in one array, says so, and takes well under a second', () => {
      const body = JSON.parse(`[${'{"v":1e400},'.repeat(199_999)}{"v":1e400}]`) as unknown;
      const started = process.hrtime.bigint();
      const errors = nonFiniteErrors(body, true);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(errors).to.have.length(100);
      expect(errors[0]).to.deep.eq({ keyword: 'type', instancePath: '/0/v', schemaPath: '#', params: { type: 'finite number' }, message: 'must be a finite number' });
      expect(errors[99].instancePath).to.eq('/99/v');
      expect(errors[99].message).to.eq('must be a finite number; only the first 100 non-finite numbers are listed');
      // Looking each hit's key up in its parent made this quadratic: 200k hits took about 9 s.
      expect(ms, `${ms.toFixed(0)} ms`).to.be.below(1000);
    });

    it('lists exactly 100 non-finite numbers without the note', () => {
      const errors = nonFiniteErrors(Array.from({ length: 100 }, () => Infinity), true);
      expect(errors).to.have.length(100);
      expect(errors.every((e) => e.message === 'must be a finite number')).to.eq(true);
    });

    it('a code-built cycle beyond the delayed guard still ends', () => {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic, cyclic);
      expect(findNonFinite(cyclic, true)).to.deep.eq([]);
      cyclic.push(NaN);
      expect(findNonFinite(cyclic, false)).to.deep.eq(['/2']);
    });

    it('survives cycles and deep values', () => {
      const cyclic: Record<string, unknown> = { n: 1 };
      cyclic.self = cyclic;
      cyclic.list = [cyclic, -Infinity];
      expect(findNonFinite(cyclic, true)).to.deep.eq(['/list/1']);

      let deep: unknown = Infinity;
      for (let i = 0; i < 200000; i++) deep = i % 2 ? [deep] : { a: deep };
      expect(findNonFinite(deep, true)).to.have.length(1);
    });
  });
});

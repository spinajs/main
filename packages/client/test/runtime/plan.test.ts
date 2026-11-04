import 'mocha';
import { expect } from 'chai';
import { dateCodec, type Codec, type ConversionPlan, type ConversionPlans, type ModelEntry } from '../../src/runtime/index.js';
import { decodePlan, encodePlan, type PlanContext } from '../../src/runtime/plan.js';

const ISO = '2026-05-01T08:00:00.000Z';
const at: ConversionPlan = { kind: 'format', format: 'date-time' };

const centsCodec: Codec<number> = { decode: (wire) => Math.round(Number(wire) * 100), encode: (cents) => (cents / 100).toFixed(2) };

function context(plans: ConversionPlans = {}, models: Record<string, ModelEntry<unknown>> = {}): PlanContext {
  return { plans, formats: { 'date-time': dateCodec, decimal: centsCodec }, models };
}

describe('conversion plans', () => {
  describe('decode', () => {
    it('decodes a format node with its codec and passes null through', () => {
      const ctx = context();
      expect(decodePlan(at, ISO, ctx)).to.be.instanceOf(Date);
      expect(decodePlan(at, null, ctx)).to.equal(null);
      expect(decodePlan(at, undefined, ctx)).to.equal(undefined);
    });

    it('leaves a format without a registered codec as it is', () => {
      expect(decodePlan({ kind: 'format', format: 'date' }, '2026-05-01', context())).to.equal('2026-05-01');
    });

    it('decodes array items and record values', () => {
      const ctx = context();
      const list = decodePlan({ kind: 'array', items: at }, [ISO, ISO], ctx) as Date[];
      expect(list.map((d) => d instanceof Date)).to.deep.equal([true, true]);
      const map = decodePlan({ kind: 'record', values: at }, { a: ISO }, ctx) as Record<string, Date>;
      expect(map.a).to.be.instanceOf(Date);
    });

    it('decodes planned properties and keeps every other key of an object', () => {
      const plan: ConversionPlan = { kind: 'object', closed: true, props: { at, price: { kind: 'format', format: 'decimal' }, title: null } };
      const out = decodePlan(plan, { at: ISO, price: '12.50', title: 't', added: 1 }, context()) as Record<string, unknown>;
      expect(out.at).to.be.instanceOf(Date);
      expect(out).to.deep.include({ price: 1250, title: 't', added: 1 });
    });

    it('does not mutate the wire value', () => {
      const wire = { at: ISO };
      decodePlan({ kind: 'object', closed: true, props: { at } }, wire, context());
      expect(wire.at).to.equal(ISO);
    });

    it('decodes a ref through its plan, then through the registered model', () => {
      const plans: ConversionPlans = { Article: { kind: 'object', closed: true, props: { at } } };
      const seen: unknown[] = [];
      const models = { Article: { decode: (value: Record<string, unknown>) => (seen.push(value), { wrapped: value }) } };
      const out = decodePlan({ kind: 'ref', name: 'Article' }, { at: ISO }, context(plans, models)) as { wrapped: { at: Date } };
      expect(out.wrapped.at).to.be.instanceOf(Date);
      expect(seen).to.have.length(1);
    });

    it('hands a model only the declared keys of a closed plan', () => {
      const plans: ConversionPlans = { User: { kind: 'object', closed: true, props: { id: null, at } } };
      const seen: Record<string, unknown>[] = [];
      const models = { User: { decode: (value: Record<string, unknown>) => (seen.push(value), value) } };
      decodePlan({ kind: 'ref', name: 'User' }, { id: 1, at: ISO, label: 'forged', toString: 's' }, context(plans, models));
      expect(Object.keys(seen[0])).to.deep.equal(['id', 'at']);
    });

    it('does not hand a model a declared key the reply lacks, even one Object.prototype has', () => {
      const plans: ConversionPlans = { Q: { kind: 'object', closed: true, props: { id: null, toString: null } } };
      const seen: Record<string, unknown>[] = [];
      const models = { Q: { decode: (value: Record<string, unknown>) => (seen.push(value), value) } };
      decodePlan({ kind: 'ref', name: 'Q' }, { id: 1 }, context(plans, models));
      expect(Object.prototype.hasOwnProperty.call(seen[0], 'toString')).to.equal(false);
    });

    it('hands a model every own key of an open plan', () => {
      const plans: ConversionPlans = { Bag: { kind: 'object', closed: false, props: { at } } };
      const seen: Record<string, unknown>[] = [];
      const models = { Bag: { decode: (value: Record<string, unknown>) => (seen.push(value), value) } };
      decodePlan({ kind: 'ref', name: 'Bag' }, { at: ISO, extra: 1 }, context(plans, models));
      expect(Object.keys(seen[0])).to.deep.equal(['at', 'extra']);
    });

    it('selects a member by a numeric discriminator tag', () => {
      const plans: ConversionPlans = { Circle: { kind: 'object', closed: true, props: { kind: null, born: at } }, Square: { kind: 'object', closed: true, props: { kind: null, born: null } } };
      const union: ConversionPlan = { kind: 'union', discriminator: { property: 'kind', mapping: { '1': 'Circle', '2': 'Square' } }, members: [{ kind: 'ref', name: 'Circle' }, { kind: 'ref', name: 'Square' }] };
      const models = { Circle: { decode: (value: Record<string, unknown>) => ({ circle: value }) } };
      const out = decodePlan(union, { kind: 1, born: ISO }, context(plans, models)) as { circle: { born: unknown } };
      expect(out.circle.born).to.be.instanceOf(Date);
    });

    it('converts nothing for a union with a member that needs no conversion', () => {
      const union: ConversionPlan = { kind: 'union', members: [at, null] };
      expect(decodePlan(union, 123, context())).to.equal(123);
      expect(decodePlan(union, ISO, context())).to.equal(ISO);
    });

    it('passes null through a ref without calling the model', () => {
      const models = { Article: { decode: () => expect.fail('decode must not run for null') } };
      expect(decodePlan({ kind: 'ref', name: 'Article' }, null, context({}, models))).to.equal(null);
    });

    it('follows a plan cycle through ref as deep as the data goes', () => {
      const plans: ConversionPlans = { Node: { kind: 'object', closed: true, props: { at, children: { kind: 'array', items: { kind: 'ref', name: 'Node' } } } } };
      const wire = { at: ISO, children: [{ at: ISO, children: [{ at: ISO, children: [] }] }] };
      const out = decodePlan({ kind: 'ref', name: 'Node' }, wire, context(plans)) as { children: { children: { at: Date }[] }[] };
      expect(out.children[0].children[0].at).to.be.instanceOf(Date);
    });

    it('picks the member of a discriminated union by its mapping', () => {
      const plans: ConversionPlans = {
        Cat: { kind: 'object', closed: true, props: { kind: null, born: at } },
        Dog: { kind: 'object', closed: true, props: { kind: null, born: null } },
      };
      const union: ConversionPlan = {
        kind: 'union',
        discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
        members: [
          { kind: 'ref', name: 'Cat' },
          { kind: 'ref', name: 'Dog' },
        ],
      };
      const ctx = context(plans);
      expect((decodePlan(union, { kind: 'cat', born: ISO }, ctx) as { born: unknown }).born).to.be.instanceOf(Date);
      expect((decodePlan(union, { kind: 'dog', born: ISO }, ctx) as { born: unknown }).born).to.equal(ISO);
    });

    it('falls back to member agreement for an unmapped tag, never to a name on the prototype', () => {
      const union: ConversionPlan = { kind: 'union', discriminator: { property: 'kind', mapping: {} }, members: [{ kind: 'object', closed: true, props: { at } }] };
      const out = decodePlan(union, { kind: 'constructor', at: ISO }, context()) as Record<string, unknown>;
      expect(out.at).to.be.instanceOf(Date);
    });

    it('converts a non-discriminated union only where every member agrees', () => {
      const plans: ConversionPlans = {
        A: { kind: 'object', closed: true, props: { created: at, due: at, a: null } },
        B: { kind: 'object', closed: true, props: { created: at, due: null, b: null } },
      };
      const union: ConversionPlan = {
        kind: 'union',
        members: [
          { kind: 'ref', name: 'A' },
          { kind: 'ref', name: 'B' },
        ],
      };
      const out = decodePlan(union, { created: ISO, due: ISO }, context(plans)) as Record<string, unknown>;
      expect(out.created).to.be.instanceOf(Date);
      expect(out.due).to.equal(ISO);
    });

    it('converts nothing when union members disagree on the value itself', () => {
      const union: ConversionPlan = { kind: 'union', members: [at, { kind: 'format', format: 'decimal' }] };
      expect(decodePlan(union, ISO, context())).to.equal(ISO);
    });

    it('converts a union whose members are the same plan', () => {
      expect(decodePlan({ kind: 'union', members: [at, at] }, ISO, context())).to.be.instanceOf(Date);
    });

    it('agrees through nested arrays of different refs', () => {
      const plans: ConversionPlans = {
        A: { kind: 'object', closed: true, props: { at, list: { kind: 'array', items: { kind: 'ref', name: 'A' } } } },
        B: { kind: 'object', closed: true, props: { at, list: { kind: 'array', items: { kind: 'ref', name: 'B' } } } },
      };
      const union: ConversionPlan = {
        kind: 'union',
        members: [
          { kind: 'ref', name: 'A' },
          { kind: 'ref', name: 'B' },
        ],
      };
      const out = decodePlan(union, { at: ISO, list: [{ at: ISO, list: [] }] }, context(plans)) as { list: { at: unknown }[] };
      expect(out.list[0].at).to.be.instanceOf(Date);
    });

    it('keeps a JSON "__proto__" key as an own property and leaves the prototype alone', () => {
      const wire = JSON.parse(`{"__proto__":{"polluted":true},"at":"${ISO}"}`) as unknown;
      const out = decodePlan({ kind: 'object', closed: false, props: { at } }, wire, context()) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).to.equal(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).to.equal(true);
      expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
    });

    it('does not read a property plan from the prototype of props', () => {
      const out = decodePlan({ kind: 'object', closed: false, props: {} }, { constructor: 'x', toString: 'y' }, context());
      expect(out).to.deep.equal({ constructor: 'x', toString: 'y' });
    });
  });

  describe('encode', () => {
    it('encodes a format node with its codec', () => {
      expect(encodePlan(at, new Date(ISO), context())).to.equal(ISO);
      expect(encodePlan({ kind: 'format', format: 'decimal' }, 1250, context())).to.equal('12.50');
    });

    it('projects a closed object onto its declared properties', () => {
      class Article {
        cache = { hits: 3 };
        constructor(
          public title: string,
          public at: Date,
        ) {}
        get isFresh(): boolean {
          return true;
        }
      }
      const plan: ConversionPlan = { kind: 'object', closed: true, props: { title: null, at, isFresh: null } };
      const out = encodePlan(plan, new Article('t', new Date(ISO)), context());
      expect(out).to.deep.equal({ title: 't', at: ISO, isFresh: true });
    });

    it('omits declared properties the value does not hold', () => {
      expect(encodePlan({ kind: 'object', closed: true, props: { a: null, b: null } }, { a: 1 }, context())).to.deep.equal({ a: 1 });
    });

    it('keeps every own key of an open object', () => {
      expect(encodePlan({ kind: 'object', closed: false, props: { at } }, { at: new Date(ISO), extra: 1 }, context())).to.deep.equal({ at: ISO, extra: 1 });
    });

    it('keeps a declared getter of an open object', () => {
      class Article {
        title = 't';
        get slug(): string {
          return 'slug-t';
        }
      }
      expect(encodePlan({ kind: 'object', closed: false, props: { title: null, slug: null } }, new Article(), context())).to.deep.equal({ title: 't', slug: 'slug-t' });
    });

    it('projects the member a numeric discriminator tag picks', () => {
      const plans: ConversionPlans = { Circle: { kind: 'object', closed: true, props: { kind: null, born: at } }, Square: { kind: 'object', closed: true, props: { kind: null, born: null } } };
      const union: ConversionPlan = { kind: 'union', discriminator: { property: 'kind', mapping: { '1': 'Circle', '2': 'Square' } }, members: [{ kind: 'ref', name: 'Circle' }, { kind: 'ref', name: 'Square' }] };
      expect(encodePlan(union, { kind: 1, born: new Date(ISO), cache: 1 }, context(plans))).to.deep.equal({ kind: 1, born: ISO });
    });

    it('projects a nested closed object inside an array and a record', () => {
      const inner: ConversionPlan = { kind: 'object', closed: true, props: { id: null } };
      expect(encodePlan({ kind: 'array', items: inner }, [{ id: 1, junk: 2 }], context())).to.deep.equal([{ id: 1 }]);
      expect(encodePlan({ kind: 'record', values: inner }, { k: { id: 1, junk: 2 } }, context())).to.deep.equal({ k: { id: 1 } });
    });

    it("prefers the model's encode, then toJSON, and walks the result", () => {
      const plans: ConversionPlans = { Article: { kind: 'object', closed: true, props: { at, title: null } } };
      const withBoth = { toJSON: () => ({ title: 'from toJSON' }), title: 'raw' };
      const models = { Article: { decode: (v: Record<string, unknown>) => v, encode: () => ({ title: 'from encode', at: new Date(ISO), junk: 1 }) } };
      expect(encodePlan({ kind: 'ref', name: 'Article' }, withBoth, context(plans, models))).to.deep.equal({ title: 'from encode', at: ISO });
      expect(encodePlan({ kind: 'ref', name: 'Article' }, withBoth, context(plans))).to.deep.equal({ title: 'from toJSON' });
    });

    it('encodes the member a discriminator picks', () => {
      const plans: ConversionPlans = { Cat: { kind: 'object', closed: true, props: { kind: null, born: at } } };
      const union: ConversionPlan = { kind: 'union', discriminator: { property: 'kind', mapping: { cat: 'Cat' } }, members: [{ kind: 'ref', name: 'Cat' }] };
      expect(encodePlan(union, { kind: 'cat', born: new Date(ISO), purrs: true }, context(plans))).to.deep.equal({ kind: 'cat', born: ISO });
    });

    it('does not project a non-discriminated union onto the keys its members share', () => {
      const plans: ConversionPlans = {
        A: { kind: 'object', closed: true, props: { at, a: null } },
        B: { kind: 'object', closed: true, props: { at, b: null } },
      };
      const union: ConversionPlan = {
        kind: 'union',
        members: [
          { kind: 'ref', name: 'A' },
          { kind: 'ref', name: 'B' },
        ],
      };
      expect(encodePlan(union, { at: new Date(ISO), a: 1 }, context(plans))).to.deep.equal({ at: ISO, a: 1 });
    });

    it('leaves values without a plan to JSON.stringify', () => {
      const date = new Date(ISO);
      expect(encodePlan(null, date, context())).to.equal(date);
    });
  });
});

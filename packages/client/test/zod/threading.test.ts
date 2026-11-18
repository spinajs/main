import 'mocha';
import { expect } from 'chai';
import { appBasicManifest } from '../support/fixture.js';
import { buildClientModel, emitZod } from '../../src/index.js';
import { parity, parityManifest, serverRefusal, serverVerdict, show, subjectOf } from '../support/parity.js';
import { clearLoaded } from '../support/zod.js';

const A = { $ref: 'test/FuzzA' };
const B = { $ref: 'test/FuzzB' };
const M1 = { type: 'object', properties: { a: { type: 'null' }, b: { type: 'number' }, n: B }, additionalProperties: { type: 'string' } };
const inner = { if: A, then: { not: { type: 'object' } }, else: { type: 'null', anyOf: [{ type: 'integer' }, { type: 'string' }] } };

// Shapes the seeded schema fuzz found: each was zod-stricter than the server, or made safeParse throw.
const CASES: Record<string, { schema: unknown; inputs: unknown[] }> = {
  allOfAfterOneOf: {
    schema: {
      allOf: [
        { oneOf: [{ type: 'array', items: [{ type: 'array' }, { type: 'null' }] }, A] },
        { if: { not: { type: 'string' } }, then: { oneOf: [{ type: 'boolean' }, { type: 'boolean' }] }, else: { not: A } },
      ],
    },
    inputs: ['Infinity', 'x', '5', null, ['Infinity'], [['x']], true],
  },
  allOfIfAndObject: {
    schema: {
      type: 'object',
      properties: {
        v: {
          allOf: [
            { if: { type: 'object', additionalProperties: { type: 'string' }, patternProperties: { '^[ab]': { type: 'string', minLength: 1 } }, dependencies: { a: { type: 'boolean' } } }, then: { type: 'object', properties: { a: { type: 'boolean' }, n: { type: 'number', minimum: 0 } }, additionalProperties: B } },
            { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } }, n: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', minProperties: 2 }] } } },
          ],
        },
      },
    },
    inputs: [{ v: { b: { a: 'x', b: false }, n: '1e400' } }, { v: { n: 'Infinity' } }, { v: { a: ['1'], n: 'x' } }, { v: {} }, { v: 'x' }],
  },
  ifAsTestOfIf: {
    schema: { type: 'object', properties: { v: { if: { if: A, else: { type: 'null', anyOf: [{ type: 'integer' }, { type: 'string' }] } }, then: { type: 'array' } } } },
    inputs: ['Infinity', '5', 'x', null].map((v) => ({ v })),
  },
  ifOfIfThenAnyOf: {
    schema: { type: 'object', properties: { v: { if: inner, then: { anyOf: [B, { type: 'array' }] } } } },
    inputs: ['Infinity', '5', 'x', null].map((v) => ({ v })),
  },
  additionalItemsOfAPrunedTuple: {
    schema: { not: { type: 'array', items: [{ type: 'object' }], additionalItems: { type: 'integer' } } },
    inputs: [[{ a: 'null' }, null, 'Infinity'], [{}], [{}, '5'], 'x', [{}, 'x']],
  },
  containsInANot: {
    schema: { not: { type: 'array', items: { oneOf: [B, { type: 'object' }] }, contains: { type: 'object', properties: { n: B }, minProperties: 2 } } },
    inputs: [[{ n: '1e400' }], [{ n: '1e400', m: 1 }], [{ n: '5' }], [{}], 'x'],
  },
  objectChangedBeforeTheNextStage: {
    schema: { not: { type: 'object', properties: { a: { if: B, then: { type: 'boolean' } } }, patternProperties: { '^[ab]': { anyOf: [{ type: 'integer' }, { type: 'array' }] } } } },
    inputs: [{ a: '0', b: '1e400' }, { a: '0' }, { a: 0, b: '1e400' }, { b: '1e400' }],
  },
  // Readers of what an allOf coerced: contains and uniqueItems read the items, patternProperties the property.
  allOfItemsRead: {
    schema: { type: 'array', items: { allOf: [{ minimum: 1 }, { type: 'number' }] }, contains: { const: 5 } },
    inputs: [['5'], ['5', '5'], '5', ['4'], ['0'], [], ['x'], [5]],
  },
  allOfPropertyRead: {
    schema: { type: 'object', properties: { a: { allOf: [{ minimum: 1 }, { type: 'number' }] } }, patternProperties: { '^a$': { const: 5 } } },
    inputs: [{ a: '5' }, { a: 5 }, { a: '4' }, { a: '0' }, {}],
  },
  allOfUnique: {
    schema: { type: 'array', items: { allOf: [{ minimum: 1 }, { type: 'number' }] }, uniqueItems: true },
    inputs: [['5', 5], ['1', 1], ['1', '2'], ['5', '5'], [5, 6], []],
  },
  // The test of an if holds a oneOf whose second member is an allOf: the first member's coercion reaches it.
  ifOfOneOfElse: {
    schema: { if: { oneOf: [M1, { allOf: [{ type: 'object' }, { type: 'object' }] }] }, else: { type: 'null' } },
    inputs: [{ a: 'x', n: 'Infinity' }, { a: 'x', n: '1e400' }, { a: 'x' }, { n: 'Infinity' }, { a: null, n: '5' }, null],
  },
  ifOfOneOfThen: {
    schema: { if: { oneOf: [M1, { allOf: [{ type: 'object' }, { type: 'object' }] }] }, then: { type: 'null' } },
    inputs: [{ a: 'x', n: 'Infinity' }, { a: 'x', n: '1e400' }, { a: 'x' }, { n: 'Infinity' }, { a: null, n: '5' }, null],
  },
  ifOfAnyOfThen: {
    schema: { if: { anyOf: [M1, { allOf: [{ type: 'object' }, { type: 'object' }] }] }, then: { type: 'null' } },
    inputs: [{ a: 'x', n: 'Infinity' }, { a: 'x' }, { n: '5' }, null],
  },
  // uniqueItems runs after items and contains, and skips items that are not of the declared primitive type.
  uniqueAfterItems: {
    schema: { if: { type: 'array', items: { type: 'number' }, uniqueItems: true }, then: { type: 'array' } },
    inputs: [['Infinity', false, false], ['Infinity', 'Infinity'], [false, false], ['5', 5], ['x', 'x'], []],
  },
  uniqueInANot: {
    schema: { not: { type: 'array', items: { type: 'number' }, uniqueItems: true } },
    inputs: [['Infinity', false, false], ['Infinity', 'Infinity'], [false, false], ['5', 5], ['5', '5']],
  },
  uniqueOfIfItems: {
    schema: { if: { type: 'object', properties: { b: { type: 'integer' } }, additionalProperties: { type: 'array', items: { if: { type: 'number', minimum: 0 }, then: B, else: A }, uniqueItems: true } }, then: { type: 'array' } },
    inputs: [{ a: ['Infinity', false, false], b: '1e400' }, { a: ['Infinity', false, false] }, { a: ['5', 5] }, { a: ['1'] }],
  },
  // A numeric type on a non-finite value an earlier member left ends the node in a not.
  numericAfterInfinity: {
    schema: { not: { allOf: [{ type: 'number' }, { type: 'integer', minimum: 0 }] } },
    inputs: ['Infinity', '1e400', '5', '-1', 'x', null],
  },
  // In a not, a contains over no items passes when items is a tuple.
  containsOfATuple: {
    schema: { not: { type: 'array', items: [{ type: 'string' }], contains: { type: 'integer' } } },
    inputs: [[], ['x'], ['5'], [1], ['x', '5'], 'x'],
  },
  // A union inside a not is replayed in short mode too: its first branch stops at the items that fail, before contains.
  unionInANot: {
    schema: { not: { anyOf: [{ type: 'array', items: { type: 'number', minimum: 1 }, contains: { type: 'null' } }, { allOf: [B, { type: 'string', minLength: 1 }] }] } },
    inputs: [0, [0], '0', ['0'], 5, [5], '', null, [[0]]],
  },
  unionInANotOfAString: {
    schema: { not: { anyOf: [{ type: 'array', items: { type: 'number', minimum: 1 }, contains: { type: 'null' } }, { allOf: [A, { type: 'string', minLength: 1 }] }] } },
    inputs: [0, [0], '0', '', null, 5],
  },
  // contains reads the items as their union left them: a oneOf member coerces an item its sibling accepted.
  containsOfUnionItems: {
    schema: { type: 'array', items: { anyOf: [{ type: 'array', items: { if: { type: 'number', minimum: 0 }, then: { type: 'object' }, else: { type: 'string', minLength: 1 } } }, { type: 'array', items: { oneOf: [A, { type: 'array', maxItems: 3 }] } }] }, contains: { type: 'number' } },
    inputs: [[false, ['x']], [false], [['x']], [[false]], [0], [[0]], [false, ['x', '1e400']], []],
  },
  // contains reads what the items keywords left in the array as sent, not what zod parsed it to.
  containsOfNestedUnions: {
    schema: { type: 'array', items: { anyOf: [{ type: 'array', items: { allOf: [{ minimum: 1 }, { type: 'number' }] } }, { type: 'array', items: { type: 'array', items: { type: 'string' } } }] }, contains: { type: 'number' } },
    inputs: [[[0]], [['0']], [[0, 1]], [['x']], [[]], [0], ['5']],
  },
  // Ajv hands a contains the verdict of the item or key before it: an empty array passes unless it comes first in the loop.
  containsLoopItems: { schema: { type: 'array', items: { type: 'array', contains: { type: 'number' } } }, inputs: [[[1], []], [[], [1]], [[]], [], [[1], [], []], [[1], ['x']], [['1'], []], [[1], [[]]]] },
  containsLoopItemsInANot: { schema: { not: { type: 'array', items: { type: 'array', contains: { type: 'number' } } } }, inputs: [[[1], []], [[], [1]], [[]], [], [[1], [], []], [[1], ['x']], [['1'], []], [[1], [[]]]] },
  containsLoopRest: { schema: { type: 'array', items: [{ type: 'null' }], additionalItems: { type: 'array', contains: { type: 'number' } } }, inputs: [[null, [1], []], [null, [], [1]], [null, []], [null], [[1], []]] },
  containsLoopKeys: { schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'array', contains: { type: 'number' } } }, inputs: [{ b: [1], n: [] }, { n: [], b: [1] }, { n: [] }, {}, { a: [], b: [1] }, { b: [1], n: [], m: [] }, { a: 'x', b: [1], n: [] }] },
  containsLoopKeysInAnIf: { schema: { if: { type: 'object', properties: { a: { type: 'array' } }, additionalProperties: { type: 'array', contains: { type: 'number' } } }, then: { $ref: 'test/FuzzB' } }, inputs: [{ b: [1], n: [] }, { n: [], b: [1] }, { n: [] }, {}, { a: [], b: [1] }, { b: [1], n: [], m: [] }, { a: 'x', b: [1], n: [] }] },
  containsLoopPattern: { schema: { type: 'object', patternProperties: { '^[bn]$': { type: 'array', contains: { type: 'number' } } } }, inputs: [{ b: [1], n: [] }, { n: [], b: [1] }, { n: [] }, {}, { a: [], b: [1] }, { b: [1], n: [], m: [] }, { a: 'x', b: [1], n: [] }] },
  allOfOfObjectsWithChecks: {
    schema: {
      allOf: [
        { allOf: [{ type: 'object', properties: { b: { type: 'array' } }, required: ['a'] }, { type: 'object', properties: { a: { type: 'array', minItems: 2 }, n: { type: 'string' } }, dependencies: { a: { type: 'null' } } }] },
        { allOf: [{ anyOf: [{ type: 'null' }, { type: 'null' }] }, { not: { type: 'string' } }] },
      ],
    },
    inputs: [{ a: ['', 'x'], b: null }, { a: '', b: 'true', n: 0 }, { b: 1.5, n: 'true' }, { a: ['x', 'y'], b: ['z'] }, {}],
  },
};

describe('emitZod: coerced allOf members, an if inside an if, and objects with checks', function () {
  this.timeout(60000);

  after(clearLoaded);

  for (const mini of [false, true]) {
    for (const [name, row] of Object.entries(CASES)) {
      it(`${name} answers as the server (${mini ? 'mini' : 'classic'})`, async () => {
        const manifest = parityManifest(await appBasicManifest(), { FuzzA: { type: 'number' }, FuzzB: { type: 'number', anyOf: [A] }, [name]: row.schema });
        const result = await parity(manifest, `test/${name}`, { coerce: true, variant: 'coerced', mini }, row.inputs);
        expect(result.errors, 'zod threw').to.deep.equal([]);
        expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
        expect(result.zodLooser.map((d) => show(d.input)), 'zod is looser').to.deep.equal([]);
      });
    }
  }

  describe('the depth the replay follows', () => {
    // v: not: not: ... : { type: number }, `levels` deep.
    const chain = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => ({ not: inner }), { type: 'number' });

    const codes = async (levels: number): Promise<string[]> => {
      const manifest = parityManifest(await appBasicManifest(), { Deep: { type: 'object', properties: { v: chain(levels) } } });
      return emitZod(buildClientModel(manifest), {}).diagnostics.filter((d) => d.schema === 'test/Deep').map((d) => `${d.code} ${d.pointer.split('/').length - 1}`);
    };

    it('reports ZOD005 only for a schema that reaches the limit, at the node it stopped at', async () => {
      expect(await codes(10)).to.deep.equal([]);
      expect(await codes(30)).to.deep.equal([]);
      const deep = await codes(60);
      expect(deep.length).to.equal(1);
      expect(deep[0]).to.match(/^ZOD005 \d+$/);
    });

    it('says that the node and what reads it accept more than the server', async () => {
      const manifest = parityManifest(await appBasicManifest(), { Deep: { type: 'object', properties: { v: chain(60) } } });
      const [report] = emitZod(buildClientModel(manifest), {}).diagnostics.filter((d) => d.schema === 'test/Deep' && d.code === 'ZOD005');
      expect(report.message).to.match(/accept more than the server does/);
    });

    it('answers as the server below the limit', async () => {
      const manifest = parityManifest(await appBasicManifest(), { Deep: { type: 'object', properties: { v: chain(25) } } });
      const result = await parity(manifest, 'test/Deep', { coerce: true, variant: 'coerced' }, ['Infinity', '5', 'x', null].map((v) => ({ v })));
      expect(result.errors).to.deep.equal([]);
      expect(result.zodStricter).to.deep.equal([]);
      expect(result.zodLooser).to.deep.equal([]);
    });
  });

  describe('propertyNames that coerce', () => {
    it('reports the schema the server throws on', async () => {
      const manifest = parityManifest(await appBasicManifest(), { Names: { type: 'object', properties: { v: { type: 'object', propertyNames: { type: 'number' } } } } });
      const diagnostics = emitZod(buildClientModel(manifest), {}).diagnostics.filter((d) => d.schema === 'test/Names');
      expect(diagnostics.map((d) => `${d.code} ${d.pointer}`)).to.deep.equal(['ZOD001 /properties/v/propertyNames']);
      const subject = await subjectOf(manifest);
      expect(() => serverVerdict(subject, 'test/Names', { coerce: true }, { v: { 5: 1 } })).to.throw('Assignment to constant variable');
      expect(serverVerdict(subject, 'test/Names', { coerce: true }, { v: { a: 1 } })).to.equal(false);
      expect(serverRefusal(subject, 'test/Names', { coerce: false })).to.equal(undefined);
    });
  });

  describe('a declaration that reaches itself', () => {
    const self = { $ref: 'test/Rec' };
    const viaIf = { if: self, then: { type: 'integer' }, else: { type: 'number' } };
    const inputs = [[], ['5'], ['5', 5], [[]], [['1'], '2'], 'x', null, { k: '5' }, { k: { k: 'Infinity' } }, ['Infinity'], [1.5], 1.5, ['1.5', 2], [[1.5]], { k: 1.5 }, { k: {} }, { k: [] }, [['x']], [true], [{}]];

    // A replay that would build itself again through the reference stops there: ZOD005, the reader is left unchecked.
    const cut: Record<string, { schema: object; pointers: string[] }> = {
      itemsIf: { schema: { type: 'array', items: viaIf }, pointers: ['/items/if', '/items/if/$ref'] },
      itemsIfUnique: { schema: { type: 'array', items: viaIf, uniqueItems: true }, pointers: ['/items/if', '/items/if/$ref', '/uniqueItems'] },
      itemsIfContains: { schema: { type: 'array', items: viaIf, contains: { type: 'integer' } }, pointers: ['/contains', '/items/if', '/items/if/$ref'] },
      notAndKids: { schema: { type: 'object', properties: { v: { type: 'number' }, next: { not: self }, kids: { type: 'array', items: self, contains: { required: ['v'] } } } }, pointers: ['/properties/kids/contains', '/properties/kids/items', '/properties/kids/items/$ref', '/properties/next/not', '/properties/next/not/$ref'] },
      propertyIf: { schema: { type: 'object', properties: { k: { if: self, then: { type: 'object' }, else: { type: 'number' } } } }, pointers: ['/properties/k/if', '/properties/k/if/$ref'] },
    };
    // Reaching itself where no replay has to follow it changes nothing: exact, and silent.
    const exact: Record<string, object> = {
      itemsNot: { type: 'array', items: { not: self }, contains: { type: 'integer' } },
      itemsAnyOf: { type: 'array', items: { anyOf: [self, { type: 'number' }] }, uniqueItems: true },
      itemsAllOf: { type: 'array', items: { allOf: [self, { type: 'number' }] }, contains: { type: 'integer' } },
      propertyNot: { type: 'object', properties: { k: { not: self }, n: { type: 'number' } }, patternProperties: { '^k$': { type: 'number' } } },
      thenIsSelf: { type: 'array', items: { if: { type: 'number' }, then: self, else: { type: 'number' } }, contains: { type: 'integer' } },
    };

    for (const mini of [false, true]) {
      const flavor = mini ? 'mini' : 'classic';
      for (const [name, row] of Object.entries(cut)) {
        it(`${name} is emitted, reported by ZOD005 at the if, and never stricter (${flavor})`, async () => {
          const manifest = parityManifest(await appBasicManifest(), { Rec: row.schema });
          const diagnostics = emitZod(buildClientModel(manifest), { mini }).diagnostics.filter((d) => d.schema === 'test/Rec');
          expect(diagnostics.map((d) => `${d.code} ${d.pointer}`).sort()).to.deep.equal(row.pointers.map((pointer) => `ZOD005 ${pointer}`).sort());
          const result = await parity(manifest, 'test/Rec', { coerce: true, variant: 'coerced', mini }, inputs);
          expect(result.errors, 'zod threw').to.deep.equal([]);
          expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
        });
      }
      for (const [name, schema] of Object.entries(exact)) {
        it(`${name} answers as the server with no diagnostic (${flavor})`, async () => {
          const manifest = parityManifest(await appBasicManifest(), { Rec: schema });
          expect(emitZod(buildClientModel(manifest), { mini }).diagnostics.filter((d) => d.schema === 'test/Rec')).to.deep.equal([]);
          const result = await parity(manifest, 'test/Rec', { coerce: true, variant: 'coerced', mini }, inputs);
          expect(result.errors, 'zod threw').to.deep.equal([]);
          expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
          expect(result.zodLooser.map((d) => show(d.input)), 'zod is looser').to.deep.equal([]);
        });
      }
      it(`a replay cut inside the test of an if leaves the if unchecked, not its test passed (${flavor})`, async () => {
        const schema = { type: 'object', properties: { b: { if: { allOf: [self, { $ref: 'test/FuzzA' }] }, then: { if: { type: 'number' }, then: { type: 'array' }, else: { type: 'object' } }, else: { anyOf: [{ type: 'array' }, { $ref: 'test/FuzzA' }] } } } };
        const manifest = parityManifest(await appBasicManifest(), { FuzzA: { type: 'number' }, Rec: schema });
        const result = await parity(manifest, 'test/Rec', { coerce: true, variant: 'coerced', mini }, [{ b: '-Infinity' }, { b: 'Infinity' }, { b: '5' }, { b: { b: '1e400' } }, { b: {} }, { b: [] }, {}, 'x']);
        expect(result.errors, 'zod threw').to.deep.equal([]);
        expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
      });
    }
  });

  describe('contains behind a reference or a combinator in a looped schema', () => {
    const C = { type: 'array', contains: { type: 'number' } };
    // How the item schema reaches the contains. A reference to a schema with no reference in it is inlined by Ajv and shares
    // the loop's variable; one with a reference in it is a function of its own and does not.
    const paths: Record<string, object> = {
      inlinedRef: { $ref: 'test/CRef' },
      compiledRef: { $ref: 'test/CWrap' },
      allOf: { allOf: [{ type: 'array' }, C] },
      anyOf: { anyOf: [{ type: 'null' }, C] },
      oneOf: { oneOf: [C, { type: 'string' }] },
      not: { not: C },
      ifTest: { if: C, then: { type: 'array' }, else: { type: 'null' } },
      thenBranch: { if: { type: 'array' }, then: C },
      elseBranch: { if: { type: 'null' }, else: C },
      refInAllOf: { allOf: [{ $ref: 'test/CRef' }] },
      notNot: { not: { not: C } },
      notNotNot: { not: { not: { not: C } } },
      notAnyOf: { not: { anyOf: [C] } },
      anyOfNot: { anyOf: [{ not: C }, { type: 'string' }] },
      notInlinedRef: { not: { $ref: 'test/CRef' } },
    };
    const arrays = [[[1], []], [[], [1]], [[]], [], [[1], [], []], [[1], ['x']], [[1], [], [1], []], [['x'], []], [[], ['x']], [['x'], [], ['x']], [['x']]];
    const objects = [{ b: [1], n: [] }, { n: [], b: [1] }, { n: [] }, {}, { b: [1], n: [], m: [] }, { b: [1], n: ['x'] }, { a: 'x', b: [1], n: [] }, { b: ['x'], n: [] }, { n: [], b: ['x'] }];
    const loops: Record<string, (item: object) => { schema: object; inputs: unknown[] }> = {
      items: (item) => ({ schema: { type: 'array', items: item }, inputs: arrays }),
      itemsInANot: (item) => ({ schema: { not: { type: 'array', items: item } }, inputs: arrays }),
      rest: (item) => ({ schema: { type: 'array', items: [{ type: 'null' }], additionalItems: item }, inputs: [[null, [1], []], [null, [], [1]], [null, []], [null]] }),
      keys: (item) => ({ schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: item }, inputs: objects }),
      pattern: (item) => ({ schema: { type: 'object', patternProperties: { '^[bn]$': item } }, inputs: objects }),
    };

    // A union member or a branch keeps the verdict of its own earlier evaluation, which a check of the loop cannot see: ZOD005,
    // and the node accepts any value (never stricter, also inside a not or an if).
    const cut = new Set(['anyOf', 'oneOf', 'ifTest', 'thenBranch', 'elseBranch', 'notAnyOf', 'anyOfNot']);

    // A cut member accepts more than it should, which breaks the exactly-one of a oneOf and the negation of a not.
    const cutMember = { type: 'array', items: { oneOf: [{ type: 'array', contains: { type: 'number' } }, { type: 'string' }] } };
    const around: Record<string, object> = {
      oneOfMember: { oneOf: [cutMember, { type: 'array', items: { type: 'null' } }] },
      containsOfUnionItems: { type: 'array', items: { anyOf: [{ type: 'array', items: { if: { type: 'number', minimum: 0 }, then: { type: 'object' }, else: { type: 'string', minLength: 1 } } }, { type: 'array', items: { oneOf: [{ $ref: 'test/FuzzA' }, { type: 'array', contains: { const: 5 } }] } }] }, contains: { type: 'number' } },
      oneOfRefMember: { oneOf: [{ $ref: 'test/CutDecl' }, { type: 'array', items: { type: 'null' } }] },
      notOfCut: { not: cutMember },
      ifOfCut: { if: cutMember, then: { maxItems: 1 }, else: { type: 'null' } },
    };
    // Seed 75 of the fuzz: the first member of the oneOf is cut, and the second holds for the same value.
    around.oneOfSeed75 = {
      oneOf: [
        { type: 'array', items: { oneOf: [{ type: 'array', items: { allOf: [{ minimum: 1 }, { type: 'number' }] }, uniqueItems: true, contains: { type: 'number' } }, { oneOf: [{ type: 'string' }, { type: 'object', minProperties: 2 }] }] }, contains: { type: 'object', properties: { a: { allOf: [{ $ref: 'test/FuzzB' }, { type: 'string' }] } }, dependencies: { a: { $ref: 'test/FuzzB' } } } },
        { if: { type: 'array', items: { if: { type: 'array' }, then: { type: 'null' }, else: { type: 'object' } }, uniqueItems: true }, then: { anyOf: [{ type: 'array' }, { type: 'null' }] } },
      ],
    };
    const arraysAround = [['-Infinity', { b: 'Infinity' }, 5], ['-Infinity'], [{ b: 'Infinity' }], [5], [{ b: '5' }], [], [null], [[1]], [['x']], ['x'], [[]], [[1], []], [['x'], []], [null, null], 'x', null];

    for (const mini of [false, true]) {
      for (const [name, schema] of Object.entries(around)) {
        it(`${name} is never stricter than the server, and says ZOD005 (${mini ? 'mini' : 'classic'})`, async () => {
          const manifest = parityManifest(await appBasicManifest(), { FuzzA: { type: 'number' }, FuzzB: { type: 'number', anyOf: [{ $ref: 'test/FuzzA' }] }, CutDecl: cutMember, Around: schema });
          const codes = emitZod(buildClientModel(manifest), { mini }).diagnostics.filter((d) => d.schema === 'test/Around' || d.schema === 'test/CutDecl').map((d) => d.code);
          expect(codes, 'diagnostics').to.include('ZOD005');
          const result = await parity(manifest, 'test/Around', { coerce: true, variant: 'coerced', mini }, arraysAround);
          expect(result.errors, 'zod threw').to.deep.equal([]);
          expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
        });
      }
    }

    for (const mini of [false, true]) {
      for (const [path, item] of Object.entries(paths)) {
        for (const [loop, make] of Object.entries(loops)) {
          it(`${loop} over ${path} answers as the server (${mini ? 'mini' : 'classic'})`, async () => {
            const row = make(item);
            const manifest = parityManifest(await appBasicManifest(), { CRef: C, CWrap: { allOf: [{ $ref: 'test/CRef' }] }, Loop: row.schema });
            const codes = emitZod(buildClientModel(manifest), { mini }).diagnostics.filter((d) => d.schema === 'test/Loop').map((d) => d.code);
            const result = await parity(manifest, 'test/Loop', { coerce: true, variant: 'coerced', mini }, row.inputs);
            expect(result.errors, 'zod threw').to.deep.equal([]);
            expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
            if (cut.has(path)) expect(codes, 'diagnostics').to.include('ZOD005');
            else {
              expect(codes, 'diagnostics').to.deep.equal([]);
              expect(result.zodLooser.map((d) => show(d.input)), 'zod is looser').to.deep.equal([]);
            }
          });
        }
      }
    }
  });

  describe('a declaration that accepts more than the server, read by another', () => {
    // anyOf over a chain of 60 nots: the replay of its coercions stops at the depth limit, so its coerced schema accepts any value.
    const chain = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => ({ not: inner }), { type: 'integer' });
    const deep = { anyOf: [chain(60), { type: 'null' }] };
    // CycA holds a union with a contains in a loop (not modelled, so cut) and reaches CycB, which reaches CycA again.
    const union = { oneOf: [{ type: 'array', contains: { type: 'number' } }, { type: 'string' }] };
    const cyc = { CycA: { type: 'object', properties: { next: { $ref: 'test/CycB' } }, additionalProperties: union }, CycB: { type: 'object', properties: { back: { $ref: 'test/CycA' } } } };
    const readers = (target: object): Record<string, object> => ({
      oneOfMember: { oneOf: [target, { type: 'number' }] },
      notOf: { not: target },
      ifTest: { if: target, then: { type: 'null' } },
      notOfAllOf: { not: { allOf: [target, {}] } },
    });
    const numbers = [1.5, 1, 0.5, '1.5', '1', null, 'x', 0, '', true, [], {}, [1], ['x']];
    const objects = [{}, { back: {} }, { back: { x: [1] } }, { back: { x: ['x'] } }, { back: { x: [] } }, { back: { x: 's' } }, { back: { x: [null] } }, { back: { x: [1], y: [] } }, { back: null }, { back: { back: { x: ['x'] } } }, null];
    const rows: [string, Record<string, object>, object, unknown[]][] = [
      ['depth cap', { Deep: deep }, readers({ $ref: 'test/Deep' }), numbers],
      ['a cycle', cyc, readers({ $ref: 'test/CycB' }), objects],
    ];

    for (const mini of [false, true]) {
      for (const [label, declared, around, inputs] of rows) {
        for (const [name, schema] of Object.entries(around)) {
          it(`${name} of a declaration cut by ${label} is never stricter and says ZOD005 (${mini ? 'mini' : 'classic'})`, async () => {
            const manifest = parityManifest(await appBasicManifest(), { ...declared, Reader: schema });
            const diagnostics = emitZod(buildClientModel(manifest), { mini }).diagnostics.filter((d) => d.schema === 'test/Reader');
            expect(diagnostics.map((d) => d.code), 'diagnostics of the reader').to.include('ZOD005');
            const result = await parity(manifest, 'test/Reader', { coerce: true, variant: 'coerced', mini }, inputs);
            expect(result.errors, 'zod threw').to.deep.equal([]);
            expect(result.zodStricter.map((d) => show(d.input)), 'zod is stricter').to.deep.equal([]);
          });
        }
      }
    }
  });
});
